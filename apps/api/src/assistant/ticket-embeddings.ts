import { createHash } from "node:crypto";
import type { TenantClient } from "@treepm/db";
import { ticketEmbeddingText } from "@treepm/domain";
import type { IdeaStage, TicketStatus } from "@treepm/domain";
import { MAX_TREE_DEPTH } from "../tickets/ticket-scope.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { liveTickets } from "./branch-tree.js";
import { EMBEDDING_DIMENSIONS, EmbeddingError } from "./ports.js";
import type { EmbeddingFailure, EmbeddingProvider } from "./ports.js";

/**
 * Um vetor por ticket para a busca por significado (ADR 0053, fatia 1). Nada aqui é chamado por rota: é a base que a busca de
 * relacionados (fatia 2) e a ferramenta local usam. Duas regras valem em tudo:
 *   - a chamada ao provedor NUNCA acontece com transação do banco aberta (ADR 0045): lê em uma transação curta, chama, grava
 *     em outra; e
 *   - falha do provedor nunca vira exceção: `syncEmbeddings` devolve um código e a busca segue só com palavras.
 * Nenhum texto de ticket, vetor, chave ou resposta do provedor é registrado em log ou devolvido ao chamador.
 */

/** Máximo de tickets postos em dia por chamada e prazo total da chamada (ADR 0053, item 5). */
export const EMBEDDING_SYNC_MAX = 256;
export const EMBEDDING_SYNC_DEADLINE_MS = 4000;
/** Textos por chamada ao provedor: cada lote é gravado antes do seguinte, então uma falha no meio não perde os lotes anteriores. */
export const EMBEDDING_SYNC_BATCH = 128;

/** O que se lê de um ticket vivo para o vetor: só o título e a descrição, e o id para ligar o vetor de volta. */
export type EmbeddableTicket = { id: string; title: string; description: string };

/** Quem executa transações curtas com o contexto da organização; o `orgId` vem de dentro, do contexto já aplicado. */
export interface EmbeddingStore {
  run<T>(fn: (tx: TenantClient, orgId: string) => Promise<T>): Promise<T>;
}

/** Adapta o executor de transações das rotas (`@OwnTransactions`) ao que este módulo precisa. */
export const embeddingStoreOf = (runner: TenantRunner): EmbeddingStore => ({ run: (fn) => runner.run((tx, principal) => fn(tx, principal.organization.orgId)) });

/** O resumo criptográfico estável do texto final de um ticket: sha256 em hexadecimal. Só título e descrição o movem. */
export function ticketEmbeddingHash(ticket: EmbeddableTicket | { title: string; description: string }): string {
  return createHash("sha256").update(ticketEmbeddingText(ticket), "utf8").digest("hex");
}

/** O vetor como o texto que o PostgreSQL lê em `::vector`. Só números finitos. */
const vectorLiteral = (vector: readonly number[]): string => `[${vector.join(",")}]`;

/** Lê os tickets vivos do projeto com título e descrição (até 8 000 caracteres): os mesmos que a procura enxerga (`liveTickets`). */
export async function loadEmbeddableTickets(tx: TenantClient, projectId: string): Promise<EmbeddableTicket[]> {
  const all = await tx.$queryRaw<{ id: string; parentId: string | null; title: string; description: string; status: string; ideaStage: string | null }[]>`
    select id, parent_id as "parentId", title, left(description, 8000) as description, status, idea_stage as "ideaStage"
    from tickets where project_id = ${projectId}::uuid order by number`;
  return liveTickets(all.map((t) => ({ ...t, status: t.status as TicketStatus, ideaStage: (t.ideaStage ?? null) as IdeaStage | null }))).map(({ id, title, description }) => ({ id, title, description }));
}

type Stored = { model: string; dimensions: number; hash: string };

async function loadStored(tx: TenantClient, projectId: string): Promise<Map<string, Stored>> {
  const rows = await tx.$queryRaw<{ id: string; model: string; dimensions: number; hash: string }[]>`
    select ticket_id as id, model, dimensions, content_hash as hash from ticket_embeddings where project_id = ${projectId}::uuid`;
  return new Map(rows.map((row) => [row.id, { model: row.model, dimensions: row.dimensions, hash: row.hash }]));
}

/** Os que faltam ou mudaram: sem linha, resumo diferente, ou linha de outro modelo ou outra dimensão. Na ordem recebida. */
function outdated(tickets: readonly EmbeddableTicket[], stored: ReadonlyMap<string, Stored>, model: string): { ticket: EmbeddableTicket; hash: string }[] {
  const result: { ticket: EmbeddableTicket; hash: string }[] = [];
  for (const ticket of tickets) {
    const hash = ticketEmbeddingHash(ticket);
    const row = stored.get(ticket.id);
    if (row === undefined || row.hash !== hash || row.model !== model || row.dimensions !== EMBEDDING_DIMENSIONS) result.push({ ticket, hash });
  }
  return result;
}

export type EmbeddingStatus = { live: number; upToDate: number; outdated: number; missing: number };

/** Quantos tickets vivos estão em dia, desatualizados (há linha, mas o texto ou o modelo mudou) e sem vetor. Só números. */
export async function embeddingStatus(tx: TenantClient, projectId: string, model: string): Promise<EmbeddingStatus> {
  const tickets = await loadEmbeddableTickets(tx, projectId);
  const stored = await loadStored(tx, projectId);
  const stale = outdated(tickets, stored, model);
  const missing = stale.filter((item) => !stored.has(item.ticket.id)).length;
  return { live: tickets.length, upToDate: tickets.length - stale.length, outdated: stale.length - missing, missing };
}

/** O que uma reindexação enviaria agora: quantos textos e quantos caracteres. Só números; não chama provedor nenhum. */
export async function embeddingPlan(tx: TenantClient, projectId: string, model: string): Promise<{ texts: number; chars: number }> {
  const tickets = await loadEmbeddableTickets(tx, projectId);
  const stale = outdated(tickets, await loadStored(tx, projectId), model);
  return { texts: stale.length, chars: stale.reduce((sum, item) => sum + Array.from(ticketEmbeddingText(item.ticket)).length, 0) };
}

export type EmbeddingSyncResult = {
  /** Tickets vivos que já estavam em dia ao começar. */
  upToDate: number;
  /** Vetores gravados nesta chamada. */
  embedded: number;
  /** Tickets que continuam sem vetor em dia (teto, prazo ou falha). */
  pending: number;
  ms: number;
  /** Só quando algo falhou: o motivo, em código curto. `storage` é falha do banco; os demais, do provedor. */
  failure?: EmbeddingFailure | "storage";
};

export type EmbeddingSyncOptions = {
  projectId: string;
  /** Os tickets vivos do projeto (de `loadEmbeddableTickets`). Ideia descartada e ticket cancelado não entram. */
  tickets: readonly EmbeddableTicket[];
  provider: EmbeddingProvider;
  /** Só os testes trocam. */
  max?: number;
  deadlineMs?: number;
  batchSize?: number;
};

/**
 * Põe em dia o vetor dos tickets que faltam ou mudaram, até `EMBEDDING_SYNC_MAX` por chamada e dentro de
 * `EMBEDDING_SYNC_DEADLINE_MS`. À porta só chega `ticketEmbeddingText` de cada ticket. Nunca lança por falha do provedor (nem
 * do banco): devolve só números e, se algo falhou, um código.
 *
 * Para a fatia 2 (quem chamar): o resumo guardado depende de QUANTO da descrição foi lida. Passe em `tickets` os de
 * `loadEmbeddableTickets` (título e até 8 000 caracteres da descrição), nunca os de `loadPlacementTree` (descrição cortada em
 * 601 caracteres: o resumo não bateria e tudo seria reenviado a cada busca). Confira também, antes de chamar, que a pessoa tem
 * acesso ao projeto (`projectId`): esta função grava vetores de um projeto inteiro e não confere permissão nenhuma.
 *
 * Um lote que o provedor recusa por `bad_request` ou `timeout` é dividido ao meio e cada metade é tentada; um texto sozinho que
 * falha é pulado (fica em `pending`, o código vai em `failure`) e os seguintes seguem, enquanto houver prazo. Os demais códigos
 * (`unauthorized`, `rate_limited`, `server_error`, `network`, `malformed`) param na hora: insistir não adianta.
 */
export async function syncEmbeddings(store: EmbeddingStore, options: EmbeddingSyncOptions): Promise<EmbeddingSyncResult> {
  const started = performance.now();
  const max = options.max ?? EMBEDDING_SYNC_MAX;
  const deadlineMs = options.deadlineMs ?? EMBEDDING_SYNC_DEADLINE_MS;
  const batchSize = options.batchSize ?? EMBEDDING_SYNC_BATCH;
  const result: EmbeddingSyncResult = { upToDate: 0, embedded: 0, pending: 0, ms: 0 };
  const finish = (): EmbeddingSyncResult => ({ ...result, ms: Math.round(performance.now() - started) });
  type Item = { ticket: EmbeddableTicket; hash: string };
  let stale: Item[];
  try {
    // Transação curta só de leitura; o provedor é chamado depois de ela fechar.
    const stored = await store.run((tx) => loadStored(tx, options.projectId));
    stale = outdated(options.tickets, stored, options.provider.model);
  } catch {
    return { ...result, pending: options.tickets.length, failure: "storage", ms: Math.round(performance.now() - started) };
  }
  result.upToDate = options.tickets.length - stale.length;
  result.pending = stale.length;
  const signal = AbortSignal.timeout(deadlineMs);
  /** Um código que para tudo (não adianta insistir) ou, no texto sozinho, um que só pula aquele texto. */
  class Stop extends Error {}
  const note = (code: NonNullable<EmbeddingSyncResult["failure"]>): void => {
    result.failure ??= code;
  };

  const attempt = async (batch: Item[]): Promise<void> => {
    if (signal.aborted) {
      note("timeout");
      throw new Stop();
    }
    let vectors: number[][];
    try {
      vectors = await options.provider.embed(
        batch.map((item) => ticketEmbeddingText(item.ticket)),
        "document",
        { signal },
      );
      if (!Array.isArray(vectors) || vectors.length !== batch.length || !vectors.every((v) => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS && v.every(Number.isFinite))) throw new EmbeddingError("malformed");
    } catch (error) {
      const code = error instanceof EmbeddingError ? error.code : "malformed";
      note(code);
      if ((code === "bad_request" || code === "timeout") && !signal.aborted) {
        if (batch.length === 1) {
          // O texto sozinho que falha é pulado: continua pendente e os seguintes seguem.
          return;
        }
        const half = Math.ceil(batch.length / 2);
        await attempt(batch.slice(0, half));
        await attempt(batch.slice(half));
        return;
      }
      throw new Stop();
    }
    try {
      const written = await store.run((tx, orgId) => saveEmbeddings(tx, orgId, options.projectId, options.provider.model, batch.map((item, i) => ({ id: item.ticket.id, hash: item.hash, vector: vectors[i] as number[] }))));
      result.embedded += written;
      // Ticket apagado ou movido no meio não foi gravado, mas também não está mais pendente.
      result.pending -= batch.length;
    } catch {
      note("storage");
      throw new Stop();
    }
  };

  const work = stale.slice(0, max);
  try {
    for (let start = 0; start < work.length; start += batchSize) await attempt(work.slice(start, start + batchSize));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return finish();
}

/**
 * Grava (substituindo) os vetores de um lote numa transação curta. A junção com `tickets` descarta o ticket apagado ou movido de
 * projeto entre a leitura e a gravação, em vez de falhar o lote inteiro.
 */
async function saveEmbeddings(tx: TenantClient, orgId: string, projectId: string, model: string, rows: readonly { id: string; hash: string; vector: readonly number[] }[]): Promise<number> {
  if (rows.length === 0) return 0;
  return tx.$executeRaw`
    insert into ticket_embeddings (org_id, ticket_id, project_id, model, dimensions, content_hash, embedding, updated_at)
    select ${orgId}, t.id, t.project_id, ${model}, ${EMBEDDING_DIMENSIONS}::int, v.hash, v.vec::vector, now()
    from unnest(${rows.map((row) => row.id)}::uuid[], ${rows.map((row) => row.hash)}::text[], ${rows.map((row) => vectorLiteral(row.vector))}::text[]) as v(id, hash, vec)
    join tickets t on t.org_id = ${orgId} and t.id = v.id and t.project_id = ${projectId}::uuid
    on conflict (org_id, ticket_id) do update
      set model = excluded.model, dimensions = excluded.dimensions, content_hash = excluded.content_hash, embedding = excluded.embedding, updated_at = excluded.updated_at`;
}

export type NearestTicket = { ticketId: string; distance: number };

/**
 * Os `k` tickets vivos do projeto mais próximos de `vector`, por distância do cosseno, exata (sem índice aproximado), em ordem
 * crescente. Só linhas do modelo e da dimensão atuais; ticket cancelado (ou dentro de cancelado) e ideia ficam de fora (a mesma
 * definição de `liveTickets`, numa consulta recursiva). Roda sob RLS: outra organização nunca aparece.
 */
export async function nearestTickets(tx: TenantClient, options: { orgId: string; projectId: string; model: string; vector: readonly number[]; k: number }): Promise<NearestTicket[]> {
  if (options.k <= 0) return [];
  if (options.vector.length !== EMBEDDING_DIMENSIONS || !options.vector.every(Number.isFinite)) throw new RangeError("Vetor de consulta inválido.");
  const rows = await tx.$queryRaw<{ ticketId: string; distance: number }[]>`
    with recursive live as (
      select org_id, project_id, id, 1 as depth from tickets
      where org_id = ${options.orgId} and project_id = ${options.projectId}::uuid and parent_id is null and status <> 'cancelled' and idea_stage is null
      union all
      select t.org_id, t.project_id, t.id, live.depth + 1 from tickets t
      join live on t.org_id = live.org_id and t.project_id = live.project_id and t.parent_id = live.id
      where t.org_id = ${options.orgId} and t.project_id = ${options.projectId}::uuid and live.depth < ${MAX_TREE_DEPTH}::int and t.status <> 'cancelled' and t.idea_stage is null
    )
    select e.ticket_id as "ticketId", (e.embedding <=> ${vectorLiteral(options.vector)}::vector)::float8 as distance
    from ticket_embeddings e join live on live.id = e.ticket_id and live.org_id = e.org_id
    where e.org_id = ${options.orgId} and e.project_id = ${options.projectId}::uuid and e.model = ${options.model} and e.dimensions = ${EMBEDDING_DIMENSIONS}::int
    order by distance, e.ticket_id
    limit ${options.k}::int`;
  return rows;
}

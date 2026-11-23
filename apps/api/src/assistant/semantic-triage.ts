import { ticketEmbeddingText } from "@treepm/domain";
import { EMBEDDING_DIMENSIONS, EmbeddingError } from "./ports.js";
import type { EmbeddingFailure, EmbeddingKind, EmbeddingProvider } from "./ports.js";
import { EMBEDDING_SYNC_DEADLINE_MS, loadEmbeddableTickets, nearestTickets, syncEmbeddings } from "./ticket-embeddings.js";
import type { EmbeddingStore, NearestTicket } from "./ticket-embeddings.js";

/**
 * Os vizinhos por vetor de um ou mais textos de consulta (ADR 0053, itens 5 e 7), para a triagem de relacionados da conversa
 * e das tarefas sugeridas. Em ordem: (a) põe os vetores do projeto em dia, sobre `loadEmbeddableTickets` (nunca sobre a árvore
 * da procura, que corta a descrição em 601 caracteres e faria o resumo nunca bater); (b) UMA chamada `embed(consultas, "query")`;
 * (c) `nearestTickets` de cada consulta. Tudo dentro de um prazo total e do sinal de fora.
 *
 * Regras que valem aqui:
 *   - o provedor nunca é chamado com transação do banco aberta (cada leitura e gravação é uma transação curta do `store`);
 *   - NUNCA lança: sem `embedder`, falha do provedor, prazo ou falha do banco devolvem listas vazias e um código, e a busca
 *     segue só com palavras;
 *   - sem `embedder` nada é lido do banco; o chamador já passou pela conferência do aceite e pelo acesso ao projeto (esta
 *     função não confere permissão: grava vetores de um projeto inteiro);
 *   - só devolve ids, distâncias e números; nenhum texto, título, vetor ou chave sai daqui nem vai a registro.
 */

/** Prazo total do passo de vetor (sincronização + consulta), em milissegundos. */
export const SEMANTIC_TRIAGE_DEADLINE_MS = 5000;

/**
 * Distância do cosseno acima da qual um vizinho não entra na triagem. O padrão `1` só tira o que é oposto ao texto; o valor será
 * ajustado pela medição (`triage-measure --max-distance`), que imprime as distâncias dos esperados e do 10º e do 30º vizinho.
 */
export const SEMANTIC_MAX_DISTANCE = 1;
/** Tempo que a consulta sempre tem: a sincronização usa no máximo (prazo do passo − isto) e é pulada se sobrar menos. */
export const SEMANTIC_QUERY_RESERVE_MS = 1500;

export type SemanticFailure = EmbeddingFailure | "storage" | "no_embedder" | "skipped_no_time" | "disabled";

/** Como as duas rotas usam os vetores (`SEMANTIC_TRIAGE` e `SEMANTIC_QUERY_KIND`, ADR 0053). `off` não lê, não sincroniza e não chama o provedor. */
export type SemanticSettings = { mode: "off" | "rrf" | "interleave"; queryKind: EmbeddingKind };

/** O que o passo de vetor fez, só números e um código. `synced` = tickets com vetor em dia depois da sincronização. */
export type SemanticDiagnostics = { synced: number; embedded: number; pending: number; syncMs: number; queryMs: number; failure?: SemanticFailure };

export type SemanticQuery = { title: string; description: string };
export type SemanticOptions = {
  store: EmbeddingStore;
  /** `null` = sem chave ou sem aceite: nada é lido nem chamado. */
  embedder: EmbeddingProvider | null;
  projectId: string;
  queries: readonly SemanticQuery[];
  /** Vizinhos por consulta. */
  k: number;
  /** O sinal da requisição de fora; vale junto com o prazo. */
  signal?: AbortSignal | undefined;
  /** O tipo da consulta ao provedor (`query` por padrão). */
  queryKind?: EmbeddingKind;
  /** Só os testes trocam. */
  deadlineMs?: number;
  syncDeadlineMs?: number;
  /** Só entra vizinho com distância até este valor (`SEMANTIC_MAX_DISTANCE` por padrão). */
  maxDistance?: number;
};
export type SemanticResult = {
  /** Uma lista por consulta, na ordem recebida, em ordem crescente de distância. Vazia quando algo falhou. */
  neighbours: NearestTicket[][];
  diagnostics: SemanticDiagnostics;
};

/** Falha de sincronização em que insistir (consultar) não adianta: a mesma causa derrubaria a consulta. */
const HARD: ReadonlySet<string> = new Set<SemanticFailure>(["unauthorized", "rate_limited", "server_error", "network", "malformed", "storage"]);

/** Resolve com a promessa ou rejeita com `timeout` quando o sinal dispara; a promessa perdedora não deixa rejeição solta. */
function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new EmbeddingError("timeout"));
    const onAbort = (): void => reject(new EmbeddingError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("falha"));
      },
    );
  });
}

export async function semanticNeighbours(options: SemanticOptions): Promise<SemanticResult> {
  const diagnostics: SemanticDiagnostics = { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0 };
  const empty = options.queries.map((): NearestTicket[] => []);
  const deadlineMs = Math.floor(options.deadlineMs ?? SEMANTIC_TRIAGE_DEADLINE_MS);
  if (options.embedder === null || options.queries.length === 0 || deadlineMs <= 0 || options.signal?.aborted) return neighboursInner(options, diagnostics);
  // O passo inteiro (leituras, sincronização, consulta) corre contra o prazo: banco lento não o estende. O trabalho que ficou para
  // trás termina sozinho (`withinSignal` já deixa a promessa perdedora sem rejeição solta).
  const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(deadlineMs), options.signal]) : AbortSignal.timeout(deadlineMs);
  try {
    return await withinSignal(neighboursInner(options, diagnostics), signal);
  } catch {
    return { neighbours: empty, diagnostics: { ...diagnostics, failure: "timeout" } };
  }
}

async function neighboursInner(options: SemanticOptions, diagnostics: SemanticDiagnostics): Promise<SemanticResult> {
  const empty = options.queries.map((): NearestTicket[] => []);
  const done = (failure?: SemanticFailure): SemanticResult => ({ neighbours: empty, diagnostics: failure === undefined ? diagnostics : { ...diagnostics, failure } });
  const embedder = options.embedder;
  if (embedder === null) return done("no_embedder");
  if (options.queries.length === 0) return done();

  const started = performance.now();
  const deadlineMs = Math.floor(options.deadlineMs ?? SEMANTIC_TRIAGE_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(Math.max(0, deadlineMs)), options.signal]) : AbortSignal.timeout(Math.max(0, deadlineMs));
  const left = (): number => deadlineMs - (performance.now() - started);
  if (deadlineMs <= 0 || options.signal?.aborted) return done(deadlineMs <= 0 ? "skipped_no_time" : "timeout");

  // (a) Põe em dia. Falha parcial da sincronização (teto, prazo da sincronização) não impede a consulta com o que há.
  let syncFailure: SemanticFailure | undefined;
  // A sincronização fica com no máximo (prazo − reserva da consulta); sobrando menos que isso, só a consulta roda.
  const syncBudget = Math.floor(Math.min(options.syncDeadlineMs ?? EMBEDDING_SYNC_DEADLINE_MS, left() - SEMANTIC_QUERY_RESERVE_MS));
  try {
    const tickets = await withinSignal(options.store.run((tx) => loadEmbeddableTickets(tx, options.projectId)), signal);
    const sync =
      syncBudget <= 0
        ? { upToDate: tickets.length, embedded: 0, pending: 0, ms: 0 }
        : await syncEmbeddings(options.store, { projectId: options.projectId, tickets, provider: embedder, deadlineMs: syncBudget, signal });
    diagnostics.synced = syncBudget <= 0 ? 0 : sync.upToDate + sync.embedded;
    diagnostics.embedded = sync.embedded;
    diagnostics.pending = sync.pending;
    diagnostics.syncMs = Math.round(performance.now() - started);
    syncFailure = "failure" in sync ? sync.failure : undefined;
    if (tickets.length === 0) return done();
  } catch (error) {
    diagnostics.syncMs = Math.round(performance.now() - started);
    return done(error instanceof EmbeddingError ? error.code : "storage");
  }
  if (syncFailure !== undefined && HARD.has(syncFailure)) return done(syncFailure);
  if (signal.aborted || left() <= 0) return done(syncFailure ?? (options.signal?.aborted ? "timeout" : "skipped_no_time"));

  // (b) e (c): UMA chamada de consulta para todas as consultas e uma transação curta com as buscas.
  const queryStarted = performance.now();
  try {
    const vectors = await withinSignal(embedder.embed(options.queries.map(ticketEmbeddingText), options.queryKind ?? "query", { signal }), signal);
    if (!Array.isArray(vectors) || vectors.length !== options.queries.length || !vectors.every((v) => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS && v.every(Number.isFinite))) throw new EmbeddingError("malformed");
    const neighbours = await withinSignal(
      options.store.run(async (tx, orgId) => {
        const lists: NearestTicket[][] = [];
        for (const vector of vectors) lists.push(await nearestTickets(tx, { orgId, projectId: options.projectId, model: embedder.model, vector, k: options.k }));
        return lists;
      }),
      signal,
    );
    diagnostics.queryMs = Math.round(performance.now() - queryStarted);
    const within = options.maxDistance ?? SEMANTIC_MAX_DISTANCE;
    return { neighbours: neighbours.map((list) => list.filter((n) => n.distance <= within)), diagnostics: syncFailure === undefined ? diagnostics : { ...diagnostics, failure: syncFailure } };
  } catch (error) {
    diagnostics.queryMs = Math.round(performance.now() - queryStarted);
    return done(error instanceof EmbeddingError ? error.code : "storage");
  }
}

/**
 * A busca por vetor como o serviço de procura a recebe: uma função de consultas e `k`, já ligada ao projeto, ao armazém e ao
 * provedor. O serviço não sabe de banco nem de provedor; os testes trocam por um falso.
 */
export type SemanticSearch = (queries: readonly SemanticQuery[], k: number, options: { signal?: AbortSignal | undefined; deadlineMs?: number | undefined }) => Promise<SemanticResult>;

/** O diagnóstico de `SEMANTIC_TRIAGE=off`: nada foi lido nem chamado. */
export const SEMANTIC_DISABLED: SemanticDiagnostics = { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "disabled" };

/**
 * Liga `semanticNeighbours` ao projeto da conversa. `embedder` é `null` quando não há chave ou o aceite não vale. Com
 * `settings.mode === "off"` a busca devolve listas vazias e o código `disabled` sem tocar no armazém nem no provedor.
 */
export const semanticSearchOf =
  (store: EmbeddingStore, embedder: EmbeddingProvider | null, projectId: string, settings: SemanticSettings): SemanticSearch =>
  (queries, k, options) =>
    settings.mode === "off"
      ? Promise.resolve({ neighbours: queries.map((): NearestTicket[] => []), diagnostics: SEMANTIC_DISABLED })
      : semanticNeighbours({ store, embedder, projectId, queries, k, queryKind: settings.queryKind, signal: options.signal, ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) });

/** O diagnóstico de quando a fonte lança (nunca deveria): só o código `storage`. */
export const SEMANTIC_ERROR: SemanticDiagnostics = { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "storage" };

/**
 * Chama a busca por vetor contra o prazo e NUNCA lança nem trava: fonte que não responde a tempo vira listas vazias com
 * `timeout`; fonte que lança, `storage`. Quem chama segue só com palavras.
 */
export async function boundedSearch(search: SemanticSearch, queries: readonly SemanticQuery[], k: number, options: { signal?: AbortSignal | undefined; deadlineMs: number }): Promise<SemanticResult> {
  const failed = (failure: SemanticFailure): SemanticResult => ({ neighbours: queries.map((): NearestTicket[] => []), diagnostics: { ...SEMANTIC_ERROR, failure } });
  const signal = options.signal ? AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.floor(options.deadlineMs))), options.signal]) : AbortSignal.timeout(Math.max(1, Math.floor(options.deadlineMs)));
  try {
    return await withinSignal(search(queries, k, { signal, deadlineMs: options.deadlineMs }), signal);
  } catch (error) {
    return failed(error instanceof EmbeddingError ? "timeout" : "storage");
  }
}

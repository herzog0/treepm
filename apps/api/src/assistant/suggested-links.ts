/**
 * Tarefa sugerida que já existe vira ligação (ADR 0052, item 4; R6). Depois que o Claude devolve as tarefas que o pedido implica,
 * cada uma é procurada na árvore viva do projeto: triagem por palavras (a mesma de `related.ts`, com o título e a descrição da
 * sugerida no lugar do rascunho, até `SUGGESTED_CANDIDATES` candidatos) e UMA segunda chamada ao Claude que decide, por sugerida,
 * se algum candidato dela já entrega o que ela precisa. Com `semantic` (ADR 0053, item 7) os candidatos de cada sugerida são a
 * FUSÃO (até `SUGGESTED_CANDIDATES`) da triagem por palavras com os `SUGGESTED_CANDIDATES` vizinhos por vetor do título e da
 * descrição dela, todas as sugeridas numa única consulta; as exclusões (duplicado, lugar escolhido e ancestrais) valem para as
 * duas listas porque os vizinhos só são aceitos se estão na árvore já filtrada. O servidor só aceita chave que esteja entre os candidatos DAQUELA
 * sugerida. Nada aqui lê banco: quem chama entrega a árvore que a rota já leu. Falha, prazo ou sinal abortado devolvem as
 * sugeridas como vieram.
 */
import { descriptionExcerpt, fuseBy, triageRelated } from "@treepm/domain";
import type { FusionRule } from "@treepm/domain";
import { oneLine } from "./elaboration.js";
import { ELABORATION_MAX_LINKS } from "./prompts.js";
import { boundedSearch, SEMANTIC_TRIAGE_DEADLINE_MS } from "./semantic-triage.js";
import type { SemanticDiagnostics, SemanticSearch } from "./semantic-triage.js";
import type { ElaborationLink, ElaborationSuggestion, ExistingMatchCandidate, ExistingMatcher, ExistingMatchTask } from "./ports.js";

/** Quantos candidatos a triagem entrega ao Claude por sugerida. */
export const SUGGESTED_CANDIDATES = 10;
/** Teto de sugeridas por procura (o servidor aceita no máximo `ELABORATION_MAX_SUGGESTED`, que é 5). */
export const SUGGESTED_LOOKUP_MAX = 5;
/** Teto do prazo da segunda chamada, em milissegundos; ela usa o que sobrou do prazo da elaboração. */
export const SUGGESTED_LOOKUP_TIMEOUT_MAX_MS = 8_000;

export type LookupTicket = { id: string; number: number; title: string; description: string; status: string };

export type LinkLookupInput = {
  /** As ligações já aceitas (depois do descarte do servidor) e as sugeridas que sobraram dele. */
  links: readonly ElaborationLink[];
  suggested: readonly ElaborationSuggestion[];
  /** A árvore viva do projeto (sem ideias nem cancelados) que a rota já leu. */
  tree: readonly LookupTicket[];
  projectKey: string;
  /** O relacionado apontado como o mesmo pedido: nenhuma ligação vai a ele. */
  duplicateKey: string | null;
  /** Ids que não concorrem: o lugar escolhido e os ancestrais dele (um ticket não depende do próprio pai nem de um ancestral). */
  excludeIds?: ReadonlySet<string> | undefined;
  matcher: ExistingMatcher;
  signal?: AbortSignal | undefined;
  /** A busca por vetor, ligada ao projeto; ausente = só palavras, como antes. Nunca lança e nunca falha a procura. */
  semantic?: SemanticSearch | undefined;
  /** Prazo do passo de vetor (a rota o limita ao que sobra do prazo da procura). */
  semanticDeadlineMs?: number | undefined;
  /** A regra de fusão (`rrf` por padrão; `interleave` por `SEMANTIC_TRIAGE`). */
  fusion?: FusionRule | undefined;
};

/** O que aconteceu com uma sugerida na procura (só códigos e números). */
export type LookupOutcome = "converted" | "kept" | "dropped_duplicate" | "dropped_repeated_link" | "dropped_limit" | "lookup_failed" | "skipped_no_time";
export type LookupDiagnostic = {
  outcome: LookupOutcome;
  /** Quantos candidatos a triagem entregou ao Claude. */
  candidates: number;
  /** O Claude apontou um candidato válido. */
  chosen: boolean;
  /** De onde vieram os candidatos (só com o passo de vetor ligado): palavras, vetor ou as duas listas. */
  origins?: { words: number; vector: number; both: number };
};

export type LinkLookupResult = {
  links: ElaborationLink[];
  suggested: ElaborationSuggestion[];
  /** Título dos tickets que ganharam ligação nesta etapa, por chave. */
  titles: Map<string, string>;
  /** Quantas sugeridas ficaram sem resposta (a chamada falhou ou foi interrompida: elas voltam como vieram). */
  failed: number;
  /** Um desfecho por sugerida de entrada, na mesma ordem. */
  lookups: LookupDiagnostic[];
  /** Quanto durou a segunda chamada ao Claude (0 sem chamada). */
  matchMs: number;
  /** O que o passo de vetor fez (só números e um código); ausente quando não foi ligado. */
  semantic?: SemanticDiagnostics;
};

export async function linkExistingSuggestions(input: LinkLookupInput): Promise<LinkLookupResult> {
  const keyOf = (ticket: LookupTicket): string => `${input.projectKey}-${ticket.number}`;
  // O duplicado e o lugar escolhido (com os ancestrais) nem concorrem: fora da triagem, não vão ao Claude e não podem ser alvo.
  const tree = input.tree.filter((ticket) => keyOf(ticket) !== input.duplicateKey && !input.excludeIds?.has(ticket.id));
  const byKey = new Map(tree.map((ticket) => [keyOf(ticket), ticket]));
  const tasks = input.suggested.slice(0, SUGGESTED_LOOKUP_MAX);

  // O passo de vetor: UMA consulta para todas as sugeridas. Nunca lança; sem tempo ou com falha, só palavras.
  let vectorByTask: string[][] = tasks.map(() => []);
  let semantic: SemanticDiagnostics | undefined;
  if (input.semantic && tasks.length > 0) {
    if (input.signal?.aborted) {
      semantic = { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "skipped_no_time" };
    } else {
      // k + excluídos: sobram `SUGGESTED_CANDIDATES` depois de tirar duplicado, lugar escolhido e ancestrais.
      const excluded = (input.excludeIds?.size ?? 0) + (input.duplicateKey === null ? 0 : 1);
      const result = await boundedSearch(
        input.semantic,
        tasks.map((task) => ({ title: task.title, description: task.description })),
        SUGGESTED_CANDIDATES + excluded,
        { signal: input.signal, deadlineMs: input.semanticDeadlineMs ?? SEMANTIC_TRIAGE_DEADLINE_MS },
      );
      vectorByTask = tasks.map((_, index) => (result.neighbours[index] ?? []).map((neighbour) => neighbour.ticketId));
      semantic = result.diagnostics;
    }
  }

  // A triagem por palavras (até 10 da árvore viva) fundida com os vizinhos por vetor, por sugerida. Sem candidato, a sugerida nem vai ao Claude.
  const asked: ExistingMatchTask[] = [];
  const candidatesOf = new Map<number, ExistingMatchCandidate[]>();
  const originsOf = new Map<number, { words: number; vector: number; both: number }>();
  const byId = new Map(tree.map((ticket) => [ticket.id, ticket]));
  tasks.forEach((task, index) => {
    const hits = triageRelated(
      { title: task.title, description: task.description, partTitles: [] },
      tree.map((ticket) => ({ id: ticket.id, title: ticket.title, excerpt: descriptionExcerpt(ticket.description) })),
      SUGGESTED_CANDIDATES,
    );
    // Só vizinho que está na árvore já filtrada (sem duplicado, lugar escolhido nem ancestrais) vira candidato.
    const vectorIds = (vectorByTask[index] ?? []).filter((id) => byId.has(id));
    const fused = fuseBy(
      input.fusion ?? "rrf",
      hits.map((hit) => hit.id),
      vectorIds,
      SUGGESTED_CANDIDATES,
    );
    originsOf.set(index, { words: fused.filter((hit) => hit.origin === "words").length, vector: fused.filter((hit) => hit.origin === "vector").length, both: fused.filter((hit) => hit.origin === "both").length });
    const candidates = fused.map((hit) => {
      const ticket = byId.get(hit.id) as LookupTicket;
      return { key: keyOf(ticket), title: ticket.title, excerpt: descriptionExcerpt(ticket.description), status: ticket.status };
    });
    candidatesOf.set(index, candidates);
    if (candidates.length > 0) asked.push({ index, title: task.title, description: task.description, motivo: task.motivo, candidates });
  });

  // A segunda chamada: UMA para todas. Falha ou prazo: as sugeridas voltam como vieram.
  const chosen = new Map<number, string>();
  let callFailed = false;
  let matchMs = 0;
  if (asked.length > 0) {
    const started = Date.now();
    try {
      const aborted = new Promise<never>((_, reject) => {
        if (input.signal?.aborted) reject(new Error("lookup_aborted"));
        input.signal?.addEventListener("abort", () => reject(new Error("lookup_aborted")), { once: true });
      });
      const result = await Promise.race([input.matcher.matchExisting({ tasks: asked }, input.signal ? { signal: input.signal } : {}), aborted]);
      const answered = new Set<number>();
      for (const answer of result.answers) {
        if (answered.has(answer.index) || !candidatesOf.has(answer.index)) continue;
        answered.add(answer.index);
        // Só vale chave que esteja entre os candidatos DAQUELA sugerida.
        if (answer.existing !== null && (candidatesOf.get(answer.index) ?? []).some((candidate) => candidate.key === answer.existing)) chosen.set(answer.index, answer.existing);
      }
    } catch {
      callFailed = true;
    }
    matchMs = Date.now() - started;
  }

  const links = [...input.links];
  const seen = new Set(links.map((link) => `${link.de}>${link.dependeDe}`));
  const suggested: ElaborationSuggestion[] = [];
  const titles = new Map<string, string>();
  const lookups: LookupDiagnostic[] = [];
  const addedHere = new Set<string>();
  let failed = 0;
  tasks.forEach((task, index) => {
    const candidates = candidatesOf.get(index)?.length ?? 0;
    const note = (outcome: LookupOutcome, picked: boolean): void => void lookups.push({ outcome, candidates, chosen: picked, ...(semantic ? { origins: originsOf.get(index) as { words: number; vector: number; both: number } } : {}) });
    if (callFailed && candidates > 0) {
      failed += 1;
      suggested.push(task);
      note("lookup_failed", false);
      return;
    }
    const key = chosen.get(index);
    const ticket = key === undefined ? undefined : byKey.get(key);
    if (key === undefined || !ticket) {
      suggested.push(task);
      note("kept", false);
      return;
    }
    // A sugerida existe na árvore: nunca volta como tarefa. A ligação entra se ainda não existe e se cabe no limite.
    if (seen.has(`pai>${key}`)) {
      note(addedHere.has(key) ? "dropped_repeated_link" : "dropped_duplicate", true);
      return;
    }
    if (links.length >= ELABORATION_MAX_LINKS) {
      note("dropped_limit", true);
      return;
    }
    seen.add(`pai>${key}`);
    addedHere.add(key);
    links.push({ de: "pai", dependeDe: key, motivo: oneLine(task.motivo) });
    titles.set(key, ticket.title);
    note("converted", true);
  });
  // O que passou do teto (nunca acontece com o limite do servidor) volta como veio.
  for (const task of input.suggested.slice(SUGGESTED_LOOKUP_MAX)) {
    suggested.push(task);
    lookups.push({ outcome: "skipped_no_time", candidates: 0, chosen: false });
  }
  return { links, suggested, titles, failed, lookups, matchMs, ...(semantic ? { semantic } : {}) };
}

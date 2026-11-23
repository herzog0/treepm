/**
 * Tarefa sugerida que já existe vira ligação (ADR 0052, item 4). Depois que o Claude devolve as tarefas que o pedido implica,
 * cada uma é procurada na árvore viva do projeto: triagem por palavras (a mesma de `related.ts`, com o título e a descrição da
 * sugerida no lugar do rascunho) e um julgamento do Jev, pela porta de relacionados, da pergunta "pede a mesma coisa?". Se o
 * melhor candidato passa do limiar, a sugerida vira uma ligação do pai com ele. Nada aqui lê banco: quem chama entrega a árvore
 * que a rota já leu. Falha, prazo ou sinal abortado devolvem as sugeridas como vieram.
 */
import { descriptionExcerpt, triageRelated } from "@treepm/domain";
import { oneLine } from "./elaboration.js";
import { relatedInputFits } from "./jev-related-judge.js";
import { ELABORATION_MAX_LINKS } from "./prompts.js";
import type { ElaborationLink, ElaborationSuggestion, RelatedCandidate, RelatedJudge } from "./ports.js";

/**
 * "Pede a mesma coisa" (`sameRequest`) a partir do qual a sugerida vira ligação. Constante própria desta etapa, mais baixa que a do
 * duplicado (0,85): errar aqui custa pouco, porque a pessoa vê a ligação proposta e pode desmarcá-la.
 */
export const SUGGESTED_LINK_MIN = 0.7;
/** Quantos candidatos a triagem entrega ao Jev por sugerida. */
export const SUGGESTED_CANDIDATES = 10;
/** Teto de procuras em paralelo (uma requisição ao Jev por sugerida; o servidor aceita no máximo `ELABORATION_MAX_SUGGESTED`, que é 5). */
export const SUGGESTED_LOOKUP_PARALLEL = 5;
/** Teto do prazo desta etapa, em milissegundos; ela usa o que sobrou do prazo da elaboração. */
export const SUGGESTED_LOOKUP_TIMEOUT_MAX_MS = 10_000;

export type LookupTicket = { id: string; number: number; title: string; description: string };

export type LinkLookupInput = {
  /** As ligações já aceitas (depois do descarte do servidor) e as sugeridas que sobraram dele. */
  links: readonly ElaborationLink[];
  suggested: readonly ElaborationSuggestion[];
  /** A árvore viva do projeto (sem ideias nem cancelados) que a rota já leu. */
  tree: readonly LookupTicket[];
  projectKey: string;
  /** O relacionado apontado como o mesmo pedido: nenhuma ligação vai a ele. */
  duplicateKey: string | null;
  judge: RelatedJudge;
  signal?: AbortSignal | undefined;
};

/** O que aconteceu com uma sugerida na procura (só códigos e números). */
export type LookupOutcome = "converted" | "kept" | "dropped_duplicate" | "dropped_repeated_link" | "dropped_limit" | "lookup_failed" | "skipped_no_time";
export type LookupDiagnostic = { outcome: LookupOutcome; /** Quantos candidatos a triagem entregou ao Jev. */ candidates: number; /** O maior `sameRequest` do Jev; `null` sem candidato ou sem resposta. */ maxSameRequest: number | null };

export type LinkLookupResult = {
  links: ElaborationLink[];
  suggested: ElaborationSuggestion[];
  /** Título dos tickets que ganharam ligação nesta etapa, por chave. */
  titles: Map<string, string>;
  /** Quantas procuras falharam ou foram interrompidas (a sugerida correspondente volta como veio). */
  failed: number;
  /** Um desfecho por sugerida de entrada, na mesma ordem. */
  lookups: LookupDiagnostic[];
};

/** O melhor candidato (maior `sameRequest`) de uma sugerida (`best` é `null` se não houve candidato), com quantos candidatos foram ao Jev. Lança se o Jev falhar. */
async function bestMatch(task: ElaborationSuggestion, tree: readonly LookupTicket[], judge: RelatedJudge, signal: AbortSignal | undefined): Promise<{ best: { id: string; sameRequest: number } | null; candidates: number }> {
  const hits = triageRelated(
    { title: task.title, description: task.description, partTitles: [] },
    tree.map((ticket) => ({ id: ticket.id, title: ticket.title, excerpt: descriptionExcerpt(ticket.description) })),
    SUGGESTED_CANDIDATES,
  );
  const byId = new Map(tree.map((ticket) => [ticket.id, ticket]));
  const all: RelatedCandidate[] = hits.map((hit) => {
    const ticket = byId.get(hit.id) as LookupTicket;
    return { id: ticket.id, title: ticket.title, excerpt: descriptionExcerpt(ticket.description) };
  });
  const asked = { title: task.title, description: task.description };
  let candidates = all;
  while (candidates.length > 0 && !relatedInputFits({ draft: asked, candidates })) candidates = candidates.slice(0, -1);
  if (candidates.length === 0) return { best: null, candidates: 0 };
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error("lookup_aborted"));
    signal?.addEventListener("abort", () => reject(new Error("lookup_aborted")), { once: true });
  });
  const answers = await Promise.race([judge.judge({ draft: asked, candidates }, signal ? { signal } : {}), aborted]);
  let best: { id: string; sameRequest: number } | null = null;
  for (const candidate of candidates) {
    const sameRequest = answers[candidate.id]?.sameRequest ?? 0;
    if (best === null || sameRequest > best.sameRequest) best = { id: candidate.id, sameRequest };
  }
  return { best, candidates: candidates.length };
}

export async function linkExistingSuggestions(input: LinkLookupInput): Promise<LinkLookupResult> {
  const keyOf = (ticket: LookupTicket): string => `${input.projectKey}-${ticket.number}`;
  // O duplicado nem concorre: fora da triagem, não vai ao Jev e não pode ser alvo.
  const tree = input.tree.filter((ticket) => keyOf(ticket) !== input.duplicateKey);
  const byId = new Map(tree.map((ticket) => [ticket.id, ticket]));
  const tasks = input.suggested.slice(0, SUGGESTED_LOOKUP_PARALLEL);

  const settled = await Promise.allSettled(tasks.map((task) => bestMatch(task, tree, input.judge, input.signal)));

  const links = [...input.links];
  const seen = new Set(links.map((link) => `${link.de}>${link.dependeDe}`));
  const suggested: ElaborationSuggestion[] = [];
  const titles = new Map<string, string>();
  const lookups: LookupDiagnostic[] = [];
  const addedHere = new Set<string>();
  let failed = 0;
  tasks.forEach((task, index) => {
    const outcome = settled[index] as PromiseSettledResult<Awaited<ReturnType<typeof bestMatch>>>;
    if (outcome.status === "rejected") {
      failed += 1;
      suggested.push(task);
      lookups.push({ outcome: "lookup_failed", candidates: 0, maxSameRequest: null });
      return;
    }
    const { best, candidates } = outcome.value;
    const note = (code: LookupOutcome): void => void lookups.push({ outcome: code, candidates, maxSameRequest: best?.sameRequest ?? null });
    const ticket = best !== null && best.sameRequest >= SUGGESTED_LINK_MIN ? byId.get(best.id) : undefined;
    if (!ticket) {
      suggested.push(task);
      note("kept");
      return;
    }
    // A sugerida existe na árvore: nunca volta como tarefa. A ligação entra se ainda não existe e se cabe no limite.
    const key = keyOf(ticket);
    if (seen.has(`pai>${key}`)) {
      note(addedHere.has(key) ? "dropped_repeated_link" : "dropped_duplicate");
      return;
    }
    if (links.length >= ELABORATION_MAX_LINKS) {
      note("dropped_limit");
      return;
    }
    seen.add(`pai>${key}`);
    addedHere.add(key);
    links.push({ de: "pai", dependeDe: key, motivo: oneLine(task.motivo) });
    titles.set(key, ticket.title);
    note("converted");
  });
  // O que passou do teto de procuras (nunca acontece com o limite do servidor) volta como veio.
  for (const task of input.suggested.slice(SUGGESTED_LOOKUP_PARALLEL)) {
    suggested.push(task);
    lookups.push({ outcome: "skipped_no_time", candidates: 0, maxSameRequest: null });
  }
  return { links, suggested, titles, failed, lookups };
}

import { readFileSync } from "node:fs";
import { TicketCommandError, call, listRows, resolveNumber } from "./ticket-commands.js";
import type { Row, TicketContext } from "./ticket-commands.js";

/**
 * `conversation-dry-run`: o que a tela faz para um pedido novo (abre a conversa com o texto, recebe o rascunho e pede o lugar
 * proposto), sem criar ticket. A conversa aberta é descartada no fim, com sucesso ou erro. Desde a ADR 0052 a procura não
 * escreve resumo nenhum (o texto do ramo é montado na hora) e a decisão dela fica guardada com a conversa: o comando a lê
 * ANTES de descartar a conversa e a imprime em `probabilities`, com as chaves dos tickets no lugar dos ids.
 */
export type ConversationDryRunInput = { textFile: string; scope?: number };

type Draft = { title: string; description: string; children: { title: string; description: string }[]; idea: boolean } | null;
type Conversation = { id: string; draft: Draft; ready: boolean };
type Target = { parentId: string | null; path: { id: string; title: string }[] };
/** Um relacionado como a rota o devolve (ADR 0052, fatia 2): sem probabilidades, `path` do topo até o pai. */
export type RelatedItem = { id: string; key: string; title: string; status: string; path: { id: string; title: string }[] };
export type Outcome = {
  destination: Target;
  alternatives: Target[];
  discarded: unknown[];
  related?: RelatedItem[];
  duplicate?: { id: string; key: string; title: string } | null;
  [rest: string]: unknown;
};

/** A decisão guardada da procura (ADR 0052): só ids e números. */
export type Decision = {
  uncertain: boolean;
  stopReason: string | null;
  chosenPath: string[];
  alternatives: string[][];
  scope: { ticketId: string; fit: number | null } | null;
  levels: { level: number; parentId: string | null; result: string; belongs: number | null; candidates: { ticketId: string; probability: number }[] }[];
  related?: { ticketId: string; number: number; sameSubject: number; sameRequest: number }[];
  duplicateTicketId?: string | null;
  rule?: string | null;
};

/** A decisão com as chaves dos tickets (as que a pessoa lê) no lugar dos ids. */
export function probabilitiesOf(decision: Decision, keyOf: (id: string | null) => string | null) {
  return {
    uncertain: decision.uncertain,
    stopReason: decision.stopReason,
    chosenPath: decision.chosenPath.map(keyOf),
    alternatives: decision.alternatives.map((path) => path.map(keyOf)),
    scope: decision.scope ? { key: keyOf(decision.scope.ticketId), fit: decision.scope.fit } : null,
    rule: decision.rule ?? null,
    related: (decision.related ?? []).map((entry) => ({ key: keyOf(entry.ticketId), sameSubject: entry.sameSubject, sameRequest: entry.sameRequest })),
    duplicateKey: decision.duplicateTicketId ? keyOf(decision.duplicateTicketId) : null,
    levels: decision.levels.map((level) => ({
      level: level.level,
      parentKey: keyOf(level.parentId),
      result: level.result,
      belongs: level.belongs,
      candidates: level.candidates.map((candidate) => ({ key: keyOf(candidate.ticketId), probability: candidate.probability })),
    })),
  };
}

/** A elaboração como a rota a devolve (ADR 0052, fatia 3): `dependeDe` é a chave do ticket na API; `unavailable` diz por que veio vazia. */
export type Elaboration = {
  links: { de: "pai" | number; dependeDe: string; dependeDeTitle: string; motivo: string }[];
  suggested: { title: string; description: string; motivo: string }[];
  unavailable: string | null;
  /** Só números e códigos: o que o modelo devolveu, o que o descarte tirou, o desfecho de cada sugerida e os tempos. */
  diagnostics?: ElaborationDiagnostics;
};
export type ElaborationDiagnostics = {
  model: { links: number; suggested: number };
  dropped: { links: Record<string, number>; suggested: Record<string, number> };
  lookups: { outcome: string; candidates: number; chosen: boolean }[];
  timingsMs: { claude: number; lookup: number; secondCall: number };
};

/** O que uma passada devolve, ainda com os ids da API: quem chama traduz para as chaves que quiser. */
export type DryRunResult = { draft: NonNullable<Draft>; ready: boolean; outcome: Outcome; decision: Decision | null; elaboration: Elaboration | null; conversationDiscarded: boolean; conversationId: string };

/**
 * Uma passada: abre a conversa com o texto, pede o lugar, lê a decisão guardada e descarta a conversa (com sucesso ou erro).
 * Não imprime nada. `scopeId` é o id (da API) do ticket de escopo.
 */
export async function runDryRun(ctx: TicketContext, text: string, scopeId?: string): Promise<DryRunResult> {
  const scopeBody = scopeId ? { scopeId } : {};
  const conversation = await call<Conversation>("abrir conversa", ctx, "POST", `/projects/${ctx.project}/ticket-conversations`, { message: text, ...scopeBody });
  let result: Omit<DryRunResult, "conversationDiscarded" | "conversationId">;
  let discarded = false;
  try {
    if (!conversation.draft) throw new TicketCommandError("O assistente não montou um rascunho a partir do texto: não há o que procurar.");
    const outcome = await call<Outcome>("procurar o lugar", ctx, "POST", `/ticket-conversations/${conversation.id}/placement`, scopeBody);
    // A decisão sai ANTES do descarte: descartar a conversa apaga a decisão que ainda é dela.
    // A leitura é opcional: se falhar, o resultado da procura sai mesmo assim, sem as probabilidades.
    const stored = await call<{ decision: Decision | null }>("ler a decisão da procura", ctx, "GET", `/ticket-conversations/${conversation.id}/placement-decision`).catch(() => null);
    // A elaboração lê a decisão guardada: roda ANTES do descarte. Falhar não derruba o ensaio.
    const elaboration = await call<Elaboration>("elaborar ligações e tarefas", ctx, "POST", `/ticket-conversations/${conversation.id}/elaboration`).catch(() => null);
    result = { draft: conversation.draft, ready: conversation.ready, outcome, decision: stored?.decision ?? null, elaboration };
  } finally {
    discarded = (await ctx.client.request("DELETE", `/ticket-conversations/${conversation.id}`)).status === 204;
  }
  return { ...result, conversationDiscarded: discarded, conversationId: conversation.id };
}

export async function conversationDryRunCommand(ctx: TicketContext, input: ConversationDryRunInput): Promise<void> {
  let text: string;
  try {
    text = readFileSync(input.textFile, "utf8");
  } catch {
    throw new TicketCommandError(`Não consegui ler o arquivo do pedido ${input.textFile}.`);
  }
  const rows = await listRows(ctx);
  const scope = input.scope === undefined ? null : await resolveNumber(ctx, rows, input.scope);
  const run = await runDryRun(ctx, text, scope?.id);

  const byId = new Map<string, Row>(rows.map((row) => [row.id, row]));
  const keyOf = (id: string | null): string | null => (id === null ? null : (byId.get(id)?.key ?? null));
  const target = (value: Target) => ({
    parentKey: keyOf(value.parentId),
    path: value.path.map((step) => ({ key: keyOf(step.id), title: step.title })),
  });
  const { destination, alternatives, related, duplicate, ...decision } = run.outcome;
  ctx.log(
    JSON.stringify({
      draft: run.draft,
      ready: run.ready,
      destination: target(destination),
      alternatives: alternatives.map(target),
      related: (related ?? []).map((item) => ({ key: item.key, title: item.title, status: item.status, path: item.path.map((step) => ({ key: keyOf(step.id), title: step.title })) })),
      duplicate: duplicate ? { key: duplicate.key, title: duplicate.title } : null,
      decision,
      probabilities: run.decision ? probabilitiesOf(run.decision, keyOf) : null,
      links: run.elaboration?.links ?? [],
      suggested: run.elaboration?.suggested ?? [],
      elaborationUnavailable: run.elaboration === null ? "unavailable" : run.elaboration.unavailable,
      diagnostics: run.elaboration?.diagnostics ?? null,
      conversationDiscarded: run.conversationDiscarded,
      ...(run.conversationDiscarded ? {} : { conversationId: run.conversationId }),
    }),
  );
}

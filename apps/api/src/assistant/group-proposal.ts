/**
 * Proposta de agrupador novo (ADR 0031): depois da descida, o Jev julga a afinidade do rascunho com cada ticket solto
 * do destino, o código decide o grupo e o Claude escreve o nome. Lógica sem banco: tudo entra por `ProposeInput`.
 * A falha de qualquer provedor nunca derruba a procura: vira `unavailable`.
 */
import { descriptionExcerpt } from "@treepm/domain";
import { affinityInputFits } from "./jev-affinity-judge.js";
import { AssistantUnavailableError } from "./ports.js";
import type { AffinityJudge, GroupNamer, TicketDraft } from "./ports.js";
import type { PlacementOutcome } from "./placement-search.js";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";

/** Só acima disto o ticket solto faz parte do grupo proposto (0,7 não passa). */
export const AFFINITY_THRESHOLD = 0.7;
/** Prazo total da proposta (resumo do destino, afinidade e nome), fora dos 30 s da descida. */
export const PROPOSAL_TIMEOUT_MS = 20_000;

export type ProposalSkip = "not_settled" | "no_loose_tickets" | "too_large" | "same_as_destination" | "invalid_name" | "unavailable";
export type LooseTicket = { id: string; number: number; title: string; description: string };
export type GroupProposalResult = {
  groupProposal: { title: string; description: string; tickets: { id: string; number: number; title: string }[] } | null;
  groupProposalSkipped: ProposalSkip | null;
};
export type ProposeInput = {
  draft: TicketDraft;
  outcome: Pick<PlacementOutcome, "uncertain" | "stoppedEarly" | "scope">;
  /** Raiz do projeto (título: `PROVIDER_ROOT_LABEL`, nunca o nome do projeto) ou agrupador de destino; o resumo é resolvido só se a verificação acontecer. */
  destination: { kind: "root"; title: string } | { kind: "group"; title: string; summary: () => Promise<string> };
  looseTickets: readonly LooseTicket[];
  affinity: AffinityJudge;
  namer: GroupNamer;
  timeoutMs?: number;
};

/**
 * O que os provedores de IA recebem no lugar do nome do projeto quando o destino é a raiz (ADR 0056: o nome do projeto não vai
 * ao provedor). Constante única; a tela e as respostas à pessoa continuam mostrando o nome de verdade.
 */
export const PROVIDER_ROOT_LABEL = "Raiz do projeto";

const skipped = (reason: ProposalSkip | null): GroupProposalResult => ({ groupProposal: null, groupProposalSkipped: reason });

export async function proposeGroup(input: ProposeInput): Promise<GroupProposalResult> {
  const { outcome } = input;
  if (outcome.uncertain || outcome.stoppedEarly || outcome.scope?.outOfScope) return skipped("not_settled");
  if (input.looseTickets.length === 0) return skipped("no_loose_tickets");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? PROPOSAL_TIMEOUT_MS);
  try {
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new AssistantUnavailableError("proposal_timeout")));
    });
    return await Promise.race([run(input, controller.signal), timedOut]);
  } catch (error) {
    if (error instanceof AssistantUnavailableError) return skipped("unavailable");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function run(input: ProposeInput, signal: AbortSignal): Promise<GroupProposalResult> {
  const loose = [...input.looseTickets].sort((a, b) => a.number - b.number);
  const view = (ticket: LooseTicket) => ({ title: ticket.title, descriptionExcerpt: descriptionExcerpt(ticket.description) });
  const { destination } = input;
  const affinityInput = {
    draft: input.draft,
    destination: destination.kind === "root" ? { title: destination.title } : { title: destination.title, summary: await destination.summary() },
    tickets: loose.map((ticket) => ({ id: ticket.id, ...view(ticket) })),
  };
  if (!affinityInputFits(affinityInput)) return skipped("too_large");

  const scores = await input.affinity.judge(affinityInput, { signal });
  const passed = loose.filter((ticket) => {
    const score = scores[ticket.id];
    if (score === undefined) throw new AssistantUnavailableError("invalid_output");
    return score > AFFINITY_THRESHOLD;
  });
  if (passed.length === 0) return skipped(null);
  if (destination.kind === "group" && passed.length === loose.length) return skipped("same_as_destination");

  const named = await input.namer.name(
    {
      destinationTitle: destination.title,
      newTicket: { title: input.draft.title, descriptionExcerpt: descriptionExcerpt(input.draft.description) },
      existingTickets: passed.map(view),
    },
    { signal },
  );
  const title = ticketTitleSchema.safeParse(named.title);
  const description = ticketDescriptionSchema.safeParse(named.description);
  if (!title.success || !description.success) return skipped("invalid_name");
  return {
    groupProposal: {
      title: title.data,
      description: description.data,
      tickets: passed.map(({ id, number, title: ticketTitle }) => ({ id, number, title: ticketTitle })),
    },
    groupProposalSkipped: null,
  };
}

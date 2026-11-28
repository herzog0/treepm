import type { PlayStep, WorkScope, WorkTicket } from "@treepm/domain";
import type { TicketSummary } from "../api/client.js";

/** Os resumos que a pessoa enxerga, no formato do domínio (os campos opcionais da API ganham o padrão). */
export function toWorkTickets(byProject: Readonly<Record<string, readonly TicketSummary[]>>): WorkTicket[] {
  return Object.values(byProject)
    .flat()
    .map((ticket) => ({
      ...ticket,
      priority: ticket.priority ?? 0,
      blocked: ticket.blocked ?? false,
      agentWork: ticket.agentWork ?? null,
      idea: ticket.idea ?? null,
      // Lugar na fila (ADR 0068): a API sempre manda; ausente vale nulo (fora da fila).
      place: ticket.place ?? null,
    }));
}

/** O play em andamento: a lista fotografada ao começar e a posição dentro dela. */
export interface PlayRun {
  template: PlayTemplateIdLike;
  scope: WorkScope;
  /** O alcance como a barra o diz ("Em ABC-12 · título"). */
  scopeLabel: string;
  steps: readonly PlayStep[];
  index: number;
}
type PlayTemplateIdLike = "next_to_work" | "my_work" | "in_progress" | "standup" | "agent_work";

/** No stand-up: a pessoa da vez e a posição do passo dentro do turno dela (passos consecutivos com a mesma pessoa). */
export function turnOf(steps: readonly PlayStep[], index: number): { personId: string; position: number; total: number } | null {
  const personId = steps[index]?.personId ?? null;
  if (personId === null) return null;
  let start = index;
  while (start > 0 && steps[start - 1]?.personId === personId) start -= 1;
  let end = index;
  while (end + 1 < steps.length && steps[end + 1]?.personId === personId) end += 1;
  return { personId, position: index - start + 1, total: end - start + 1 };
}

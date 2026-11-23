import { effectivePriorities } from "./priority.js";
import { ticketsInScope, workQueue } from "./work-queue.js";
import type { WorkScope, WorkTicket } from "./work-queue.js";

/**
 * Os modelos do botão play (ADR 0048): cada um é um filtro e uma ordem sobre os tickets do alcance, e dá a sequência de passos que
 * o modo play percorre. Determinísticos; o instante de "agora" entra como parâmetro (modelo "Trabalho pela IA").
 */

export const PLAY_TEMPLATE_IDS = ["next_to_work", "my_work", "in_progress", "standup", "agent_work"] as const;
export type PlayTemplateId = (typeof PLAY_TEMPLATE_IDS)[number];

/** Uma pessoa como o stand-up e a ordem por responsável a enxergam. */
export interface PlayPerson {
  readonly id: string;
  readonly displayName: string;
}

/** Um passo do play: o ticket a visitar e, no stand-up, a pessoa da vez (`null` nos outros modelos). */
export interface PlayStep {
  readonly ticketId: string;
  readonly personId: string | null;
}

/** Um modelo pronto: os passos, em ordem, e a quantidade de TICKETS diferentes (um ticket pode abrir dois turnos no stand-up). */
export interface PlayTemplate {
  readonly id: PlayTemplateId;
  readonly steps: readonly PlayStep[];
  readonly count: number;
}

export interface PlayInput {
  /** Os resumos dos tickets que a pessoa enxerga (a árvore inteira: a prioridade herdada precisa dos ancestrais). */
  readonly tickets: readonly WorkTicket[];
  readonly people: readonly PlayPerson[];
  /** A pessoa que usa o play. */
  readonly me: string;
  readonly scope: WorkScope;
  /** O instante de agora, em milissegundos (o relógio de quem chama). */
  readonly now: number;
}

const byText = (a: string, b: string): number => a.localeCompare(b, "pt", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

function template(id: PlayTemplateId, steps: readonly PlayStep[]): PlayTemplate {
  return { id, steps, count: new Set(steps.map((step) => step.ticketId)).size };
}

const plain = (ids: readonly string[]): PlayStep[] => ids.map((ticketId) => ({ ticketId, personId: null }));

/** Os tickets da pessoa em andamento no alcance, na ordem do play: prioridade que vale e número. */
function inProgressOf(personId: string, inScope: readonly WorkTicket[], eff: ReadonlyMap<string, number>): WorkTicket[] {
  return inScope
    .filter((ticket) => ticket.status === "in_progress" && ticket.idea === null && ticket.assigneeIds.includes(personId))
    .sort((a, b) => (eff.get(b.id) ?? 0) - (eff.get(a.id) ?? 0) || a.number - b.number);
}

/** Os cinco modelos, na ordem da ADR 0048, vazios inclusive (a web os mostra desabilitados). */
export function playTemplates(input: PlayInput): PlayTemplate[] {
  return PLAY_TEMPLATE_IDS.map((id) => playTemplate(id, input));
}

/** Um modelo só. */
export function playTemplate(id: PlayTemplateId, input: PlayInput): PlayTemplate {
  const { tickets, people, me, scope, now } = input;
  const inScope = ticketsInScope(tickets, scope);
  const eff = new Map([...effectivePriorities(tickets)].map(([ticketId, entry]) => [ticketId, entry.value] as const));
  switch (id) {
    case "next_to_work":
      return template(id, plain(workQueue(tickets, me, scope)));
    case "my_work": {
      // Os meus tickets em andamento e a fazer, fora de ideias; em andamento primeiro, depois prioridade que vale, depois a árvore.
      const mine = inScope
        .filter((ticket) => (ticket.status === "in_progress" || ticket.status === "todo") && ticket.idea === null && ticket.assigneeIds.includes(me))
        .sort(
          (a, b) =>
            Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
            (eff.get(b.id) ?? 0) - (eff.get(a.id) ?? 0) ||
            a.number - b.number,
        );
      return template(id, plain(mine.map((ticket) => ticket.id)));
    }
    case "in_progress": {
      // Tudo o que está em andamento; por pessoa responsável (ordem alfabética; com vários, a primeira; sem responsável por último).
      const name = new Map(people.map((person) => [person.id, person.displayName] as const));
      const owner = (ticket: WorkTicket): string | null => {
        const names = ticket.assigneeIds.map((personId) => name.get(personId) ?? personId).sort(byText);
        return names[0] ?? null;
      };
      const open = inScope.filter((ticket) => ticket.status === "in_progress" && ticket.idea === null);
      const sorted = open
        .map((ticket) => ({ ticket, owner: owner(ticket) }))
        .sort((a, b) => (a.owner === b.owner ? 0 : a.owner === null ? 1 : b.owner === null ? -1 : byText(a.owner, b.owner)) || a.ticket.number - b.ticket.number);
      return template(id, plain(sorted.map((entry) => entry.ticket.id)));
    }
    case "standup": {
      // Por pessoa, em ordem alfabética, quem conduz por último; em cada uma, o que ela tem em andamento e o próximo da fila dela
      // (o primeiro da fila que é DELA: ticket sem responsável não é "o próximo" de ninguém). Quem não tem nada fica de fora.
      const ordered = [...people].sort((a, b) => Number(a.id === me) - Number(b.id === me) || byText(a.displayName, b.displayName));
      const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
      const steps: PlayStep[] = [];
      for (const person of ordered) {
        const turn = inProgressOf(person.id, inScope, eff).map((ticket) => ticket.id);
        const next = workQueue(tickets, person.id, scope).find((ticketId) => byId.get(ticketId)?.assigneeIds.includes(person.id));
        for (const ticketId of next === undefined ? turn : [...turn, next]) steps.push({ ticketId, personId: person.id });
      }
      return template(id, steps);
    }
    case "agent_work": {
      // Os que têm o marcador de trabalho pela IA valendo agora; os que vencem antes primeiro.
      const live = inScope
        .map((ticket) => ({ ticket, until: ticket.agentWork ? Date.parse(ticket.agentWork.until) : Number.NaN }))
        .filter((entry) => entry.until > now)
        .sort((a, b) => a.until - b.until || a.ticket.number - b.ticket.number);
      return template(id, plain(live.map((entry) => entry.ticket.id)));
    }
  }
}

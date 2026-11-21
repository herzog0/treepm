import type { TicketSummary } from "../../api/client.js";

export interface MentionMatch {
  /** Posição no texto onde a chave começa e termina (`end` exclusivo). */
  start: number;
  end: number;
  ticket: TicketSummary;
}

/** Chave de ticket solta no texto: letras maiúsculas e números, hífen e número. Não vale no meio de palavra. */
const KEY = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]*-\d+(?![\p{L}\p{N}_-])/gu;

/**
 * Chaves de tickets que existem no mesmo projeto (ADR 0036): cada uma vira uma menção. Chave que não existe ou que é de
 * outro projeto fica de fora. Função pura sobre um trecho de texto; quem chama decide o que é código (que não vira menção).
 */
export function findMentions(text: string, tickets: readonly TicketSummary[], projectId: string): MentionMatch[] {
  const byKey = new Map<string, TicketSummary>();
  for (const ticket of tickets) if (ticket.projectId === projectId) byKey.set(ticket.key, ticket);
  const found: MentionMatch[] = [];
  for (const match of text.matchAll(KEY)) {
    const ticket = byKey.get(match[0]);
    if (ticket) found.push({ start: match.index, end: match.index + match[0].length, ticket });
  }
  return found;
}

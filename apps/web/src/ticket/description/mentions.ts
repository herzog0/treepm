import { scanTicketKeys } from "@treepm/domain";
import type { TicketSummary } from "../../api/client.js";

export interface MentionMatch {
  /** Posição no texto onde a chave começa e termina (`end` exclusivo). */
  start: number;
  end: number;
  ticket: TicketSummary;
}

/**
 * Chaves de tickets que existem no mesmo projeto (ADR 0036): cada uma vira uma menção. Chave que não existe ou que é de
 * outro projeto fica de fora. Função pura sobre um trecho de texto; quem chama decide o que é código (que não vira menção). O que
 * é uma chave vem de `@treepm/domain` (ADR 0037), a mesma definição que a API usa.
 */
export function findMentions(text: string, tickets: readonly TicketSummary[], projectId: string | null): MentionMatch[] {
  const byKey = new Map<string, TicketSummary>();
  for (const ticket of tickets) if (projectId === null || ticket.projectId === projectId) byKey.set(ticket.key, ticket);
  const found: MentionMatch[] = [];
  for (const { key, start, end } of scanTicketKeys(text)) {
    const ticket = byKey.get(key);
    if (ticket) found.push({ start, end, ticket });
  }
  return found;
}

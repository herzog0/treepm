import { foldForSearch, searchTickets as searchInDomain } from "@treepm/domain";
import type { TicketSummary } from "../api/client.js";

/** Máximo de tickets na folha da barra (ADR 0036). */
export const MAX_RESULTS = 8;

/** Sem maiúsculas nem acentos: a comparação da busca. */
export const fold = foldForSearch;

/**
 * Busca da barra (ADR 0036): sobre os tickets já carregados, de todos os projetos. A regra (palavras, ordem de
 * relevância, uma aparição por ticket) vive em `@treepm/domain`, a mesma que a API usa na camada de consulta (ADR 0037).
 */
export function searchTickets(text: string, ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>): TicketSummary[] {
  return searchInDomain(text, Object.values(ticketsByProject).flat(), MAX_RESULTS);
}

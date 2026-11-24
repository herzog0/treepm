import { z } from "zod";
import { ticketStatusSchema } from "../tickets/tickets.schema.js";

/**
 * Os esquemas de entrada das ferramentas de consulta (ADR 0037), que as ferramentas das conversas (`chat-tools.ts`, ADR 0056)
 * estendem com o projeto. Nomes em inglês, descrições em português.
 */

const label = z.string().trim().describe("Número do ticket.");

export const searchTicketsInput = z.strictObject({
  query: z.string().trim().min(1).max(200).describe("Texto a procurar no título e na descrição."),
  limit: z.number().int().min(1).max(50).optional().describe("Quantos resultados no máximo (padrão 8, máximo 50)."),
});
export const readTicketInput = z.strictObject({ ticket: label });
export const listTicketsInput = z.strictObject({
  status: z.array(ticketStatusSchema).max(5).optional().describe("Só tickets nestas situações: todo, in_progress, in_review, done, cancelled."),
  under: label.optional().describe("Só os descendentes deste ticket, em todos os níveis (o próprio ticket não entra)."),
  limit: z.number().int().min(1).max(200).optional().describe("Tamanho da página (padrão 50, máximo 200)."),
  after: label.optional().describe("Rótulo devolvido em `after` pela página anterior; devolve só tickets depois dele."),
});
export const projectOverviewInput = z.strictObject({});

import { z } from "zod";
import { ticketStatusSchema } from "../tickets/tickets.schema.js";

/**
 * As quatro ferramentas da pergunta sobre o projeto (ADR 0037): espelham a camada de consulta, em rótulos neutros.
 * Nomes em inglês, descrições em português. A entrada é validada com o esquema antes de executar.
 */

const label = z.string().trim().describe("Rótulo do ticket, como T47.");

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

export const ASK_TOOLS = [
  {
    name: "search_tickets",
    description:
      "Procura tickets do projeto por texto, no título e na descrição. Devolve resumos (rótulo, título, trecho da descrição, situação, pai) dos que melhor casam. Use para descobrir onde está um assunto.",
    schema: searchTicketsInput,
  },
  {
    name: "read_ticket",
    description:
      "Lê um ticket inteiro: descrição completa, situação, pai, caminho do topo até o pai, filhos e ligações nos dois sentidos. `mentions.outgoing`: tickets que este cita no texto; `mentions.incoming`: tickets que citam este. `depends_on.outgoing`: tickets que precisam estar prontos antes deste; `depends_on.incoming`: tickets que esperam por este.",
    schema: readTicketInput,
  },
  {
    name: "list_tickets",
    description:
      "Lista resumos de tickets em ordem de número, com filtro de situação e de ramo (`under`). Quando `truncated` for verdadeiro há mais: peça a página seguinte com `after`.",
    schema: listTicketsInput,
  },
  {
    name: "project_overview",
    description: "Visão geral do projeto: total de tickets, contagem por situação e os tickets do topo da árvore com o progresso de cada um.",
    schema: projectOverviewInput,
  },
] as const;

export type AskToolName = (typeof ASK_TOOLS)[number]["name"];

/** As definições no formato do SDK (`input_schema` em JSON Schema, gerado do mesmo esquema que valida a entrada). */
export function askToolDefinitions(): { name: string; description: string; input_schema: { type: "object"; [key: string]: unknown } }[] {
  return ASK_TOOLS.map((tool) => {
    const schema: { type: "object"; [key: string]: unknown } = { ...(z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>), type: "object" };
    delete schema["$schema"];
    return { name: tool.name, description: tool.description, input_schema: schema };
  });
}

import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import { ticketSummarySchema } from "./tickets.schema.js";
import type { TicketSummary } from "./tickets.schema.js";

/**
 * As chaves do Linear de cada ticket com origem (ADR 0061, seção 4, TREEPM-501): a de hoje primeiro, depois as que a issue já teve.
 * Só a lista de tickets da tela as carrega, para a barra de busca achar `ENG-45`. NÃO entram em `TicketSummary`, que o MCP, o assistente
 * e a Voyage também leem: este módulo é importado só pela rota da lista (um teste de fonte confere), e a regra de privacidade da
 * ADR 0061, seção 6 (nada vindo do Linear vai a provedor de IA nem ao MCP), vale para ele como para o resto.
 */
export const listedTicketSchema = ticketSummarySchema.extend({ externalKeys: z.array(z.string()).optional() });
export type ListedTicket = z.output<typeof listedTicketSchema>;

/** Ticket do projeto → suas chaves do Linear; quem não tem origem (ou é o ticket de um projeto do Linear, sem chave) não aparece. */
export async function readLinearKeys(tx: TenantClient, projectId: string): Promise<Map<string, string[]>> {
  const rows = await tx.$queryRaw<{ ticket_id: string; external_key: string | null; external_previous_keys: string[] }[]>`
    select r.ticket_id, r.external_key, r.external_previous_keys
    from ticket_external_refs r join tickets t on t.org_id = r.org_id and t.id = r.ticket_id
    where t.project_id = ${projectId}::uuid and r.kind = 'issue'`;
  const keys = new Map<string, string[]>();
  for (const row of rows) {
    const all = [...(row.external_key === null ? [] : [row.external_key]), ...row.external_previous_keys];
    if (all.length > 0) keys.set(row.ticket_id, all);
  }
  return keys;
}

/** O resumo da lista da tela: o de sempre, mais as chaves do Linear quando o ticket as tem. */
export const withLinearKeys = (summary: TicketSummary, keys: ReadonlyMap<string, readonly string[]>): ListedTicket => {
  const linear = keys.get(summary.id);
  return linear === undefined ? summary : { ...summary, externalKeys: [...linear] };
};

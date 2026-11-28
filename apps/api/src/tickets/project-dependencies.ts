import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import { dependencyNeedSchema } from "./tickets.schema.js";

/** Uma dependência na lista do projeto (ADR 0069, seção 1): o ticket de que este depende e o tipo. */
export const listedDependencySchema = z.object({ id: z.string(), need: dependencyNeedSchema });
export type ListedDependency = z.output<typeof listedDependencySchema>;

/**
 * As dependências de todos os tickets do projeto, em UMA consulta por projeto (ADR 0069, seção 1): ticket → os tickets de que ele
 * depende, em ordem de número do alvo. Só a lista da tela as leva; o mapa calcula o passo, o habilitador e as setas no navegador.
 * `number` é o número de cada ticket do projeto (a lista já o tem), para ordenar sem ler `tickets` de novo.
 */
export async function readProjectDependencies(
  tx: TenantClient,
  projectId: string,
  number: ReadonlyMap<string, number>,
): Promise<Map<string, ListedDependency[]>> {
  const rows = await tx.$queryRaw<{ from_ticket_id: string; to_ticket_id: string; need: string }[]>`
    select from_ticket_id, to_ticket_id, need from ticket_relations
    where project_id = ${projectId}::uuid and kind = 'depends_on'`;
  const result = new Map<string, ListedDependency[]>();
  for (const row of rows) {
    const entry = { id: row.to_ticket_id, need: dependencyNeedSchema.parse(row.need) };
    const list = result.get(row.from_ticket_id);
    if (list) list.push(entry);
    else result.set(row.from_ticket_id, [entry]);
  }
  const numberOf = (id: string) => number.get(id) ?? Number.MAX_SAFE_INTEGER;
  for (const list of result.values()) list.sort((a, b) => numberOf(a.id) - numberOf(b.id));
  return result;
}

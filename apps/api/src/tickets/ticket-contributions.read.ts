import type { TenantClient } from "@treepm/db";
import { parseOutput } from "../common/zod.js";
import { contributionStatusSchema } from "./tickets.schema.js";
import type { Contribution } from "./tickets.schema.js";
import { z } from "zod";

const contributionsSchema = z.array(
  z.object({
    id: z.string(),
    area: z.object({ id: z.string(), name: z.string() }),
    text: z.string(),
    status: contributionStatusSchema,
    people: z.array(z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() })),
  }),
);

/**
 * As contribuições de um ticket, na ordem de criação, com a área e as pessoas (ADR 0041). Duas consultas, em número
 * fixo qualquer que seja a quantidade de contribuições: as contribuições (com a área) e, só se houver alguma, as pessoas.
 * `ids` restringe a uma ou mais contribuições do ticket.
 */
export async function readContributions(tx: TenantClient, ticketId: string, ids?: readonly string[]): Promise<Contribution[]> {
  const rows = await tx.ticketContribution.findMany({
    where: { ticketId, ...(ids ? { id: { in: [...ids] } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, text: true, status: true, area: { select: { id: true, name: true } } },
  });
  if (rows.length === 0) return [];
  const links = await tx.ticketContributionPerson.findMany({
    where: { contributionId: { in: rows.map((row) => row.id) } },
    select: { contributionId: true, person: { select: { id: true, displayName: true, avatarUrl: true } } },
  });
  const people = new Map<string, Contribution["people"]>();
  for (const link of links) people.set(link.contributionId, [...(people.get(link.contributionId) ?? []), link.person]);
  const byName = (a: { displayName: string; id: string }, b: { displayName: string; id: string }) =>
    a.displayName.localeCompare(b.displayName) || (a.id < b.id ? -1 : 1);
  return parseOutput(
    contributionsSchema,
    rows.map((row) => ({ ...row, people: [...(people.get(row.id) ?? [])].sort(byName) })),
  );
}

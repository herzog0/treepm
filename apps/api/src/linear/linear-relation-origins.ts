import type { TenantClient } from "@treepm/db";

/**
 * As origens de RELAÇÃO do Linear (ADR 0061, fatia 3) lidas e marcadas fora da importação: a marca "do Linear" na página do ticket e
 * "removida aqui" quando uma pessoa tira a ligação. Moram em `external_item_refs`, a mesma tabela das origens de comentário; por isso só
 * este arquivo (além da importação) toca nela fora do caminho dos comentários, e a guarda de privacidade o lista nominalmente.
 * Nada daqui devolve texto nem dado de pessoa: só ids de linhas de `ticket_relations`.
 */

/**
 * Quais destas ligações vieram do Linear: têm uma origem de relação apontando para elas. A ligação feita aqui e depois ADOTADA pela origem
 * (`applied.adopted`) continua sem a marca: foi criada por uma pessoa.
 */
export async function linearRelationIds(tx: TenantClient, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const refs = await tx.externalItemRef.findMany({ where: { kind: "relation", localId: { in: [...ids] } }, select: { localId: true, applied: true } });
  const adopted = (applied: unknown): boolean => typeof applied === "object" && applied !== null && (applied as Record<string, unknown>)["adopted"] === true;
  return new Set(refs.filter((ref) => !adopted(ref.applied)).map((ref) => ref.localId as string));
}

/**
 * A ligação foi removida AQUI (tela ou MCP): a origem do Linear que apontava para ela guarda isso e esquece a linha, e a sincronização
 * não a traz de volta enquanto os dois tickets forem os mesmos (ADR 0061, seção 3). O ponto único de quem apaga `depends_on` ou `related`
 * à mão.
 */
export async function forgetRelationOrigins(tx: TenantClient, relationIds: readonly string[]): Promise<void> {
  if (relationIds.length === 0) return;
  await tx.externalItemRef.updateMany({ where: { kind: "relation", localId: { in: [...relationIds] } }, data: { localId: null, removedHereAt: new Date() } });
}

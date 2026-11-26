import type { TenantClient } from "@treepm/db";

/**
 * As origens de ETIQUETA do Linear (ADR 0065, seção 5; ADR 0061, seção 3) marcadas fora da importação, no molde de
 * `linear-relation-origins.ts`: quando uma pessoa (tela ou MCP) tira uma etiqueta do ticket ou apaga a etiqueta do projeto, a origem
 * guarda "removida aqui" e esquece a etiqueta daqui, e a sincronização não a traz de volta. Nada daqui lê nem devolve texto: só grava.
 * A guarda de privacidade lista este arquivo nominalmente.
 */

/**
 * Etiquetas tiradas AQUI de um ticket: os vínculos ticket↔etiqueta do Linear (`external_item_refs`, tipo `label`) daquele ticket que
 * apontavam para elas passam a `local_id = null, removed_here_at = now()`. A sincronização NÃO chama isto ao tirar uma etiqueta que
 * saiu no Linear (lá a origem é esquecida sem a marca).
 */
export async function forgetTicketLabelOrigins(tx: TenantClient, ticketId: string, labelIds: readonly string[]): Promise<void> {
  if (labelIds.length === 0) return;
  await tx.externalItemRef.updateMany({ where: { kind: "label", ticketId, localId: { in: [...labelIds] } }, data: { localId: null, removedHereAt: new Date() } });
}

/**
 * Etiqueta apagada AQUI (configurações do projeto): a origem dela no projeto (`project_label_origins`) e os vínculos de todos os tickets
 * passam a "removida aqui", ANTES de apagar a linha (a chave estrangeira zeraria `label_id` sem a marca, e a regra
 * `removed_here_at ⇒ label_id nulo` vale a cada comando). A etiqueta não renasce pela sincronização.
 */
export async function forgetDeletedLabelOrigins(tx: TenantClient, labelId: string): Promise<void> {
  const now = new Date();
  await tx.projectLabelOrigin.updateMany({ where: { labelId }, data: { labelId: null, removedHereAt: now } });
  await tx.externalItemRef.updateMany({ where: { kind: "label", localId: labelId }, data: { localId: null, removedHereAt: now } });
}

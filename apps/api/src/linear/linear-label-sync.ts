import type { Prisma, TenantClient } from "@treepm/db";
import { LABELS_PER_PROJECT, cleanLabelName, decideLinearLabelUpdate, decideLinearTicketLabels, groupedLabelName, isLabelColor, labelNameKey, nearestLabelColor } from "@treepm/domain";
import type { LabelColor, LinearTicketLabelRef } from "@treepm/domain";
import type { Principal } from "../access/principal.js";
import { insertOrReuse, lockLabelCreation } from "../tickets/labels.service.js";
import type { LabelsService } from "../tickets/labels.service.js";
import { touchProjectVersion } from "../tickets/project-version.js";
import type { ProjectRow } from "../tickets/tickets.service.js";
import type { LinearIssueNode, LinearLabelNode } from "./ports.js";

/**
 * As etiquetas do Linear (ADR 0065, seção 5; ADR 0061, seção 3), aplicadas dentro do passo `issues` aos tickets processados nele.
 *
 * Catálogo do projeto: cada etiqueta do Linear lida resolve pela origem (`project_label_origins`, por projeto e id de lá). Origem sem
 * etiqueta (apagada aqui) não renasce; origem viva acompanha nome e cor de lá enquanto o daqui ainda é o aplicado. Sem origem: adota a
 * etiqueta daqui com o mesmo nome (sem diferenciar maiúsculas) ou cria; se a de mesmo nome já é de OUTRA etiqueta do Linear e esta tem
 * grupo, entra como "Grupo: Nome". A ordem é determinística: sem grupo primeiro, depois pelo id do Linear.
 *
 * Ticket: regra por item (`decideLinearTicketLabels`) sobre o conjunto COMPLETO `labelIds`, vínculos em `external_item_refs` (tipo
 * `label`, `<issue>:<etiqueta>`), gravação pelo núcleo `LabelsService.applyTicketLabels` (um evento automático por ticket e por rodada,
 * sem marcar "removida aqui"). Sem mudança, nenhuma escrita. Nenhum id do Linear sai daqui (nem no evento); nenhum nome vai a provedor.
 */

const PROVIDER = "linear";
/** `external_item_refs.external_id` aceita até 200 caracteres. */
const EXTERNAL_ID_MAX = 200;

export const LABEL_COUNT_KEYS = [
  "labelsCreated",
  "labelsAdopted",
  "labelsUpdated",
  "labelsRenameTaken",
  "labelsAdded",
  "labelsRemoved",
  "labelsOverTicketLimit",
  "labelsOverProjectLimit",
  "labelsNameInvalid",
  "labelsUnread",
  "labelsInvalid",
] as const;
export type LabelCounts = Record<(typeof LABEL_COUNT_KEYS)[number], number>;

export type LabelSyncItem = { ticketId: string; number: number; node: LinearIssueNode };

type LabelRow = { id: string; name: string; color: string; name_key: string };
type OriginRow = { id: string; externalId: string; labelId: string | null; appliedName: string; appliedColor: string };

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const colorOf = (value: string): LabelColor => (isLabelColor(value) ? value : "gray");

export async function syncIssueLabels(tx: TenantClient, labels: LabelsService, principal: Principal, project: ProjectRow, runId: string, items: readonly LabelSyncItem[], counts: LabelCounts): Promise<void> {
  // Só as issues com o conjunto lido; o resto não mexe em nada (`labelIds` ausente ou malformado).
  const read = items.flatMap((item) => {
    if (item.node.labelIds === undefined) return [];
    const ids: string[] = [];
    for (const id of new Set(item.node.labelIds)) {
      if (`${item.node.id}:${id}`.length > EXTERNAL_ID_MAX) counts.labelsUnread += 1;
      else ids.push(id);
    }
    return [{ ...item, ids }];
  });
  if (read.length === 0) return;
  const wanted = new Set(read.flatMap((item) => item.ids));
  const nodes = new Map<string, LinearLabelNode>();
  for (const item of read) for (const node of item.node.labels ?? []) if (wanted.has(node.id) && !nodes.has(node.id)) nodes.set(node.id, node);

  const resolve = new Map<string, string | null>();
  if (wanted.size > 0) await resolveCatalog(tx, project, wanted, nodes, resolve, counts);

  // Vínculos e etiquetas atuais dos tickets, numa consulta cada.
  const ticketIds = read.map((item) => item.ticketId);
  const refRows = await tx.externalItemRef.findMany({ where: { kind: "label", provider: PROVIDER, ticketId: { in: ticketIds } }, select: { id: true, ticketId: true, externalId: true, localId: true, removedHereAt: true, applied: true } });
  const currentRows = await tx.ticketLabel.findMany({ where: { ticketId: { in: ticketIds } }, select: { ticketId: true, labelId: true } });
  const refsByTicket = new Map<string, (LinearTicketLabelRef & { rowId: string })[]>();
  for (const row of refRows) {
    const prefix = `${read.find((item) => item.ticketId === row.ticketId)?.node.id ?? ""}:`;
    if (!row.externalId.startsWith(prefix)) continue;
    const applied = row.applied as Record<string, unknown> | null;
    const list = refsByTicket.get(row.ticketId) ?? [];
    list.push({ rowId: row.id, linearLabelId: row.externalId.slice(prefix.length), localId: row.localId, removedHere: row.removedHereAt !== null, adopted: applied?.["adopted"] === true });
    refsByTicket.set(row.ticketId, list);
  }
  const currentByTicket = new Map<string, string[]>();
  for (const row of currentRows) currentByTicket.set(row.ticketId, [...(currentByTicket.get(row.ticketId) ?? []), row.labelId]);

  const creates: Prisma.ExternalItemRefCreateManyInput[] = [];
  const forget: string[] = [];
  const markRemoved: string[] = [];
  const revive: { rowId: string; localId: string; adopted: boolean }[] = [];
  const now = new Date();
  for (const item of read) {
    const refs = refsByTicket.get(item.ticketId) ?? [];
    const decision = decideLinearTicketLabels({ linearLabelIds: item.ids, resolve, refs, current: currentByTicket.get(item.ticketId) ?? [] });
    counts.labelsOverTicketLimit += decision.overLimit;
    counts.labelsUnread += decision.unresolved;
    const rowOf = (linearId: string): string | undefined => refs.find((ref) => ref.linearLabelId === linearId)?.rowId;
    for (const ref of decision.createRefs) {
      creates.push({ orgId: project.orgId, projectId: project.id, ticketId: item.ticketId, provider: PROVIDER, kind: "label", externalId: `${item.node.id}:${ref.linearLabelId}`, localId: ref.localId, applied: { adopted: ref.adopted } });
    }
    for (const ref of decision.reviveRefs) {
      const rowId = rowOf(ref.linearLabelId);
      if (rowId) revive.push({ rowId, localId: ref.localId, adopted: ref.adopted });
    }
    for (const linearId of decision.forgetRefs) forget.push(rowOf(linearId) as string);
    for (const linearId of decision.markRemovedHere) markRemoved.push(rowOf(linearId) as string);
    if (decision.add.length === 0 && decision.remove.length === 0) continue;
    const change = await labels.applyTicketLabels(
      tx,
      principal,
      project,
      { id: item.ticketId, number: item.number },
      { add: decision.add.map((labelId) => ({ labelId })), remove: decision.remove },
      { event: { automatic: true, source: "linear_reimport", runId }, markRemovedHere: false },
    );
    counts.labelsAdded += change.added.length;
    counts.labelsRemoved += change.removed.length;
  }
  // `ON CONFLICT DO NOTHING`: um vínculo gravado em paralelo não aborta o passo.
  if (creates.length > 0) await tx.externalItemRef.createMany({ data: creates, skipDuplicates: true });
  // O `adopted` da origem que volta é o de agora (`decideLinearTicketLabels`), não o de antes do esquecimento.
  for (const item of revive) await tx.externalItemRef.updateMany({ where: { id: item.rowId, removedHereAt: null }, data: { localId: item.localId, applied: { adopted: item.adopted } } });
  if (forget.length > 0) await tx.externalItemRef.updateMany({ where: { id: { in: forget } }, data: { localId: null } });
  if (markRemoved.length > 0) await tx.externalItemRef.updateMany({ where: { id: { in: markRemoved } }, data: { localId: null, removedHereAt: now } });
}

/** Resolve cada etiqueta do Linear lida numa etiqueta daqui (ou `null`: apagada aqui, nome inválido, fora do limite do projeto). */
async function resolveCatalog(tx: TenantClient, project: ProjectRow, wanted: ReadonlySet<string>, nodes: ReadonlyMap<string, LinearLabelNode>, resolve: Map<string, string | null>, counts: LabelCounts): Promise<void> {
  const origins: OriginRow[] = await tx.projectLabelOrigin.findMany({ where: { projectId: project.id, provider: PROVIDER }, select: { id: true, externalId: true, labelId: true, appliedName: true, appliedColor: true } });
  const originOf = new Map(origins.map((origin) => [origin.externalId, origin] as const));
  const fresh = [...wanted].filter((id) => !originOf.has(id) && nodes.has(id));
  // Precisa criar? A trava consultiva da criação vem antes de ler o catálogo (o limite de 200 fica exato, como na tela).
  if (fresh.length > 0) await lockLabelCreation(tx, project.id);
  const catalog = await tx.$queryRaw<LabelRow[]>`select id::text as id, name, color, name_key from project_labels where project_id = ${project.id}::uuid`;
  const byId = new Map(catalog.map((row) => [row.id, row] as const));
  const byKey = new Map(catalog.map((row) => [row.name_key, row] as const));
  /** Etiqueta daqui → a etiqueta do Linear que já aponta para ela. */
  const ownerOf = new Map(origins.flatMap((origin) => (origin.labelId === null ? [] : [[origin.labelId, origin.externalId] as const])));
  let total = catalog.length;
  let touched = false;

  // Origens conhecidas: apagada aqui não renasce; viva acompanha o Linear.
  for (const id of wanted) {
    const origin = originOf.get(id);
    if (origin === undefined) continue;
    if (origin.labelId === null) {
      resolve.set(id, null);
      continue;
    }
    resolve.set(id, origin.labelId);
    const node = nodes.get(id);
    const row = byId.get(origin.labelId);
    if (node === undefined || row === undefined) continue;
    const name = cleanLabelName(node.name);
    if (name === null) continue;
    // A forma aplicada com grupo ("Grupo: Nome") continua com grupo enquanto o grupo de lá existir.
    const grouped = node.parent ? groupedLabelName(node.parent.name, name) : null;
    // A forma aplicada com grupo ("Grupo: Nome") continua com grupo: compara o aplicado com as duas formas; só sem casar nenhuma, pelo
    // prefixo do grupo atual (grupo renomeado lá).
    const appliedKey = labelNameKey(origin.appliedName);
    const wasGrouped =
      grouped !== null && appliedKey !== labelNameKey(name) && (appliedKey === labelNameKey(grouped) || appliedKey.startsWith(`${labelNameKey(cleanLabelName(node.parent?.name ?? "") ?? "")}: `));
    const incomingName = wasGrouped ? (grouped as string) : name;
    // Cor malformada lá vale "não lida": fica a aplicada (não recolore para cinza).
    const incoming = { name: incomingName, color: HEX.test(node.color) ? nearestLabelColor(node.color) : colorOf(origin.appliedColor) };
    const update = decideLinearLabelUpdate({ current: { name: row.name, color: colorOf(row.color) }, applied: { name: origin.appliedName, color: colorOf(origin.appliedColor) }, incoming });
    if (update.name !== undefined) {
      const key = labelNameKey(update.name);
      const other = byKey.get(key);
      if (other !== undefined && other.id !== row.id) {
        counts.labelsRenameTaken += 1;
        delete update.name;
      }
    }
    if (update.name === undefined && update.color === undefined) continue;
    const next = { name: update.name ?? row.name, color: update.color ?? row.color };
    const key = labelNameKey(next.name);
    const changed = await tx.$executeRaw`
      update project_labels set name = ${next.name}, name_key = ${key}, color = ${next.color}, updated_at = now()
       where project_id = ${project.id}::uuid and id = ${row.id}::uuid
         and not exists (select 1 from project_labels o where o.project_id = ${project.id}::uuid and o.name_key = ${key} and o.id <> ${row.id}::uuid)`;
    if (changed === 0) {
      counts.labelsRenameTaken += 1;
      continue;
    }
    await tx.projectLabelOrigin.update({ where: { orgId_id: { orgId: project.orgId, id: origin.id } }, data: { ...(update.name !== undefined ? { appliedName: update.name } : {}), ...(update.color !== undefined ? { appliedColor: update.color } : {}), lastImportedAt: new Date() } });
    byKey.delete(row.name_key);
    const updated = { ...row, name: next.name, color: next.color, name_key: key };
    byKey.set(key, updated);
    byId.set(row.id, updated);
    counts.labelsUpdated += 1;
    touched = true;
  }

  // Sem origem: adota ou cria, numa ordem determinística (sem grupo primeiro, depois pelo id do Linear).
  const order = fresh.sort((a, b) => Number(nodes.get(a)?.parent != null) - Number(nodes.get(b)?.parent != null) || (a < b ? -1 : a > b ? 1 : 0));
  const newOrigins: Prisma.ProjectLabelOriginCreateManyInput[] = [];
  for (const id of order) {
    const node = nodes.get(id) as LinearLabelNode;
    const plain = cleanLabelName(node.name);
    if (plain === null) {
      counts.labelsNameInvalid += 1;
      resolve.set(id, null);
      continue;
    }
    let name = plain;
    const same = byKey.get(labelNameKey(plain));
    if (same !== undefined && ownerOf.has(same.id) && ownerOf.get(same.id) !== id && node.parent) {
      name = groupedLabelName(node.parent.name, plain) ?? plain;
    }
    const color = nearestLabelColor(node.color);
    let row = byKey.get(labelNameKey(name));
    let adopted = row !== undefined;
    if (row === undefined) {
      if (total >= LABELS_PER_PROJECT) {
        counts.labelsOverProjectLimit += 1;
        resolve.set(id, null);
        continue;
      }
      const result = await insertOrReuse(tx, project, name, color);
      row = result.row;
      adopted = !result.created;
      if (result.created) total += 1;
      byKey.set(row.name_key, row);
      byId.set(row.id, row);
    }
    if (adopted) counts.labelsAdopted += 1;
    else counts.labelsCreated += 1;
    touched = true;
    resolve.set(id, row.id);
    if (!ownerOf.has(row.id)) ownerOf.set(row.id, id);
    newOrigins.push({ orgId: project.orgId, projectId: project.id, provider: PROVIDER, externalId: id, labelId: row.id, appliedName: name, appliedColor: color });
  }
  // `ON CONFLICT DO NOTHING`: uma origem gravada em paralelo (outra rodada) não aborta o passo.
  if (newOrigins.length > 0) await tx.projectLabelOrigin.createMany({ data: newOrigins, skipDuplicates: true });
  if (touched) await touchProjectVersion(tx, project.id);
}

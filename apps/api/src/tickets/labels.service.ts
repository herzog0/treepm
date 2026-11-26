import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { LABELS_PER_PROJECT, LABELS_PER_TICKET, cleanLabelName, defaultLabelColor, labelNameKey } from "@treepm/domain";
import type { Actor, LabelColor } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { orConflict } from "../common/conflict.js";
import { forgetDeletedLabelOrigins, forgetTicketLabelOrigins } from "../linear/linear-label-origins.js";
import type { LabelRef, LabelView, ProjectLabelView } from "./labels.schema.js";
import { touchProjectVersion } from "./project-version.js";
import type { ProjectRow } from "./tickets.service.js";

/**
 * Etiquetas por projeto (ADR 0065): a lista do projeto e o pôr/tirar no ticket. Caminho ÚNICO de regras para a tela, o MCP e a
 * sincronização com o Linear: quem chama de fora da rota usa `applyTicketLabels` (sem conferência de permissão: quem chama confere) ou
 * `changeTicketLabels` (com as conferências da rota).
 *
 * ORDEM DAS TRAVAS (ADR 0046): consultiva `project-labels:<projeto>` (só quando o pedido pode criar etiqueta: serializa a criação no
 * projeto e deixa o limite de 200 exato) → linha do ticket (`for update`, como `lockAssignees`: o limite de 20 e o evento batem com o
 * estado) → linhas das etiquetas (`for key share`: apagar a etiqueta em paralelo espera, ou é visto como 404) → linha do projeto, no
 * toque do fim da transação. Apagar trava a linha da etiqueta (`for update`) antes de contar os tickets.
 */

/** Uma etiqueta tirada ou posta, como o evento guarda: o nome DA ÉPOCA (a linha do tempo não muda quando a etiqueta é renomeada). */
export type LabelChangeItem = { id: string; name: string };
export type TicketLabelsChange = { added: LabelChangeItem[]; removed: LabelChangeItem[]; labels: LabelView[] };
export type ApplyTicketLabelsOptions = {
  /** Campos a mais no evento (a sincronização: `automatic: true, source: "linear_reimport", runId`). Nunca muda as regras. */
  event?: Record<string, unknown>;
  /**
   * Marca as origens do Linear das etiquetas tiradas como "removida aqui" (padrão: sim, o caminho de uma pessoa). A sincronização passa
   * `false` ao tirar uma etiqueta que saiu no Linear: lá a origem é esquecida sem a marca (`decideLinearTicketLabels`).
   */
  markRemovedHere?: boolean;
};

type LabelRow = { id: string; name: string; color: LabelColor; name_key: string };

const view = (row: Pick<LabelRow, "id" | "name" | "color">): LabelView => ({ id: row.id, name: row.name, color: row.color });

/** O nome como é guardado, ou 400 `label_name_invalid` quando é inválido (não sobra nada, ou a chave passaria do teto do banco). */
function cleanOrRefuse(raw: string): string {
  const name = cleanLabelName(raw);
  if (name === null) throw new BadRequestException({ code: "label_name_invalid", message: "O nome da etiqueta não pode ficar vazio nem ser longo demais." });
  return name;
}

function labelNotFound(): NotFoundException {
  return new NotFoundException({ code: "label_not_found", message: "Etiqueta não encontrada neste projeto." });
}

function nameTaken(): ConflictException {
  return new ConflictException({ code: "label_name_taken", message: "Já existe uma etiqueta com esse nome no projeto." });
}

function projectLimit(): ConflictException {
  return new ConflictException({ code: "label_limit_project", message: `O projeto já tem o máximo de ${LABELS_PER_PROJECT} etiquetas. Apague alguma antes de criar outra.` });
}

/**
 * As etiquetas do projeto, cada uma com quantos tickets a usam, em UMA consulta; ordem pelo nome (a chave, na colação do banco) e id.
 * Não confere permissão: quem chama já conferiu que vê o projeto.
 */
export async function listProjectLabels(tx: TenantClient, projectId: string): Promise<ProjectLabelView[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string; color: LabelColor; ticket_count: number }[]>`
    select pl.id::text as id, pl.name, pl.color, count(tl.ticket_id)::int as ticket_count
      from project_labels pl
      left join ticket_labels tl on tl.org_id = pl.org_id and tl.label_id = pl.id
     where pl.project_id = ${projectId}::uuid
     group by pl.org_id, pl.id
     order by pl.name_key, pl.id`;
  return rows.map((row) => ({ ...view(row), ticketCount: row.ticket_count }));
}

/** As etiquetas de um ticket, na ordem da lista do projeto (nome, id). */
export async function ticketLabelsOf(tx: TenantClient, ticketId: string): Promise<LabelView[]> {
  return (await labelsByTicket(tx, { ticketIds: [ticketId] })).get(ticketId) ?? [];
}

/**
 * As etiquetas de VÁRIOS tickets em UMA consulta (as leituras de ticket não fazem uma consulta por ticket): de todo o projeto
 * (`projectId`, a lista do mapa e a fila) ou só dos tickets de `ticketIds` (um parâmetro só, o vetor). Cada lista na ordem da lista do
 * projeto: nome (a chave, na colação do banco), depois id. Ticket sem etiqueta não entra no mapa (quem lê usa `[]`).
 */
export async function labelsByTicket(tx: TenantClient, where: { projectId: string } | { ticketIds: readonly string[] }): Promise<Map<string, LabelView[]>> {
  const byTicket = new Map<string, LabelView[]>();
  const projectId = "projectId" in where ? where.projectId : null;
  const ticketIds = "ticketIds" in where ? [...new Set(where.ticketIds)] : null;
  if (ticketIds !== null && ticketIds.length === 0) return byTicket;
  const rows = await tx.$queryRaw<(LabelRow & { ticket_id: string })[]>`
    select tl.ticket_id::text as ticket_id, pl.id::text as id, pl.name, pl.color, pl.name_key
      from ticket_labels tl
      join project_labels pl on pl.org_id = tl.org_id and pl.id = tl.label_id
     where (${projectId}::uuid is null or tl.project_id = ${projectId}::uuid)
       and (${ticketIds}::uuid[] is null or tl.ticket_id = any(${ticketIds}::uuid[]))
     order by tl.ticket_id, pl.name_key, pl.id`;
  for (const row of rows) {
    const list = byTicket.get(row.ticket_id);
    if (list) list.push(view(row));
    else byTicket.set(row.ticket_id, [view(row)]);
  }
  return byTicket;
}

/** A trava consultiva da criação de etiquetas no projeto (vem antes de qualquer trava de linha). */
export async function lockLabelCreation(tx: TenantClient, projectId: string): Promise<void> {
  await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`project-labels:${projectId}`}, 0))`;
}

async function projectLabelCount(tx: TenantClient, projectId: string): Promise<number> {
  return tx.projectLabel.count({ where: { projectId } });
}

/**
 * Cria a etiqueta se não existe nenhuma com a mesma chave (`INSERT … ON CONFLICT DO NOTHING`: um pedido paralelo que criou o mesmo nome
 * não vira erro, e a transação continua válida) e devolve a linha que ficou, a nova ou a que já estava, travada `for key share`.
 */
export async function insertOrReuse(tx: TenantClient, project: Pick<ProjectRow, "orgId" | "id">, name: string, color: LabelColor): Promise<{ row: LabelRow; created: boolean }> {
  const key = labelNameKey(name);
  const inserted = await tx.$queryRaw<LabelRow[]>`
    insert into project_labels (org_id, project_id, name, name_key, color)
    values (${project.orgId}, ${project.id}::uuid, ${name}, ${key}, ${color})
    on conflict (org_id, project_id, name_key) do nothing
    returning id::text as id, name, color, name_key`;
  if (inserted[0]) return { row: inserted[0], created: true };
  const existing = await tx.$queryRaw<LabelRow[]>`
    select id::text as id, name, color, name_key from project_labels
     where project_id = ${project.id}::uuid and name_key = ${key} for key share`;
  if (!existing[0]) throw new ConflictException({ code: "concurrent_update", message: "A etiqueta mudou enquanto o pedido era gravado. Tente de novo." });
  return { row: existing[0], created: false };
}

@Injectable()
export class LabelsService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** `GET projects/:projectId/labels`: quem vê o projeto. */
  async list(tx: TenantClient, actor: Actor, projectId: string): Promise<ProjectLabelView[]> {
    await this.findVisibleProject(tx, actor, projectId);
    return listProjectLabels(tx, projectId);
  }

  /**
   * `POST projects/:projectId/labels`: quem edita tickets do projeto. Nome que já existe (sem diferenciar maiúsculas) é 409
   * `label_name_taken` (pelo seletor do ticket, o mesmo nome reusa; aqui a pessoa pediu uma etiqueta NOVA); cor ausente = a padrão pelo nome.
   */
  async create(tx: TenantClient, principal: Principal, projectId: string, input: { name: string; color?: LabelColor | undefined }): Promise<ProjectLabelView> {
    const project = await this.findVisibleProject(tx, principal.actor, projectId);
    this.authorization.editTicket(principal.actor, projectId);
    this.requireActive(project);
    const name = cleanOrRefuse(input.name);
    await lockLabelCreation(tx, projectId);
    // O nome repetido responde como nome repetido, mesmo com o projeto no limite (a pessoa precisa saber que a etiqueta já existe).
    if (await tx.projectLabel.findFirst({ where: { projectId, nameKey: labelNameKey(name) }, select: { id: true } })) throw nameTaken();
    if ((await projectLabelCount(tx, projectId)) >= LABELS_PER_PROJECT) throw projectLimit();
    const { row, created } = await insertOrReuse(tx, project, name, input.color ?? defaultLabelColor(name));
    if (!created) throw nameTaken();
    await touchProjectVersion(tx, projectId); // ADR 0046 (decisão da fatia): toda escrita de etiqueta marca a versão.
    return { ...view(row), ticketCount: 0 };
  }

  /** `PATCH projects/:projectId/labels/:labelId`: renomear e trocar a cor, quem administra o projeto. Nome de OUTRA etiqueta: 409. */
  async update(tx: TenantClient, principal: Principal, projectId: string, labelId: string, input: { name?: string | undefined; color?: LabelColor | undefined }): Promise<ProjectLabelView> {
    const project = await this.findVisibleProject(tx, principal.actor, projectId);
    this.authorization.manageProject(principal.actor, projectId);
    this.requireActive(project);
    const name = input.name === undefined ? undefined : cleanOrRefuse(input.name);
    const current = await this.lockLabel(tx, projectId, labelId);
    const data: { name?: string; nameKey?: string; color?: LabelColor } = {};
    if (name !== undefined && name !== current.name) {
      const key = labelNameKey(name);
      if (key !== current.name_key && (await tx.projectLabel.findFirst({ where: { projectId, nameKey: key }, select: { id: true } }))) {
        throw nameTaken();
      }
      Object.assign(data, { name, nameKey: key });
    }
    if (input.color !== undefined && input.color !== current.color) data.color = input.color;
    if (Object.keys(data).length > 0) {
      await touchProjectVersion(tx, projectId);
      // Corrida com outra renomeação para o mesmo nome: a unicidade do banco decide, e a resposta é o mesmo 409.
      await orConflict("label_name_taken", "Já existe uma etiqueta com esse nome no projeto.", () =>
        tx.projectLabel.update({ where: { orgId_id: { orgId: project.orgId, id: current.id } }, data }),
      );
    }
    const [listed] = (await listProjectLabels(tx, projectId)).filter((label) => label.id === current.id);
    return listed as ProjectLabelView;
  }

  /**
   * `DELETE projects/:projectId/labels/:labelId`: quem administra o projeto. Tira a etiqueta de todos os tickets (cascata) e devolve
   * quantos a perderam. NÃO grava evento por ticket (500 tickets não viram 500 eventos): grava UM evento de projeto
   * `project.label_deleted { name, tickets }`. As origens do Linear ficam marcadas como "removida aqui" (a etiqueta não renasce).
   */
  async remove(tx: TenantClient, principal: Principal, projectId: string, labelId: string): Promise<{ ticketsAffected: number }> {
    const project = await this.findVisibleProject(tx, principal.actor, projectId);
    this.authorization.manageProject(principal.actor, projectId);
    this.requireActive(project);
    const label = await this.lockLabel(tx, projectId, labelId);
    const ticketsAffected = await tx.ticketLabel.count({ where: { labelId: label.id } });
    await touchProjectVersion(tx, projectId);
    await forgetDeletedLabelOrigins(tx, label.id);
    await tx.projectLabel.delete({ where: { orgId_id: { orgId: project.orgId, id: label.id } } });
    await this.activity.record(tx, principal, {
      kind: "project.label_deleted",
      subjectType: "project",
      subjectId: projectId,
      payload: { name: label.name, tickets: ticketsAffected },
    });
    return { ticketsAffected };
  }

  /**
   * `POST tickets/:id/labels` (e o MCP): as conferências da rota, na ordem de sempre (ticket visível 404, editar 403, projeto arquivado
   * 409), e depois `applyTicketLabels`. Devolve as etiquetas do ticket depois da mudança.
   */
  async changeTicketLabels(tx: TenantClient, principal: Principal, ticketId: string, change: { add: readonly LabelRef[]; remove: readonly string[] }): Promise<TicketLabelsChange> {
    const ticket = await tx.ticket.findFirst({ where: { id: ticketId }, select: { id: true, number: true, projectId: true } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    return this.applyTicketLabels(tx, principal, project, ticket, change);
  }

  /**
   * Põe e tira etiquetas de um ticket, SEM conferir permissão nem projeto arquivado (quem chama confere). `add` aceita etiqueta do projeto
   * pelo id ou um nome: o nome é limpo pelo domínio (vazio = 400 `label_name_invalid`), o que já existe com a mesma chave é reusado e o novo
   * é criado com `defaultLabelColor`. Id que não é etiqueta deste projeto (inexistente, de outro projeto, apagada no meio): 404
   * `label_not_found`. Limites sobre o conjunto FINAL (trocar no limite vale): 409 `label_limit_ticket` (20) e `label_limit_project` (200),
   * antes de criar qualquer etiqueta. Idempotente: pôr a que já tem e tirar a que não tem não muda nada. Com mudança: UM evento
   * `ticket.labels_changed { key, added, removed }` (nome da época), toque na versão do projeto e, nas tiradas, a origem do Linear marcada
   * como "removida aqui" (`options.markRemovedHere`). Sem notificação.
   */
  async applyTicketLabels(
    tx: TenantClient,
    principal: Principal,
    project: ProjectRow,
    ticket: { id: string; number: number },
    change: { add: readonly LabelRef[]; remove: readonly string[] },
    options: ApplyTicketLabelsOptions = {},
  ): Promise<TicketLabelsChange> {
    const names = change.add.flatMap((item) => ("name" in item ? [cleanOrRefuse(item.name)] : []));
    if (names.length > 0) await lockLabelCreation(tx, project.id);
    await tx.$queryRaw`select 1 from tickets where org_id = ${project.orgId} and id = ${ticket.id}::uuid for update`;

    const ids = [...new Set([...change.add.flatMap((item) => ("labelId" in item ? [item.labelId.toLowerCase()] : [])), ...change.remove.map((id) => id.toLowerCase())])];
    const byId = new Map<string, LabelRow>();
    if (ids.length > 0) {
      const found = await tx.$queryRaw<LabelRow[]>`
        select id::text as id, name, color, name_key from project_labels
         where project_id = ${project.id}::uuid and id = any(${ids}::uuid[]) for key share`;
      for (const row of found) byId.set(row.id, row);
      if (found.length !== ids.length) throw labelNotFound();
    }
    const keys = [...new Set(names.map(labelNameKey))];
    const byKey = new Map<string, LabelRow>();
    if (keys.length > 0) {
      const found = await tx.$queryRaw<LabelRow[]>`
        select id::text as id, name, color, name_key from project_labels
         where project_id = ${project.id}::uuid and name_key = any(${keys}::text[]) for key share`;
      for (const row of found) byKey.set(row.name_key, row);
    }

    const current = new Set((await tx.ticketLabel.findMany({ where: { ticketId: ticket.id }, select: { labelId: true } })).map((row) => row.labelId));
    // O que entra, na ordem do pedido e sem repetir: etiquetas que já existem (por id ou pela chave do nome) e nomes a criar.
    const adds: ({ kind: "existing"; row: LabelRow } | { kind: "new"; name: string })[] = [];
    const seen = new Set<string>();
    for (const item of change.add) {
      if ("labelId" in item) {
        const row = byId.get(item.labelId.toLowerCase()) as LabelRow;
        if (!seen.has(row.id)) adds.push({ kind: "existing", row });
        seen.add(row.id);
        continue;
      }
      const name = cleanLabelName(item.name) as string;
      const key = labelNameKey(name);
      const row = byKey.get(key);
      if (row) {
        if (!seen.has(row.id)) adds.push({ kind: "existing", row });
        seen.add(row.id);
      } else if (!seen.has(`key:${key}`)) {
        adds.push({ kind: "new", name });
        seen.add(`key:${key}`);
      }
    }
    const toAdd = adds.filter((item) => item.kind === "new" || !current.has(item.row.id));
    const toRemove = [...new Set(change.remove.map((id) => id.toLowerCase()))].map((id) => byId.get(id) as LabelRow).filter((row) => current.has(row.id));
    if (toAdd.length === 0 && toRemove.length === 0) return { added: [], removed: [], labels: await ticketLabelsOf(tx, ticket.id) };

    if (current.size - toRemove.length + toAdd.length > LABELS_PER_TICKET) {
      throw new ConflictException({ code: "label_limit_ticket", message: `Um ticket pode ter no máximo ${LABELS_PER_TICKET} etiquetas. Tire alguma antes de pôr outra.` });
    }
    const creating = toAdd.filter((item) => item.kind === "new");
    if (creating.length > 0 && (await projectLabelCount(tx, project.id)) + creating.length > LABELS_PER_PROJECT) throw projectLimit();

    const added: LabelRow[] = [];
    for (const item of toAdd) {
      if (item.kind === "existing") {
        added.push(item.row);
        continue;
      }
      // Criada por outro pedido entre a leitura e aqui (fora da trava consultiva, como a sincronização): reusa, e pode já estar no ticket.
      const { row } = await insertOrReuse(tx, project, item.name, defaultLabelColor(item.name));
      if (!current.has(row.id) && !added.some((other) => other.id === row.id)) added.push(row);
    }

    // O nome pedido pode ter virado, em paralelo, uma etiqueta que o ticket já tem (renomeada para ele): sem mudança de fato, sem evento
    // vazio e sem subir a versão.
    if (added.length === 0 && toRemove.length === 0) return { added: [], removed: [], labels: await ticketLabelsOf(tx, ticket.id) };
    await touchProjectVersion(tx, project.id); // ADR 0046: as etiquetas entram no resumo do ticket.
    if (added.length > 0) {
      await tx.ticketLabel.createMany({ data: added.map((row) => ({ orgId: project.orgId, projectId: project.id, ticketId: ticket.id, labelId: row.id })) });
    }
    if (toRemove.length > 0) {
      await tx.ticketLabel.deleteMany({ where: { ticketId: ticket.id, labelId: { in: toRemove.map((row) => row.id) } } });
      if (options.markRemovedHere !== false) await forgetTicketLabelOrigins(tx, ticket.id, toRemove.map((row) => row.id));
    }
    const item = (row: LabelRow): LabelChangeItem => ({ id: row.id, name: row.name });
    const result = { added: added.map(item), removed: toRemove.map(item) };
    await this.activity.record(tx, principal, {
      kind: "ticket.labels_changed",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, ...result, ...((options.event ?? {}) as Record<string, string | number | boolean | null>) },
    });
    return { ...result, labels: await ticketLabelsOf(tx, ticket.id) };
  }

  /** A linha da etiqueta, travada (`for update`) até o fim da transação; inexistente ou de outro projeto: 404. */
  private async lockLabel(tx: TenantClient, projectId: string, labelId: string): Promise<LabelRow> {
    const rows = await tx.$queryRaw<LabelRow[]>`
      select id::text as id, name, color, name_key from project_labels
       where project_id = ${projectId}::uuid and id = ${labelId}::uuid for update`;
    if (!rows[0]) throw labelNotFound();
    return rows[0];
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404. */
  private async findVisibleProject(tx: TenantClient, actor: Actor, projectId: string) {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  private requireActive(project: ProjectRow): void {
    if (project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
  }
}

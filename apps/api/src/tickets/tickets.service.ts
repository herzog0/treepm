import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { descriptionExcerpt, isFinished, mentionedKeys, ticketProgress, ticketsToReopen } from "@treepm/domain";
import type { TicketNode, TicketStatus } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { ticketDetailSchema, ticketStatusSchema } from "./tickets.schema.js";
import type { TicketDetail, TicketSummary } from "./tickets.schema.js";

export type ProjectRow = {
  orgId: string;
  id: string;
  key: string;
  visibility: "organization" | "private";
  archivedAt: Date | null;
};

export type TicketRow = {
  id: string;
  projectId: string;
  number: number;
  parentId: string | null;
  title: string;
  description: string;
  status: string;
  assignees: { personId: string }[];
};
export type TicketDetailRow = TicketRow & {
  createdByPersonId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Quanto a chave do projeto é seguida de "-" no texto: filtro grosso do banco; quem decide é `mentionedKeys`. */
const MANY = 20;

export type MentionSource = { id: string; number: number; description: string };
export type MentionCounts = { created: number; removed: number };

export type Progress = ReturnType<typeof ticketProgress>;

export function statusOf(row: { status: string }): TicketStatus {
  return ticketStatusSchema.parse(row.status);
}

/** Os nós do projeto no formato do cálculo de progresso. */
export function toNodes(rows: readonly { id: string; parentId: string | null; status: string }[]): TicketNode[] {
  return rows.map((row): TicketNode => ({ id: row.id, parentId: row.parentId, status: statusOf(row) }));
}

export function toSummary(project: Pick<ProjectRow, "key">, row: TicketRow, progress: Progress): TicketSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    key: `${project.key}-${row.number}`,
    parentId: row.parentId,
    title: row.title,
    descriptionExcerpt: descriptionExcerpt(row.description),
    status: statusOf(row),
    // Ticket com filhos: progresso sobre todos os descendentes (ADR 0034); sem filhos: null.
    progress: progress.get(row.id) ?? null,
    assigneeIds: row.assignees.map((assignee) => assignee.personId).sort(),
  };
}

export type MentionedByRow = { number: number; id: string; title: string; status: string };

export function toDetail(project: Pick<ProjectRow, "key">, row: TicketDetailRow, progress: Progress, mentionedBy: readonly MentionedByRow[] = []): TicketDetail {
  return parseOutput(ticketDetailSchema, {
    ...toSummary(project, row, progress),
    description: row.description,
    mentionedBy: mentionedBy.map((from) => ({ id: from.id, key: `${project.key}-${from.number}`, title: from.title, status: from.status })),
    createdByPersonId: row.createdByPersonId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Regras de ticket compartilhadas pelo controlador de tickets e pela criação vinda da conversa com a IA (ADR 0029). */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** Pai de outro projeto, de outra organização ou inexistente: 404. Qualquer ticket do projeto pode ser pai (ADR 0034). */
  async requireParent(tx: TenantClient, projectId: string, parentId: string): Promise<void> {
    const parent = await tx.ticket.findFirst({ where: { id: parentId, projectId }, select: { id: true } });
    if (!parent) throw new NotFoundException("Ticket pai não encontrado.");
  }

  /**
   * Reabertura do pai concluído (ADR 0034): `parentId` acaba de ganhar (ou vai ganhar, nesta transação) um filho direto
   * aberto. Trava de baixo para cima (`for update`, um ancestral por vez, parando no primeiro que não está `done`) e
   * reabre para `todo` os que a função pura `ticketsToReopen` indicar, gravando um evento por ticket reaberto com
   * `automatic: true` e `causedBy` (a chave do ticket que causou). Deve rodar ANTES de gravar o filho: a chave estrangeira
   * do pai trava a linha do pai, e travar na ordem contrária daria impasse com "concluir".
   */
  async reopenAncestors(tx: TenantClient, principal: Principal, project: ProjectRow, parentId: string | null, causedBy: string): Promise<void> {
    const parents = new Map<string, string | null>();
    const statuses = new Map<string, TicketStatus>();
    const numbers = new Map<string, number>();
    for (let cursor = parentId; cursor !== null && !parents.has(cursor); ) {
      const rows = await tx.$queryRaw<{ id: string; parent_id: string | null; status: string; number: number }[]>`
        select id, parent_id, status, number from tickets where id = ${cursor}::uuid for update`;
      const row = rows[0];
      if (!row) break;
      parents.set(row.id, row.parent_id);
      statuses.set(row.id, ticketStatusSchema.parse(row.status));
      numbers.set(row.id, row.number);
      if (row.status !== "done") break;
      cursor = row.parent_id;
    }
    for (const id of ticketsToReopen(parents, statuses, parentId)) {
      await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id } }, data: { status: "todo" } });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: id,
        payload: {
          key: `${project.key}-${numbers.get(id)}`,
          fields: ["status"],
          status: { from: "done", to: "todo" },
          automatic: true,
          causedBy,
        },
      });
    }
  }

  /** A pessoa precisa existir, estar ativa e já enxergar o projeto; atribuir nunca concede acesso. */
  async requireAssignable(tx: TenantClient, project: ProjectRow, personId: string): Promise<void> {
    const person = await tx.person.findFirst({ where: { id: personId } });
    if (!person) throw new NotFoundException("Pessoa não encontrada.");
    if (!person.active) {
      throw new ConflictException({ code: "person_inactive", message: "A pessoa não está mais na organização." });
    }
    const personActor = await this.authorization.loadActor(tx, person.id, person.clerkRole);
    if (!this.authorization.canView(personActor, project)) {
      throw new ConflictException({
        code: "person_without_project_access",
        message: "A pessoa não tem acesso ao projeto; conceda um papel antes de atribuir.",
      });
    }
  }

  /**
   * Reserva `count` números consecutivos e devolve o primeiro. O UPDATE trava a linha do projeto até o fim da
   * transação, o que serializa criações simultâneas; números nunca são reutilizados.
   */
  async allocateNumbers(tx: TenantClient, project: ProjectRow, count: number): Promise<number> {
    const updated = await tx.project.update({
      where: { orgId_id: { orgId: project.orgId, id: project.id } },
      data: { nextTicketNumber: { increment: count } },
      select: { nextTicketNumber: true },
    });
    return updated.nextTicketNumber - count;
  }

  async detail(tx: TenantClient, project: ProjectRow, id: string): Promise<TicketDetail> {
    const [row, nodes, mentions] = await Promise.all([
      tx.ticket.findFirstOrThrow({ where: { id }, include: { assignees: { select: { personId: true } } } }),
      tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, parentId: true, status: true } }),
      tx.ticketRelation.findMany({
        where: { toTicketId: id, kind: "mentions" },
        select: { from: { select: { id: true, number: true, title: true, status: true } } },
      }),
    ]);
    const progress = ticketProgress(toNodes(nodes));
    const mentionedBy = mentions.map((relation) => relation.from).sort((a, b) => a.number - b.number);
    return toDetail(project, row, progress, mentionedBy);
  }

  /**
   * A regra única de "menciona" (ADR 0037): os números de ticket do projeto que a descrição cita (pela mesma `mentionedKeys`
   * que a web usa), sem o próprio ticket. Não sabe se o número existe.
   */
  private mentionedNumbers(project: Pick<ProjectRow, "key">, source: MentionSource): number[] {
    const prefix = `${project.key}-`;
    const numbers = mentionedKeys(source.description)
      .filter((key) => key.startsWith(prefix))
      .map((key) => Number(key.slice(prefix.length)))
      .filter((number) => Number.isSafeInteger(number) && number !== source.number);
    return [...new Set(numbers)];
  }

  /**
   * Faz as ligações `mentions` que saem de cada fonte serem exatamente as da sua descrição (ADR 0037): apaga as que sobraram
   * e cria as que faltam, sem recriar as que continuam. Só lê e mexe em `kind = 'mentions'`; `depends_on` nunca é tocada.
   * Faz uma consulta por etapa, não uma por ticket.
   */
  async reconcileMentions(tx: TenantClient, project: ProjectRow, sources: readonly MentionSource[]): Promise<MentionCounts> {
    if (sources.length === 0) return { created: 0, removed: 0 };
    const wanted = new Map(sources.map((source) => [source.id, this.mentionedNumbers(project, source)]));
    const allNumbers = [...new Set([...wanted.values()].flat())];
    const idOf = new Map<number, string>();
    if (allNumbers.length > 0) {
      const found = await tx.ticket.findMany({ where: { projectId: project.id, number: { in: allNumbers } }, select: { id: true, number: true } });
      for (const row of found) idOf.set(row.number, row.id);
    }
    const existing = await tx.ticketRelation.findMany({
      where: { fromTicketId: { in: sources.map((source) => source.id) }, kind: "mentions" },
      select: { id: true, fromTicketId: true, toTicketId: true },
    });
    const wantedPairs = new Set<string>();
    for (const [from, numbers] of wanted) for (const number of numbers) if (idOf.has(number)) wantedPairs.add(`${from}>${idOf.get(number)}`);
    const have = new Set(existing.map((row) => `${row.fromTicketId}>${row.toTicketId}`));
    const stale = existing.filter((row) => !wantedPairs.has(`${row.fromTicketId}>${row.toTicketId}`)).map((row) => row.id);
    const missing = [...wantedPairs].filter((pair) => !have.has(pair)).map((pair) => pair.split(">") as [string, string]);
    if (stale.length > 0) await tx.ticketRelation.deleteMany({ where: { id: { in: stale } } });
    let created = 0;
    if (missing.length > 0) {
      // As ligações das candidatas não estão travadas: outra transação pode ter criado a mesma entre a leitura e aqui.
      const result = await tx.ticketRelation.createMany({
        data: missing.map(([fromTicketId, toTicketId]) => ({ orgId: project.orgId, projectId: project.id, fromTicketId, toTicketId, kind: "mentions" })),
        skipDuplicates: true,
      });
      created = result.count;
    }
    return { created, removed: stale.length };
  }

  /** Uma descrição acaba de ser gravada (criação ou alteração): refaz as ligações que saem deste ticket. */
  async syncMentions(tx: TenantClient, project: ProjectRow, ticket: { id: string; number: number }, description: string): Promise<void> {
    await this.reconcileMentions(tx, project, [{ id: ticket.id, number: ticket.number, description }]);
  }

  /**
   * Tickets com os números `numbers` acabam de ser criados (um ou vários, ainda sem as ligações deles): as descrições do
   * projeto escritas antes que já citam essas chaves passam a ter a ligação. O banco só acha candidatas (texto que contém a
   * chave, ou, para muitos números de uma vez, que contém a chave do projeto com hífen); quem decide é `mentionedKeys`.
   * Uma consulta só, não uma por ticket novo.
   */
  async backfillMentionsTo(tx: TenantClient, project: ProjectRow, created: readonly { id: string; number: number }[]): Promise<void> {
    if (created.length === 0) return;
    const newIds = new Set(created.map((row) => row.id));
    const prefix = `${project.key}-`;
    const candidates = await tx.ticket.findMany({
      where: {
        projectId: project.id,
        id: { notIn: [...newIds] },
        ...(created.length <= MANY
          ? { OR: created.map((row) => ({ description: { contains: `${prefix}${row.number}` } })) }
          : { description: { contains: prefix } }),
      },
      select: { id: true, number: true, description: true },
    });
    const newNumbers = new Set(created.map((row) => row.number));
    const sources = candidates.filter((candidate) => this.mentionedNumbers(project, candidate).some((number) => newNumbers.has(number)));
    await this.reconcileMentions(tx, project, sources);
  }

  /** Refaz as ligações `mentions` de todos os tickets do projeto (ferramenta local) e devolve as contagens. */
  async rebuildMentions(tx: TenantClient, project: ProjectRow): Promise<{ read: number } & MentionCounts> {
    const sources = await tx.ticket.findMany({ where: { projectId: project.id }, select: { id: true, number: true, description: true } });
    return { read: sources.length, ...(await this.reconcileMentions(tx, project, sources)) };
  }

  /**
   * Cria um ticket depois de as permissões e o projeto terem sido conferidos por quem chama: confere o pai e
   * os responsáveis, reserva o número, grava o ticket e o `ticket.created`. `extraPayload` acrescenta campos ao
   * evento (por exemplo, a origem "assistente").
   */
  async create(
    tx: TenantClient,
    principal: Principal,
    project: ProjectRow,
    input: {
      title: string;
      description: string;
      parentId: string | null;
      status: TicketStatus;
      assigneeIds: string[];
    },
    extraPayload: Record<string, string> = {},
  ): Promise<TicketDetail> {
    if (input.parentId) await this.requireParent(tx, project.id, input.parentId);
    const assigneeIds = [...new Set(input.assigneeIds)];
    for (const personId of assigneeIds) await this.requireAssignable(tx, project, personId);

    const number = await this.allocateNumbers(tx, project, 1);
    if (input.parentId && !isFinished(input.status)) {
      await this.reopenAncestors(tx, principal, project, input.parentId, `${project.key}-${number}`);
    }
    const created = await tx.ticket.create({
      data: {
        orgId: project.orgId,
        projectId: project.id,
        number,
        parentId: input.parentId,
        title: input.title,
        description: input.description,
        status: input.status,
        createdByPersonId: principal.person.id,
      },
    });
    await this.syncMentions(tx, project, created, created.description);
    await this.backfillMentionsTo(tx, project, [created]);
    if (assigneeIds.length > 0) {
      await tx.ticketAssignee.createMany({
        data: assigneeIds.map((personId) => ({ orgId: project.orgId, ticketId: created.id, personId })),
      });
    }
    await this.activity.record(tx, principal, {
      kind: "ticket.created",
      subjectType: "ticket",
      subjectId: created.id,
      payload: {
        key: `${project.key}-${number}`,
        title: created.title,
        parentId: created.parentId,
        status: created.status,
        assigneeIds: assigneeIds.sort(),
        ...extraPayload,
      },
    });
    return this.detail(tx, project, created.id);
  }

  /**
   * Confirmar uma proposta de pai novo (ADR 0031, 0034), dentro da transação da rota: confere de novo que cada ticket
   * ainda é filho de `parentId` e continua sem filhos (409 `grouping_changed`, sem criar nem mover nada), cria o
   * ticket pai (um ticket comum, situação `todo`) e move os tickets para ele. Devolve o id do pai novo, que passa a
   * ser o pai do ticket novo.
   */
  async createParentAndMove(
    tx: TenantClient,
    principal: Principal,
    project: ProjectRow,
    parentId: string | null,
    group: { title: string; description: string; ticketIds: string[] },
    origin: Record<string, string>,
  ): Promise<string> {
    if (parentId) await this.requireParent(tx, project.id, parentId);
    // Trava os tickets até o fim da transação: ninguém os move nem os remove entre a conferência e a mudança.
    await tx.$queryRaw`select id from tickets where id = any(${group.ticketIds}::uuid[]) order by id for update`;
    const found = await tx.ticket.findMany({
      where: { id: { in: group.ticketIds }, projectId: project.id, parentId },
      select: { id: true, number: true, parentId: true },
    });
    const withChildren = found.length === 0 ? 0 : await tx.ticket.count({ where: { parentId: { in: found.map((row) => row.id) } } });
    if (found.length !== group.ticketIds.length || withChildren > 0) {
      throw new ConflictException({
        code: "grouping_changed",
        message: "Algum desses tickets mudou de lugar. Procure de novo.",
      });
    }
    const created = await this.create(
      tx,
      principal,
      project,
      { title: group.title, description: group.description, parentId, status: "todo", assigneeIds: [] },
      origin,
    );
    for (const moved of [...found].sort((a, b) => a.number - b.number)) {
      await tx.ticket.update({
        where: { orgId_id: { orgId: project.orgId, id: moved.id } },
        data: { parentId: created.id },
      });
      await this.activity.record(tx, principal, {
        kind: "ticket.updated",
        subjectType: "ticket",
        subjectId: moved.id,
        payload: {
          key: `${project.key}-${moved.number}`,
          fields: ["parentId"],
          parentId: { from: parentId, to: created.id },
          ...origin,
        },
      });
    }
    return created.id;
  }
}

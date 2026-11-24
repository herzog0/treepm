import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { canEditComment, canRemoveComment } from "@treepm/domain";
import type { Actor } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ACCESS_TOKEN_CLOCK } from "../access-tokens/clock.js";
import type { AccessTokenClock } from "../access-tokens/clock.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { activityEntrySchema } from "./ticket-activity.schema.js";
import type { CommentEntry } from "./ticket-activity.schema.js";
import type { ProjectRow } from "./tickets.service.js";

/** Quem está lendo: a pessoa e os papéis dela na transação atual. */
export type Viewer = { personId: string; actor: Actor };
type Author = { id: string; displayName: string; avatarUrl: string | null };
type CommentRow = {
  id: string;
  authorPersonId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  removedAt: Date | null;
  /** A contribuição (área) do comentário, quando ainda existe (ADR 0041). */
  contribution: { id: string; area: { name: string } } | null;
  /** O nome da área que a contribuição removida tinha; nulo enquanto a contribuição existe. */
  areaName: string | null;
  /** `mcp` quando o comentário veio de uma chamada MCP (ADR 0043). */
  via: string | null;
};

/** `canEdit` e `canRemove` de um comentário para quem lê: comentário removido e projeto arquivado não têm ação. */
export function commentRights(viewer: Viewer, project: Pick<ProjectRow, "id" | "archivedAt">, comment: Pick<CommentRow, "authorPersonId" | "removedAt">): { canEdit: boolean; canRemove: boolean } {
  const open = comment.removedAt === null && project.archivedAt === null;
  return {
    canEdit: open && canEditComment(viewer.actor, project.id, comment.authorPersonId, viewer.personId),
    canRemove: open && canRemoveComment(viewer.actor, project.id, comment.authorPersonId, viewer.personId),
  };
}

/** A área do comentário: a contribuição de hoje, o nome guardado quando ela foi removida, ou `null` (comentário do ticket). */
export function commentArea(row: Pick<CommentRow, "contribution" | "areaName">): { id: string | null; name: string } | null {
  if (row.contribution) return { id: row.contribution.id, name: row.contribution.area.name };
  return row.areaName === null ? null : { id: null, name: row.areaName };
}

/** A entrada de atividade de um comentário; o corpo de um removido nunca sai. */
export function toCommentEntry(row: CommentRow, author: Author | null, rights: { canEdit: boolean; canRemove: boolean }): CommentEntry {
  const removed = row.removedAt !== null;
  return {
    id: row.id,
    type: "comment",
    occurredAt: row.createdAt.toISOString(),
    actor: author,
    body: removed ? null : row.body,
    area: commentArea(row),
    ...(row.via === "mcp" ? { via: "mcp" as const } : {}),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    removed,
    ...rights,
  };
}

/** O que ler de um comentário; a área vem na mesma consulta (o nome da área fica na contribuição). */
export const commentSelect = {
  id: true,
  authorPersonId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  removedAt: true,
  areaName: true,
  via: true,
  contribution: { select: { id: true, area: { select: { name: true } } } },
} as const;
const select = commentSelect;
/** Janela em que o mesmo `requestId` do mesmo token vale como repetição (ADR 0043). */
const REPEAT_WINDOW_MS = 10 * 60_000;

/**
 * Comentar, editar e remover (ADR 0040, fatia 2). O corpo nunca vai para o evento de atividade nem para o log.
 * Nada aqui grava em `ticket_relations`: a ligação "menciona" é derivada só da descrição (ADR 0037).
 */
@Injectable()
export class TicketCommentsService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(ACCESS_TOKEN_CLOCK) private readonly clock: AccessTokenClock,
  ) {}

  /**
   * `requestId` (só MCP, ADR 0043): uma segunda chamada do mesmo token, no mesmo ticket, com o mesmo `requestId`, em até 10
   * minutos, devolve o comentário que já existe, sem criar outro e sem novo evento. Serializa por uma trava de aviso da transação.
   */
  async add(tx: TenantClient, principal: Principal, ticketId: string, body: string, contributionId?: string, requestId?: string): Promise<CommentEntry> {
    const { project, ticket } = await this.visibleTicket(tx, principal.actor, ticketId);
    this.authorization.commentTicket(principal.actor, project.id);
    // Comentário por área continua exigindo participar da contribuição (ADR 0040, adendo): o leitor comenta só no ticket.
    if (contributionId !== undefined) this.authorization.editContributions(principal.actor, project.id);
    this.requireActive(project);
    // Contribuição de outro ticket, inexistente ou de outra organização (RLS): o mesmo 404. O banco também garante
    // que a contribuição é do mesmo ticket (chave estrangeira composta).
    if (contributionId !== undefined && !(await tx.ticketContribution.findFirst({ where: { id: contributionId, ticketId }, select: { id: true } }))) {
      throw new NotFoundException("Contribuição não encontrada.");
    }
    const tokenId = principal.via?.kind === "mcp" ? principal.via.tokenId : undefined;
    const request = requestId !== undefined && tokenId !== undefined ? { requestTokenId: tokenId, requestId } : null;
    if (request) {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`comment-request:${ticketId}:${request.requestTokenId}:${request.requestId}`}, 0))`;
      const again = await tx.ticketComment.findFirst({
        // Comentário removido nesse meio-tempo não vale como "o mesmo": a repetição cria um novo.
        where: { ticketId, ...request, removedAt: null, createdAt: { gte: new Date(this.clock.now() - REPEAT_WINDOW_MS) } },
        orderBy: { createdAt: "desc" },
        select,
      });
      if (again) {
        // O mesmo requestId com outro texto não é uma repetição: erro claro, nada devolvido nem gravado.
        if (again.body !== body) throw new ConflictException({ code: "request_id_reused", message: "O requestId já foi usado com outro texto." });
        return this.entry(principal, project, again);
      }
    }
    const row = await tx.ticketComment.create({
      data: { orgId: project.orgId, projectId: project.id, ticketId, authorPersonId: principal.person.id, body, ...(request ?? {}), ...(contributionId === undefined ? {} : { contributionId }), ...(principal.via?.kind === "mcp" ? { via: "mcp" } : principal.via?.kind === "act-as" ? { via: "act-as", viaPersonId: principal.via.realPersonId } : {}) },
      select,
    });
    await this.activity.record(tx, principal, {
      kind: "ticket.comment_added",
      subjectType: "ticket",
      subjectId: ticketId,
      payload: { key: `${project.key}-${ticket.number}`, commentId: row.id, ...this.contributionPart(row) },
    });
    return this.entry(principal, project, row);
  }

  async edit(tx: TenantClient, principal: Principal, commentId: string, body: string): Promise<CommentEntry> {
    const { project, ticket, comment } = await this.visibleComment(tx, principal.actor, commentId);
    this.authorization.editComment(principal.actor, project.id, comment.authorPersonId, principal.person.id);
    this.requireActive(project);
    if (comment.removedAt !== null) throw this.removed();
    if (comment.body === body) return this.entry(principal, project, comment);
    // A guarda `removedAt: null` fecha a corrida com uma remoção concorrente: se perdeu, nada é gravado.
    const editedAt = new Date();
    const changed = await tx.ticketComment.updateMany({ where: { id: commentId, removedAt: null }, data: { body, editedAt } });
    if (changed.count === 0) throw this.removed();
    await this.activity.record(tx, principal, {
      kind: "ticket.comment_edited",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, commentId, ...this.contributionPart(comment) },
    });
    return this.entry(principal, project, { ...comment, body, editedAt });
  }

  async remove(tx: TenantClient, principal: Principal, commentId: string): Promise<void> {
    const { project, ticket, comment } = await this.visibleComment(tx, principal.actor, commentId);
    this.authorization.removeComment(principal.actor, project.id, comment.authorPersonId, principal.person.id);
    this.requireActive(project);
    if (comment.removedAt !== null) return;
    // O corpo some na mesma gravação (o banco exige: removido implica corpo vazio). Repetir é inócuo: só quem
    // ganha a corrida (`removedAt: null`) grava o evento.
    const gone = await tx.ticketComment.updateMany({
      where: { id: commentId, removedAt: null },
      data: { body: "", removedAt: new Date(), removedByPersonId: principal.person.id },
    });
    if (gone.count === 0) return;
    await this.activity.record(tx, principal, {
      kind: "ticket.comment_removed",
      subjectType: "ticket",
      subjectId: ticket.id,
      payload: { key: `${project.key}-${ticket.number}`, commentId, ...this.contributionPart(comment) },
    });
  }

  /** O id da contribuição no evento, quando o comentário é de uma área. Nunca o corpo nem o nome. */
  private contributionPart(row: Pick<CommentRow, "contribution">): { contributionId?: string } {
    return row.contribution ? { contributionId: row.contribution.id } : {};
  }

  private entry(principal: Principal, project: ProjectRow, row: CommentRow): CommentEntry {
    const author = { id: principal.person.id, displayName: principal.person.displayName, avatarUrl: principal.person.avatarUrl };
    const viewer = { personId: principal.person.id, actor: principal.actor };
    return parseOutput(activityEntrySchema, toCommentEntry(row, author, commentRights(viewer, project, row))) as CommentEntry;
  }

  /** Inexistente, de outra organização (RLS) ou de projeto privado sem papel: todos viram o mesmo 404. */
  private async visibleTicket(tx: TenantClient, actor: Actor, id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id }, select: { id: true, projectId: true, number: true } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  private async visibleComment(tx: TenantClient, actor: Actor, id: string) {
    const comment = await tx.ticketComment.findFirst({ where: { id }, select: { ...select, ticketId: true } });
    if (!comment) throw new NotFoundException("Comentário não encontrado.");
    try {
      const { project, ticket } = await this.visibleTicket(tx, actor, comment.ticketId);
      return { project, ticket, comment };
    } catch {
      throw new NotFoundException("Comentário não encontrado.");
    }
  }

  private requireActive(project: ProjectRow): void {
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
  }

  private removed(): ConflictException {
    return new ConflictException({ code: "comment_removed", message: "O comentário foi removido." });
  }
}

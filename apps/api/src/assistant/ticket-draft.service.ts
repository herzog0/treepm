import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import type { ProjectRow } from "../tickets/tickets.service.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ConversationProvider, ConversationTurn, DraftChild } from "./ports.js";

/** Teto dos títulos de agrupadores que vão ao Claude em cada turno (ADR 0033). */
const MAX_GROUP_TITLES = 30;

export type ConversationRow = {
  orgId: string;
  id: string;
  projectId: string;
  authorPersonId: string;
  status: string;
  draftTitle: string | null;
  draftDescription: string | null;
  draftChildren: unknown;
  draftIdea: boolean;
  ready: boolean;
  createdTicketId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Os filhos guardados do rascunho (JSON validado pelo banco e por quem grava); ausente = nenhum. */
export const childrenOf = (row: { draftChildren: unknown }): DraftChild[] =>
  Array.isArray(row.draftChildren) ? (row.draftChildren as DraftChild[]).map(({ title, description }) => ({ title, description })) : [];

/** Só o hash do rascunho (título, descrição, filhos e se é ideia): diz se a procura guardada ainda vale para o rascunho de agora; nunca guarda o texto. */
export const draftMarkOf = (row: Pick<ConversationRow, "draftTitle" | "draftDescription" | "draftChildren" | "draftIdea">): string =>
  createHash("sha256").update(JSON.stringify([row.draftTitle, row.draftDescription ?? "", childrenOf(row), row.draftIdea])).digest("hex").slice(0, 16);

/** Qualquer ticket do projeto da conversa serve de escopo (ADR 0034); de outro projeto ou organização (pela RLS): o mesmo 404. */
export function requireScope(scope: unknown): void {
  if (!scope) throw new NotFoundException("Ticket de escopo não encontrado.");
}

/**
 * As peças da conversa de novo ticket (ADR 0029) que mais de um caminho usa: a rota `POST projects/:id/ticket-conversations` e a
 * thread de criação das conversas (ADR 0056, fatia 3) abrem a conversa pelo MESMO código, para o rascunho nascer igual nos dois.
 */
@Injectable()
export class TicketDraftService {
  private readonly logger = new Logger("TicketConversations");

  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  async findVisibleProject(tx: TenantClient, { actor }: Principal, projectId: string): Promise<ProjectRow> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  /** Visível (404), pode criar ticket (403) e não arquivado (409). */
  async requireWritableProject(tx: TenantClient, principal: Principal, projectId: string): Promise<ProjectRow> {
    const project = await this.findVisibleProject(tx, principal, projectId);
    this.authorization.createTicket(principal.actor, projectId);
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
    return project;
  }

  /**
   * Os títulos dos filhos que têm filhos do lugar da procura (ADR 0033, 0034): filhos diretos do escopo, ou da raiz do
   * projeto sem escopo; no máximo 30, na ordem do número. Confere o escopo como a procura. Só títulos, nenhum id.
   */
  async scopeGroupTitles(tx: TenantClient, projectId: string, scopeId: string | null | undefined): Promise<string[]> {
    if (scopeId) {
      requireScope(await tx.ticket.findFirst({ where: { id: scopeId, projectId }, select: { id: true } }));
    }
    const rows = await tx.ticket.findMany({
      where: { projectId, parentId: scopeId ?? null, children: { some: {} } },
      orderBy: { number: "asc" },
      take: MAX_GROUP_TITLES,
      select: { title: true },
    });
    return rows.map((row) => row.title);
  }

  async ask(provider: ConversationProvider, input: Parameters<ConversationProvider["turn"]>[0]): Promise<ConversationTurn> {
    try {
      return await provider.turn(input);
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
  }

  /** Grava a conversa nova com a primeira troca (a mensagem da pessoa e a resposta do assistente) e o rascunho que veio dela. */
  async create(tx: TenantClient, principal: Principal, project: ProjectRow, message: string, turn: ConversationTurn): Promise<ConversationRow> {
    const created = await tx.ticketConversation.create({
      data: {
        orgId: project.orgId,
        projectId: project.id,
        authorPersonId: principal.person.id,
        draftTitle: turn.draft?.title ?? null,
        draftDescription: turn.draft?.description ?? null,
        ...(turn.draft ? { draftChildren: [...(turn.draft.children ?? [])], draftIdea: turn.draft.idea === true } : {}),
        ready: turn.ready,
      },
    });
    await this.appendMessages(tx, created, 0, message, turn);
    return created;
  }

  async appendMessages(
    tx: TenantClient,
    conversation: Pick<ConversationRow, "orgId" | "id">,
    existing: number,
    personText: string,
    turn: ConversationTurn,
  ): Promise<void> {
    const { orgId, id: conversationId } = conversation;
    await tx.ticketConversationMessage.createMany({
      data: [
        { orgId, conversationId, position: existing + 1, author: "person", body: personText },
        { orgId, conversationId, position: existing + 2, author: "assistant", body: turn.message, model: turn.model },
      ],
    });
    await tx.ticketConversation.update({
      where: { orgId_id: { orgId, id: conversationId } },
      data: {
        ready: turn.ready,
        // `null` da IA mantém o rascunho anterior (inclusive o editado à mão pela pessoa).
        ...(turn.draft
          ? {
              draftTitle: turn.draft.title,
              draftDescription: turn.draft.description,
              draftChildren: [...(turn.draft.children ?? [])],
              // Uma IA que não manda `idea` mantém a opção como está.
              ...(turn.draft.idea !== undefined ? { draftIdea: turn.draft.idea } : {}),
            }
          : {}),
      },
    });
  }
}

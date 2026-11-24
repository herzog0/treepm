import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CONVERSATION_TECHNICAL_MAX_DEPTH, canReadConversation, visibleTrail } from "@treepm/domain";
import type { ConversationNode } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import type { ProjectRow } from "../tickets/tickets.service.js";

type Ticket = { id: string; projectId: string; number: number; title: string; description: string; status: string; parentId: string | null };
export type Visible = { project: ProjectRow; ticket: Ticket };

export type ConversationRow = {
  id: string;
  kind: "ticket" | "general" | "thread";
  ownerPersonId: string;
  projectId: string | null;
  ticketId: string | null;
  parentId: string | null;
  rootId: string;
  depth: number;
  openingMessageId: string | null;
  lastActivityAt: Date;
};

/** O que `resolve` entrega: a conversa que a pessoa lê, e só ela. Nada daqui revela conversa de cima que a pessoa não leia. */
export type Resolved = {
  conv: ConversationRow;
  /** Todos os participantes DESTA conversa (quem lê a conversa conhece os participantes dela). */
  participantIds: Set<string>;
  /** O ponto de leitura DA PESSOA nesta conversa. */
  lastReadSeq: bigint;
  /** O ticket de que a conversa trata, já conferido (`canView`); `null` quando não trata de ticket. */
  seen: Visible | null;
};

const CONV_SELECT = { id: true, kind: true, ownerPersonId: true, projectId: true, ticketId: true, parentId: true, rootId: true, depth: true, openingMessageId: true, lastActivityAt: true } as const;
export const notFound = (): NotFoundException => new NotFoundException("Conversa não encontrada.");

/**
 * A ÚNICA porta para uma conversa por id (ADR 0055, regra 3). Toda rota de conversa passa por `resolve`: ele devolve a conversa só
 * para quem participa dela e, quando ela trata de um ticket, ainda enxerga o ticket; qualquer outro caso (não existe, é de outra
 * organização, a pessoa não participa, perdeu o acesso ao projeto) é o MESMO 404, sem distinguir. O serviço nunca recebe o id cru,
 * recebe o `Resolved`. A regra de pessoa em si (quem lê o quê, trilha, pai visível) é de `@treepm/domain`.
 */
@Injectable()
export class ConversationAccess {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  /** Quem enxerga o ticket abre a conversa; inexistente, de outra organização (RLS) ou de projeto invisível: o mesmo 404. */
  async visible(tx: TenantClient, principal: Principal, ticketId: string): Promise<Visible> {
    const ticket = await tx.ticket.findFirst({
      where: { id: ticketId },
      select: { id: true, projectId: true, number: true, title: true, description: true, status: true, parentId: true },
    });
    const project = ticket ? await tx.project.findFirst({ where: { id: ticket.projectId } }) : null;
    if (!ticket || !project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Ticket não encontrado.");
    return { project, ticket };
  }

  writable({ project }: Visible): void {
    if (project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
  }

  /** `ignoreTicketAccess`: só para apagar a PRÓPRIA conversa com o assistente, que a pessoa sempre pode (não lê nada ali). */
  async resolve(tx: TenantClient, principal: Principal, id: string, options: { ignoreTicketAccess?: boolean } = {}): Promise<Resolved> {
    const me = principal.person.id;
    const mine = await tx.conversationParticipant.findFirst({ where: { conversationId: id, personId: me }, select: { lastReadSeq: true } });
    if (!mine) throw notFound();
    const conv = await tx.conversation.findFirst({ where: { id }, select: CONV_SELECT });
    if (!conv) throw notFound();
    const participants = await tx.conversationParticipant.findMany({ where: { conversationId: id }, select: { personId: true } });
    const participantIds = new Set(participants.map((p) => p.personId));
    // Defesa em profundidade: a regra do domínio é a que decide.
    if (!canReadConversation(me, { participantIds })) throw notFound();
    let seen: Visible | null = null;
    // Só a PRÓPRIA conversa principal dispensa o acesso ao ticket (para apagá-la); numa thread quem perdeu o acesso recebe 404.
    const ignore = options.ignoreTicketAccess === true && conv.kind !== "thread" && conv.ownerPersonId === me;
    if (conv.ticketId && !ignore) {
      try {
        seen = await this.visible(tx, principal, conv.ticketId);
      } catch {
        throw notFound();
      }
    }
    return { conv: conv as ConversationRow, participantIds, lastReadSeq: mine.lastReadSeq, seen };
  }

  /**
   * A trilha: as conversas acima que a PESSOA lê (a regra de `@treepm/domain`), do ponto em que ela entra até a de cima. Os
   * ancestrais que ela não lê nem são carregados além do que decide parar.
   */
  async trail(tx: TenantClient, principal: Principal, id: string): Promise<{ id: string; kind: "ticket" | "general" | "thread"; openingMessageId: string | null }[]> {
    const me = principal.person.id;
    const chain = await tx.$queryRaw<{ id: string; parent_id: string | null; kind: "ticket" | "general" | "thread"; opening_message_id: string | null; mine: boolean }[]>`
      with recursive up as (
        select c.org_id, c.id, c.parent_id, c.kind, c.opening_message_id, 0 as lvl from conversations c where c.id = ${id}::uuid
        union all
        select p.org_id, p.id, p.parent_id, p.kind, p.opening_message_id, up.lvl + 1
        from conversations p join up on p.org_id = up.org_id and p.id = up.parent_id
        where up.lvl < ${CONVERSATION_TECHNICAL_MAX_DEPTH + 1}::int
      )
      select up.id, up.parent_id, up.kind, up.opening_message_id,
             exists (select 1 from conversation_participants cp where cp.org_id = up.org_id and cp.conversation_id = up.id and cp.person_id = ${me}::uuid) as mine
      from up order by up.lvl asc`;
    const nodes: ConversationNode[] = chain.map((c) => ({ id: c.id, parentId: c.parent_id, participantIds: new Set(c.mine ? [me] : []) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const info = new Map(chain.map((c) => [c.id, c]));
    return visibleTrail(me, id, byId).flatMap((trailId) => {
      const row = info.get(trailId);
      return row ? [{ id: row.id, kind: row.kind, openingMessageId: row.opening_message_id }] : [];
    });
  }

  /** As conversas de dentro (a própria, as filhas, as netas…) da conversa dada: todas pertencem a quem participa dela (a invariante). */
  async subtree(tx: TenantClient, id: string): Promise<{ id: string; projectId: string | null; ticketId: string | null }[]> {
    return tx.$queryRaw<{ id: string; projectId: string | null; ticketId: string | null }[]>`
      with recursive down as (
        select c.org_id, c.id, c.project_id, c.ticket_id from conversations c where c.id = ${id}::uuid
        union all
        select k.org_id, k.id, k.project_id, k.ticket_id from conversations k join down on k.org_id = down.org_id and k.parent_id = down.id
      )
      select id, project_id as "projectId", ticket_id as "ticketId" from down`;
  }
}

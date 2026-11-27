import type { Actor, ProjectAccess } from "./index.js";
import { canManageProject, canViewProject } from "./index.js";

export type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** Estágio de ideia (ADR 0042): só a raiz da ideia tem estágio; ticket comum não tem. */
export const IDEA_STAGES = ["new", "refining", "ready", "discarded"] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];

/** Minimal ticket shape needed to compute progress. `ideaStage` ausente ou nulo: ticket comum. */
export interface TicketNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: TicketStatus;
  readonly ideaStage?: IdeaStage | null;
}

/** Finalizado (ADR 0034): concluído ou cancelado. Os outros três valores são "aberto". */
export function isFinished(status: TicketStatus): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Progress over every descendant: `excluded` counts cancelled, `total` the rest, `done` the finished ones. `ideas` (ADR 0042)
 * é a quantidade de raízes de ideia abaixo do ticket, à parte: nenhuma ideia (nem o que está dentro dela) entra nos outros três.
 */
export interface TicketProgress {
  readonly done: number;
  readonly total: number;
  readonly excluded: number;
  readonly ideas: number;
}

/** Tickets follow the visibility of their project. */
export function canViewTickets(actor: Actor, project: ProjectAccess): boolean {
  return canViewProject(actor, project);
}

function canWriteTickets(actor: Actor, projectId: string): boolean {
  if (actor.clerkRole === "admin") return true;
  const role = actor.projectRoles.get(projectId);
  return role === "manager" || role === "contributor";
}

/** Allows organization admins, managers and contributors to create tickets. */
export function canCreateTicket(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins, managers and contributors to edit title, description, status and parent. */
export function canEditTicket(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins, managers and contributors to assign or unassign people. */
export function canAssignTicket(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins, managers and contributors to import a ticket list. */
export function canImportTickets(actor: Actor, projectId: string): boolean {
  return canWriteTickets(actor, projectId);
}

/** Allows organization admins and project managers to remove tickets. */
export function canRemoveTicket(actor: Actor, projectId: string): boolean {
  return actor.clerkRole === "admin" || actor.projectRoles.get(projectId) === "manager";
}

/** Registrar uma ideia: as mesmas permissões de criar ticket (ADR 0042). */
export function canRegisterIdea(actor: Actor, projectId: string): boolean {
  return canCreateTicket(actor, projectId);
}

/** Refinar uma ideia (mudar o estágio, editar o que está dentro): as mesmas permissões de editar ticket (ADR 0042). */
export function canRefineIdea(actor: Actor, projectId: string): boolean {
  return canEditTicket(actor, projectId);
}

/** Aceitar ou descartar uma ideia: quem gere o projeto (ADR 0042). */
export function canTriageIdea(actor: Actor, projectId: string): boolean {
  return canManageProject(actor, projectId);
}

/**
 * Raiz de ideia mais próxima de `ticketId`, ele mesmo incluído (ADR 0042): sobe pelos pais até achar um com estágio.
 * `null` quando o ticket não está dentro de nenhuma ideia (ou quando `ticketId` é `null`). Uma ideia pode conter outra; vale a mais próxima.
 */
export function ideaRootOf(
  parentById: ReadonlyMap<string, string | null>,
  stageById: ReadonlyMap<string, IdeaStage | null>,
  ticketId: string | null,
): string | null {
  const seen = new Set<string>();
  let cursor = ticketId;
  while (cursor !== null && !seen.has(cursor)) {
    if ((stageById.get(cursor) ?? null) !== null) return cursor;
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return null;
}

/** Para cada ticket que está dentro de uma ideia (a raiz incluída), o id da raiz mais próxima. Quem está fora não aparece. */
export function ideaRootsOf(tickets: readonly TicketNode[]): Map<string, string> {
  const parents = new Map(tickets.map((ticket) => [ticket.id, ticket.parentId] as const));
  const stages = new Map(tickets.map((ticket) => [ticket.id, ticket.ideaStage ?? null] as const));
  const roots = new Map<string, string>();
  for (const ticket of tickets) {
    const root = ideaRootOf(parents, stages, ticket.id);
    if (root !== null) roots.set(ticket.id, root);
  }
  return roots;
}

/** Regra 5 (ADR 0042): dentro de uma ideia a situação não anda; só a mesma situação é aceita. Fora de ideia, qualquer uma. */
export function statusChangeAllowed(inIdea: boolean, from: TicketStatus, to: TicketStatus): boolean {
  return !inIdea || from === to;
}

/** Mudança de estágio pela rota de estágio: entre os três estágios abertos vale qualquer uma; `discarded` só volta para `refining`. */
export function canChangeIdeaStage(from: IdeaStage, to: IdeaStage): boolean {
  if (to === "discarded") return false;
  if (from === "discarded") return to === "refining";
  return true;
}

/** Transformar um ticket comum em ideia: ele `todo` e nenhum descendente andando ou concluído (`cancelled` fica como está). */
export function canBecomeIdea(status: TicketStatus, descendantStatuses: readonly TicketStatus[]): boolean {
  return status === "todo" && descendantStatuses.every((value) => value === "todo" || value === "cancelled");
}

/** Mover um ticket para dentro de uma ideia: ele e os descendentes `todo` ou `cancelled`; trabalho andando não vira ideia por arrasto. */
export function canMoveIntoIdea(status: TicketStatus, descendantStatuses: readonly TicketStatus[]): boolean {
  return [status, ...descendantStatuses].every((value) => value === "todo" || value === "cancelled");
}

function childrenByParent(tickets: readonly TicketNode[]): Map<string, TicketNode[]> {
  const children = new Map<string, TicketNode[]>();
  for (const ticket of tickets) {
    if (ticket.parentId === null) continue;
    const siblings = children.get(ticket.parentId);
    if (siblings) siblings.push(ticket);
    else children.set(ticket.parentId, [ticket]);
  }
  return children;
}

/**
 * Progress for every ticket that has children, keyed by ID (ADR 0034). A ticket without children has no entry.
 * Counts every descendant, at any level; a descendant that is itself a parent counts as one item, by its own status.
 * Ideas (ADR 0042) ficam de fora: a raiz de ideia e tudo dentro dela não entram em `done`, `total` nem `excluded`, só em
 * `ideas` (uma por raiz, em qualquer nível). Quem está dentro de uma ideia tem tudo zero, com `ideas` das ideias de dentro.
 */
export function ticketProgress(tickets: readonly TicketNode[]): Map<string, TicketProgress> {
  const children = childrenByParent(tickets);
  const inIdea = ideaRootsOf(tickets);
  const isRoot = new Map(tickets.map((ticket) => [ticket.id, (ticket.ideaStage ?? null) !== null] as const));
  const result = new Map<string, TicketProgress>();
  const visit = (ticket: TicketNode): TicketProgress => {
    const known = result.get(ticket.id);
    if (known) return known;
    const outside = !inIdea.has(ticket.id);
    let done = 0;
    let total = 0;
    let excluded = 0;
    let ideas = 0;
    for (const kid of children.get(ticket.id) ?? []) {
      if (isRoot.get(kid.id)) ideas += 1;
      else if (outside) {
        if (kid.status === "cancelled") excluded += 1;
        else {
          total += 1;
          if (kid.status === "done") done += 1;
        }
      }
      const nested = children.has(kid.id) ? visit(kid) : null;
      if (nested) {
        ideas += nested.ideas;
        if (outside && !inIdea.has(kid.id)) {
          done += nested.done;
          total += nested.total;
          excluded += nested.excluded;
        }
      }
    }
    const progress = { done, total, excluded, ideas };
    result.set(ticket.id, progress);
    return progress;
  };
  for (const ticket of tickets) {
    if (children.has(ticket.id)) visit(ticket);
  }
  return result;
}

/** True when making `newParentId` the parent of `ticketId` would make the ticket its own ancestor. */
export function parentWouldCreateCycle(
  parentById: ReadonlyMap<string, string | null>,
  ticketId: string,
  newParentId: string | null,
): boolean {
  const seen = new Set<string>();
  let cursor = newParentId;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ticketId) return true;
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
}

const EXCERPT_LENGTH = 600;

/** First 600 code points of a description, ending in "…" when it is longer. Never splits a surrogate pair. */
export function descriptionExcerpt(description: string): string {
  if (description.length <= EXCERPT_LENGTH) return description;
  // Anda no máximo 600 pontos de código (sem materializar a descrição inteira): um par substituto vale um ponto e ocupa dois
  // índices; um substituto solto vale um ponto, como em `Array.from`.
  let end = 0;
  let points = 0;
  while (points < EXCERPT_LENGTH && end < description.length) {
    end += (description.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    points += 1;
  }
  return end >= description.length ? description : `${description.slice(0, end)}…`;
}

/**
 * A situação de um **Pai** a partir das situações dos filhos (ADR 0068, seção 2), sem contar ideias: todos cancelados → cancelado;
 * todos concluídos ou cancelados, com pelo menos um concluído → concluído; algum em andamento, em revisão ou concluído com filho
 * ainda aberto → em andamento; os demais → a fazer. Sem filho nenhum: `null` (a situação é marcada à mão).
 */
export function parentStatusFrom(children: readonly TicketStatus[]): TicketStatus | null {
  if (children.length === 0) return null;
  if (children.every((status) => status === "cancelled")) return "cancelled";
  if (children.every(isFinished)) return "done";
  if (children.some((status) => status === "in_progress" || status === "in_review" || status === "done")) return "in_progress";
  return "todo";
}

/**
 * Refaz a situação calculada dos tickets `ids` (ADR 0068), do mais fundo para o mais raso pela árvore de `tickets`: cada pai usa a
 * situação já refeita dos filhos. Devolve só quem tem a situação calculada (pelo menos um filho que não é ideia), com a situação
 * que deve ter, mude ou não. Ideias ficam de fora como em `ticketProgress`: o filho raiz de ideia não conta, e a raiz de ideia e
 * quem está dentro dela não são calculados (a situação ali fica parada até o aceite, ADR 0042). `tickets` traz os `ids`, os filhos
 * deles e os ancestrais até a raiz (para saber quem está dentro de uma ideia).
 */
export function deriveParentStatuses(tickets: readonly TicketNode[], ids: readonly string[]): Map<string, TicketStatus> {
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const children = childrenByParent(tickets);
  const inIdea = ideaRootsOf(tickets);
  const depth = (id: string): number => {
    let level = 0;
    const seen = new Set<string>();
    for (let cursor = byId.get(id)?.parentId ?? null; cursor !== null && !seen.has(cursor); cursor = byId.get(cursor)?.parentId ?? null) {
      seen.add(cursor);
      level += 1;
    }
    return level;
  };
  const order = [...new Set(ids)].filter((id) => byId.has(id)).sort((a, b) => depth(b) - depth(a));
  const current = new Map(tickets.map((ticket) => [ticket.id, ticket.status] as const));
  const result = new Map<string, TicketStatus>();
  for (const id of order) {
    if (inIdea.has(id)) continue;
    const kids = (children.get(id) ?? []).filter((kid) => (kid.ideaStage ?? null) === null);
    const status = parentStatusFrom(kids.map((kid) => current.get(kid.id) ?? kid.status));
    if (status === null) continue;
    current.set(id, status);
    result.set(id, status);
  }
  return result;
}

/**
 * A situação do ticket é calculada (ADR 0068)? Lida do progresso que a API já manda: há filho que não é ideia (contado em `total`
 * ou, cancelado, em `excluded`). Dentro de uma ideia o progresso é todo zero, e a situação fica marcada à mão (parada).
 */
export function isStatusDerived(progress: Pick<TicketProgress, "total" | "excluded"> | null): boolean {
  return progress !== null && progress.total + progress.excluded > 0;
}

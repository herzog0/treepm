import type { Actor } from "./index.js";
import { canManageProject } from "./index.js";
import { canEditTicket } from "./tickets.js";

/** Tamanho do corpo de um comentário, depois de aparado (ADR 0040). */
export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 10_000;

/** Corpo aparado, ou `null` quando vazio ou acima do limite. */
export function commentBodyOf(raw: string): string | null {
  const body = raw.trim();
  return body.length >= COMMENT_BODY_MIN && body.length <= COMMENT_BODY_MAX ? body : null;
}

/** Comenta quem pode editar o ticket (ADR 0040): gestor, colaborador e administrador da organização. */
export function canCommentTicket(actor: Actor, projectId: string): boolean {
  return canEditTicket(actor, projectId);
}

/** Edita só o autor, e só enquanto ainda pode comentar; gestor e administrador não editam texto alheio. */
export function canEditComment(actor: Actor, projectId: string, authorPersonId: string, readerPersonId: string): boolean {
  return authorPersonId === readerPersonId && canCommentTicket(actor, projectId);
}

/** Remove o autor (mesmo sem poder mais comentar) ou quem gere o projeto (gestor ou administrador). */
export function canRemoveComment(actor: Actor, projectId: string, authorPersonId: string, readerPersonId: string): boolean {
  return authorPersonId === readerPersonId || canManageProject(actor, projectId);
}

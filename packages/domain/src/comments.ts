import type { Actor } from "./index.js";
import { canManageProject } from "./index.js";

/** Tamanho do corpo de um comentário, depois de aparado (ADR 0040). */
export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 10_000;

/** Corpo aparado, ou `null` quando vazio ou acima do limite. */
export function commentBodyOf(raw: string): string | null {
  const body = raw.trim();
  return body.length >= COMMENT_BODY_MIN && body.length <= COMMENT_BODY_MAX ? body : null;
}

/**
 * Comenta quem tem papel no projeto (ADR 0040, adendo de 2026-11-23): gestor, colaborador e leitor, mais o administrador da
 * organização. Permissão própria, que não segue a de editar ticket: o leitor comenta e continua sem mudar o ticket. Quem só
 * enxerga o projeto por ele ser da organização, sem papel, não comenta.
 */
export function canCommentTicket(actor: Actor, projectId: string): boolean {
  return actor.clerkRole === "admin" || actor.projectRoles.has(projectId);
}

/**
 * Edita só o autor, e só enquanto ainda pode comentar; gestor e administrador não editam texto alheio. Sem autor do TreePM (comentário
 * trazido do Linear de quem não casou), ninguém edita.
 */
export function canEditComment(actor: Actor, projectId: string, authorPersonId: string | null, readerPersonId: string): boolean {
  return authorPersonId !== null && authorPersonId === readerPersonId && canCommentTicket(actor, projectId);
}

/** Remove o autor (mesmo sem poder mais comentar) ou quem gere o projeto (gestor ou administrador). */
export function canRemoveComment(actor: Actor, projectId: string, authorPersonId: string | null, readerPersonId: string): boolean {
  return (authorPersonId !== null && authorPersonId === readerPersonId) || canManageProject(actor, projectId);
}

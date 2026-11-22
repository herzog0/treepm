import { ForbiddenException, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import {
  canAssignTicket,
  canAttachTeamToProject,
  canCreateProject,
  canCommentTicket,
  canCreateTicket,
  canEditComment,
  canEditTicket,
  canImportTickets,
  canManageAiConsent,
  canLinkRepository,
  canListInstallationRepositories,
  canManageGithubConnection,
  canManageMcpAccess,
  canRemoveComment,
  canRemoveTicket,
  canCreateTeam,
  canGrantProjectRole,
  canManageAreas,
  canManageProject,
  canManageTeamMembers,
  canRemoveTeam,
  canRenameTeam,
  canViewDirectory,
  canViewProject,
  visibleProjects,
} from "@treepm/domain";
import type { Actor, ClerkRole, ProjectAccess } from "@treepm/domain";
import { buildActor } from "./actor.js";

/**
 * Monta o `Actor` e aplica as funções `can*` de `@treepm/domain`. Nenhuma regra
 * de permissão vive aqui: este serviço só traduz "não pode" em 403.
 */
@Injectable()
export class AuthorizationService {
  /** Papel Clerk do token + memberships da pessoa na transação atual. */
  async loadActor(tx: TenantClient, personId: string, clerkRole: ClerkRole): Promise<Actor> {
    const [teams, projects] = await Promise.all([
      tx.teamMembership.findMany({ where: { personId }, orderBy: { teamId: "asc" } }),
      tx.projectMembership.findMany({ where: { personId }, orderBy: { projectId: "asc" } }),
    ]);
    return buildActor(
      clerkRole,
      teams.map((row) => ({ teamId: row.teamId, role: row.role })),
      projects.map((row) => ({ projectId: row.projectId, role: row.role })),
    );
  }

  private require(allowed: boolean): void {
    if (!allowed) throw new ForbiddenException("Ação não permitida para o seu papel.");
  }

  viewDirectory(actor: Actor): void {
    this.require(canViewDirectory(actor));
  }
  createTeam(actor: Actor): void {
    this.require(canCreateTeam(actor));
  }
  renameTeam(actor: Actor, teamId: string): void {
    this.require(canRenameTeam(actor, teamId));
  }
  removeTeam(actor: Actor): void {
    this.require(canRemoveTeam(actor));
  }
  /** Inclui, remove e também ALTERA O PAPEL de quem já é membro (leitura única da matriz). */
  manageTeamMembers(actor: Actor, teamId: string): void {
    this.require(canManageTeamMembers(actor, teamId));
  }
  manageAreas(actor: Actor): void {
    this.require(canManageAreas(actor));
  }
  createProject(actor: Actor): void {
    this.require(canCreateProject(actor));
  }
  manageProject(actor: Actor, projectId: string): void {
    this.require(canManageProject(actor, projectId));
  }
  grantProjectRole(actor: Actor, projectId: string): void {
    this.require(canGrantProjectRole(actor, projectId));
  }
  attachTeamToProject(actor: Actor, projectId: string): void {
    this.require(canAttachTeamToProject(actor, projectId));
  }

  /** Conectar e desconectar o GitHub da organização (ADR 0032). */
  manageGithubConnection(actor: Actor): void {
    this.require(canManageGithubConnection(actor));
  }
  /** Chave "Permitir acesso por MCP", lista de todos os tokens da organização e revogação de qualquer um (ADR 0038). */
  manageMcpAccess(actor: Actor): void {
    this.require(canManageMcpAccess(actor));
  }
  /** Aceitar e retirar o uso da IA pela organização (ADR 0039): a mesma regra de quem liga o MCP. */
  manageAiConsent(actor: Actor): void {
    this.require(canManageAiConsent(actor));
  }
  listInstallationRepositories(actor: Actor): void {
    this.require(canListInstallationRepositories(actor));
  }
  linkRepository(actor: Actor, projectId: string): void {
    this.require(canLinkRepository(actor, projectId));
  }

  createTicket(actor: Actor, projectId: string): void {
    this.require(canCreateTicket(actor, projectId));
  }
  editTicket(actor: Actor, projectId: string): void {
    this.require(canEditTicket(actor, projectId));
  }
  commentTicket(actor: Actor, projectId: string): void {
    this.require(canCommentTicket(actor, projectId));
  }
  editComment(actor: Actor, projectId: string, authorPersonId: string, personId: string): void {
    this.require(canEditComment(actor, projectId, authorPersonId, personId));
  }
  removeComment(actor: Actor, projectId: string, authorPersonId: string, personId: string): void {
    this.require(canRemoveComment(actor, projectId, authorPersonId, personId));
  }
  assignTicket(actor: Actor, projectId: string): void {
    this.require(canAssignTicket(actor, projectId));
  }
  importTickets(actor: Actor, projectId: string): void {
    this.require(canImportTickets(actor, projectId));
  }
  removeTicket(actor: Actor, projectId: string): void {
    this.require(canRemoveTicket(actor, projectId));
  }

  canView(actor: Actor, project: ProjectAccess): boolean {
    return canViewProject(actor, project);
  }
  visible<Project extends ProjectAccess>(actor: Actor, projects: readonly Project[]): Project[] {
    return visibleProjects(actor, projects);
  }
}

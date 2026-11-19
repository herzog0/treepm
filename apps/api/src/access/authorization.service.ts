import { ForbiddenException, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import {
  canAttachTeamToProject,
  canCreateProject,
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

  canView(actor: Actor, project: ProjectAccess): boolean {
    return canViewProject(actor, project);
  }
  visible<Project extends ProjectAccess>(actor: Actor, projects: readonly Project[]): Project[] {
    return visibleProjects(actor, projects);
  }
}

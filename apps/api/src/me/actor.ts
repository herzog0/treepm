import type { Actor, ClerkRole, ProjectRole, TeamRole } from "@treepm/domain";

export type TeamMembershipRow = { teamId: string; role: TeamRole };
export type ProjectMembershipRow = { projectId: string; role: ProjectRole };

/** Monta o `Actor` do domínio a partir do papel do token e das memberships da transação. */
export function buildActor(
  clerkRole: ClerkRole,
  teams: readonly TeamMembershipRow[],
  projects: readonly ProjectMembershipRow[],
): Actor {
  return {
    clerkRole,
    teamRoles: new Map(teams.map((row) => [row.teamId, row.role])),
    projectRoles: new Map(projects.map((row) => [row.projectId, row.role])),
  };
}

/** `org:admin` → `admin`. Papéis fora de `admin`/`member` (ADR 0019) não são aceitos. */
export function parseClerkRole(orgRole: string | null): ClerkRole | null {
  const role = orgRole?.replace(/^org:/, "");
  return role === "admin" || role === "member" ? role : null;
}

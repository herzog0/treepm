export type ClerkRole = "admin" | "member";
export type TeamRole = "admin" | "member";
export type ProjectRole = "manager" | "contributor" | "reader";
export type ProjectVisibility = "organization" | "private";

/** Holds the caller's roles in the current organization. */
export interface Actor {
  readonly clerkRole: ClerkRole;
  readonly teamRoles: ReadonlyMap<string, TeamRole>;
  readonly projectRoles: ReadonlyMap<string, ProjectRole>;
}

/** Identifies a project and its visibility within the current organization. */
export interface ProjectAccess {
  readonly id: string;
  readonly visibility: ProjectVisibility;
}

/** Allows organization members to view people, teams, and areas. */
export function canViewDirectory(actor: Actor): boolean {
  return actor.clerkRole === "admin" || actor.clerkRole === "member";
}

/** Allows organization admins to create teams. */
export function canCreateTeam(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization admins and the target team's admins to rename it. */
export function canRenameTeam(actor: Actor, teamId: string): boolean {
  return actor.clerkRole === "admin" || actor.teamRoles.get(teamId) === "admin";
}

/** Allows organization admins to remove teams. */
export function canRemoveTeam(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization admins and the target team's admins to add or remove its members. */
export function canManageTeamMembers(actor: Actor, teamId: string): boolean {
  return actor.clerkRole === "admin" || actor.teamRoles.get(teamId) === "admin";
}

/** Allows organization admins to create, rename, and remove areas. */
export function canManageAreas(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization admins to create projects. */
export function canCreateProject(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization-wide access to shared projects and role-based access to private projects. */
export function canViewProject(actor: Actor, project: ProjectAccess): boolean {
  return actor.clerkRole === "admin"
    || project.visibility === "organization"
    || actor.projectRoles.has(project.id);
}

/** Allows organization admins and project managers to rename, change visibility, or archive the project. */
export function canManageProject(actor: Actor, projectId: string): boolean {
  return actor.clerkRole === "admin" || actor.projectRoles.get(projectId) === "manager";
}

/** Allows organization admins and project managers to grant or revoke project roles, including the last manager. */
export function canGrantProjectRole(actor: Actor, projectId: string): boolean {
  return canManageProject(actor, projectId);
}

/** Allows organization admins and project managers to associate teams with the project. */
export function canAttachTeamToProject(actor: Actor, projectId: string): boolean {
  return canManageProject(actor, projectId);
}

/** Keeps only projects the caller can view, preserving their order and fields. */
export function visibleProjects<Project extends ProjectAccess>(
  actor: Actor,
  projects: readonly Project[],
): Project[] {
  return projects.filter((project) => canViewProject(actor, project));
}
export * from "./tickets.js";
export * from "./search.js";
export * from "./mentions.js";
export * from "./mention-cases.js";
export * from "./dependencies.js";
export * from "./queue-place.js";
export * from "./sibling-order.js";
export * from "./exploded-tree.js";
export * from "./activity.js";
export * from "./comments.js";
export * from "./chat.js";
export * from "./conversations.js";
export * from "./contributions.js";

/** Allows organization admins to connect and disconnect the organization's GitHub installation (ADR 0032). */
export function canManageGithubConnection(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization admins to switch MCP access on or off, list every access token and revoke any of them (ADR 0038). */
export function canManageMcpAccess(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization admins to create, deactivate and reactivate test people (ADR 0057). */
export function canManageTestPeople(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

/** Allows organization admins and managers of any project to list the repositories the installation can reach. */
export function canListInstallationRepositories(actor: Actor): boolean {
  if (actor.clerkRole === "admin") return true;
  for (const role of actor.projectRoles.values()) if (role === "manager") return true;
  return false;
}

/** Allows organization admins and the project's managers to link and unlink the project's repositories. */
export function canLinkRepository(actor: Actor, projectId: string): boolean {
  return canManageProject(actor, projectId);
}
export * from "./code-links.js";
export * from "./ai-consent.js";
export * from "./agent-work.js";
export * from "./priority.js";
export * from "./due-date.js";
export * from "./linear-import.js";
export * from "./linear-reimport.js";
export * from "./linear-comments.js";
export * from "./linear-relations.js";
export * from "./linear-history.js";
export * from "./linear-history-name-cases.js";
export * from "./email-shape.js";
export * from "./work-queue.js";
export * from "./play.js";
export * from "./related.js";
export * from "./related-fusion.js";
export * from "./ticket-embedding-text.js";
export * from "./labels.js";
export * from "./label-name-cases.js";
export * from "./linear-labels.js";

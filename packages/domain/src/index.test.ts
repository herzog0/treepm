import { describe, expect, it } from "vitest";
import {
  canAttachTeamToProject,
  canCreateProject,
  canCreateTeam,
  canLinkRepository,
  canListInstallationRepositories,
  canManageGithubConnection,
  canManageMcpAccess,
  canGrantProjectRole,
  canManageAreas,
  canManageProject,
  canManageTeamMembers,
  canRemoveTeam,
  canRenameTeam,
  canViewDirectory,
  canViewProject,
  visibleProjects,
} from "./index.js";
import type { Actor } from "./index.js";

const teamId = "design";
const privateProject = { id: "internal", visibility: "private" } as const;
const organizationProject = { id: "roadmap", visibility: "organization" } as const;

const member: Actor = {
  clerkRole: "member",
  teamRoles: new Map([[teamId, "member"]]),
  projectRoles: new Map(),
};
const orgAdmin: Actor = { ...member, clerkRole: "admin" };
const teamAdmin: Actor = { ...member, teamRoles: new Map([[teamId, "admin"]]) };
const manager: Actor = { ...member, projectRoles: new Map([[privateProject.id, "manager"]]) };
const contributor: Actor = { ...member, projectRoles: new Map([[privateProject.id, "contributor"]]) };
const reader: Actor = { ...member, projectRoles: new Map([[privateProject.id, "reader"]]) };

const actors = [orgAdmin, teamAdmin, manager, contributor, reader, member] as const;

describe.each([
  { action: "view directory", check: canViewDirectory, allowed: [true, true, true, true, true, true] },
  { action: "create team", check: canCreateTeam, allowed: [true, false, false, false, false, false] },
  { action: "rename team", check: (actor: Actor) => canRenameTeam(actor, teamId), allowed: [true, true, false, false, false, false] },
  { action: "remove team", check: canRemoveTeam, allowed: [true, false, false, false, false, false] },
  { action: "manage team members", check: (actor: Actor) => canManageTeamMembers(actor, teamId), allowed: [true, true, false, false, false, false] },
  { action: "manage areas", check: canManageAreas, allowed: [true, false, false, false, false, false] },
  { action: "create project", check: canCreateProject, allowed: [true, false, false, false, false, false] },
  { action: "view organization project", check: (actor: Actor) => canViewProject(actor, organizationProject), allowed: [true, true, true, true, true, true] },
  { action: "view private project", check: (actor: Actor) => canViewProject(actor, privateProject), allowed: [true, false, true, true, true, false] },
  { action: "manage project", check: (actor: Actor) => canManageProject(actor, privateProject.id), allowed: [true, false, true, false, false, false] },
  { action: "grant or revoke project role", check: (actor: Actor) => canGrantProjectRole(actor, privateProject.id), allowed: [true, false, true, false, false, false] },
  { action: "attach team to project", check: (actor: Actor) => canAttachTeamToProject(actor, privateProject.id), allowed: [true, false, true, false, false, false] },
  { action: "manage the GitHub connection", check: (actor: Actor) => canManageGithubConnection(actor), allowed: [true, false, false, false, false, false] },
  { action: "manage MCP access (switch and all tokens)", check: (actor: Actor) => canManageMcpAccess(actor), allowed: [true, false, false, false, false, false] },
  { action: "list the installation's repositories", check: (actor: Actor) => canListInstallationRepositories(actor), allowed: [true, false, true, false, false, false] },
  { action: "link a repository to a project", check: (actor: Actor) => canLinkRepository(actor, privateProject.id), allowed: [true, false, true, false, false, false] },
])("$action", ({ check, allowed }) => {
  it.each([
    ["organization admin", actors[0], allowed[0]],
    ["team admin", actors[1], allowed[1]],
    ["project manager", actors[2], allowed[2]],
    ["contributor", actors[3], allowed[3]],
    ["reader", actors[4], allowed[4]],
    ["member without project role", actors[5], allowed[5]],
  ] as const)("%s", (_role, actor, expected) => {
    expect(check(actor)).toBe(expected);
  });
});

it("requires a team admin's role to match the target team", () => {
  expect(canRenameTeam(teamAdmin, "engineering")).toBe(false);
  expect(canManageTeamMembers(teamAdmin, "engineering")).toBe(false);
});

it("allows an organization admin to manage a team without a team role", () => {
  expect(canRenameTeam(orgAdmin, "engineering")).toBe(true);
  expect(canManageTeamMembers(orgAdmin, "engineering")).toBe(true);
});

it("allows a team admin to view a private project with a role on that project", () => {
  const actor: Actor = { ...teamAdmin, projectRoles: reader.projectRoles };
  expect(canViewProject(actor, privateProject)).toBe(true);
  expect(canViewProject(actor, { ...privateProject, id: "other" })).toBe(false);
});

it("requires a project manager's role to match the target project", () => {
  expect(canManageProject(manager, organizationProject.id)).toBe(false);
  expect(canGrantProjectRole(manager, organizationProject.id)).toBe(false);
  expect(canAttachTeamToProject(manager, organizationProject.id)).toBe(false);
});

it("allows the organization admin to act after the last manager is revoked", () => {
  expect(canGrantProjectRole(manager, privateProject.id)).toBe(true);
  expect(canManageProject(orgAdmin, privateProject.id)).toBe(true);
  expect(canGrantProjectRole(orgAdmin, privateProject.id)).toBe(true);
});

it("filters projects using the same visibility rules as individual access", () => {
  const namedPrivateProject = { ...privateProject, name: "Internal" };
  const projects = [namedPrivateProject, organizationProject, { ...privateProject, id: "other" }];
  expect(visibleProjects(member, projects)).toEqual([organizationProject]);
  expect(visibleProjects(teamAdmin, projects)).toEqual([organizationProject]);
  expect(visibleProjects(reader, projects)).toEqual([namedPrivateProject, organizationProject]);
  expect(visibleProjects(orgAdmin, projects)).toEqual(projects);
});

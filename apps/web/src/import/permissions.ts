import type { Me, Project } from "../api/client.js";

/** Administrador da organização, gestor ou colaborador do projeto, em projeto não arquivado (ADR 0025). */
export function canCreateTickets(me: Me, project: Pick<Project, "id" | "archivedAt">): boolean {
  if (project.archivedAt !== null) return false;
  if (me.roles.clerk === "admin") return true;
  return me.roles.projects.some((entry) => entry.projectId === project.id && (entry.role === "manager" || entry.role === "contributor"));
}

/** Administrador da organização ou gestor do projeto, em projeto não arquivado (ADR 0024). */
export function canRemoveTickets(me: Me, project: Pick<Project, "id" | "archivedAt">): boolean {
  if (project.archivedAt !== null) return false;
  if (me.roles.clerk === "admin") return true;
  return me.roles.projects.some((entry) => entry.projectId === project.id && entry.role === "manager");
}

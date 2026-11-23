import type { Person, Project, Team } from "../api/client.js";

/**
 * Quem enxerga um ticket do projeto (ADR 0049, CONTRATO-CHAT): projeto da organização, todas as pessoas ativas; projeto privado,
 * administradores, membros do projeto e membros dos times do projeto. A API confere de novo (`mention_not_allowed`).
 */
export function peopleWhoSee(project: Project | undefined, people: readonly Person[], teams: readonly Team[], selfId: string | undefined): Person[] {
  const teamMembers = new Set(teams.filter((team) => project?.teamIds.includes(team.id)).flatMap((team) => team.members.map((member) => member.personId)));
  const projectMembers = new Set(project?.members.map((member) => member.personId));
  return people.filter((person) => {
    if (!person.active || person.id === selfId) return false;
    if (project === undefined || project.visibility === "organization") return true;
    return person.clerkRole === "admin" || projectMembers.has(person.id) || teamMembers.has(person.id);
  });
}

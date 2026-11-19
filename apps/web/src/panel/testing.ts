import type { ApiClient, Area, Me, Person, Project, ProjectRole, Team } from "../api/client.js";
import { makeClient, makeMe } from "../test/fakes.js";

export function makePerson(id: string, displayName: string, extra: Partial<Person> = {}): Person {
  return { id, displayName, email: `${id}@example.com`, avatarUrl: null, clerkRole: "member", active: true, ...extra };
}

export function makeTeam(id: string, name: string): Team {
  return { id, name, members: [] };
}

/** `me` de teste com papel Clerk e papéis de projeto configuráveis. */
export function makePanelMe(clerk: "admin" | "member", projects: { projectId: string; role: ProjectRole }[] = []): Me {
  const me = makeMe({ clerk });
  return { ...me, roles: { ...me.roles, projects } };
}

interface PanelData {
  areas?: Area[];
  projects?: Project[];
  teams?: Team[];
  people?: Person[];
}

/** Cliente falso com `listPeople` também configurado (o `makeClient` base o deixa lançando). */
export function makePanelClient(data: PanelData = {}): ApiClient {
  return makeClient(data);
}

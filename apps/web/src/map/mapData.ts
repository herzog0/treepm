import type { ApiClient, ApiResult, Person, Project, TicketSummary } from "../api/client.js";

export interface MapData {
  projects: readonly Project[];
  people: readonly Person[];
  ticketsByProject: Readonly<Record<string, readonly TicketSummary[]>>;
}

/** Projetos e pessoas primeiro; depois os tickets de cada projeto visível e não arquivado, em paralelo. Qualquer falha falha a carga. */
export async function loadMapData(client: ApiClient): Promise<ApiResult<MapData>> {
  const [projects, people] = await Promise.all([client.listProjects(), client.listPeople()]);
  if (!projects.ok) return projects;
  if (!people.ok) return people;
  const visible = projects.data.filter((project) => project.archivedAt === null);
  const lists = await Promise.all(visible.map((project) => client.listTickets(project.id)));
  const ticketsByProject: Record<string, readonly TicketSummary[]> = {};
  for (const [position, list] of lists.entries()) {
    if (!list.ok) return list;
    ticketsByProject[visible[position]!.id] = list.data;
  }
  return { ok: true, data: { projects: projects.data, people: people.data, ticketsByProject } };
}

/** Igualdade por conteúdo: as respostas vêm do mesmo esquema, então as chaves chegam sempre na mesma ordem. */
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A atualização periódica (ADR 0043) só troca o que mudou: cada parte igual à que está na tela continua sendo o mesmo
 * objeto, e se nada mudou o resultado é o próprio `current`, de modo que nada se redesenha. É assim que "mudou" é decidido.
 */
export function mergeMapData(current: MapData, next: MapData): MapData {
  const projects = same(current.projects, next.projects) ? current.projects : next.projects;
  const people = same(current.people, next.people) ? current.people : next.people;
  const ids = Object.keys(next.ticketsByProject);
  let ticketsChanged = ids.length !== Object.keys(current.ticketsByProject).length;
  const ticketsByProject: Record<string, readonly TicketSummary[]> = {};
  for (const id of ids) {
    const before = current.ticketsByProject[id];
    const after = next.ticketsByProject[id]!;
    if (before !== undefined && same(before, after)) ticketsByProject[id] = before;
    else {
      ticketsByProject[id] = after;
      ticketsChanged = true;
    }
  }
  if (projects === current.projects && people === current.people && !ticketsChanged) return current;
  return { projects, people, ticketsByProject: ticketsChanged ? ticketsByProject : current.ticketsByProject };
}

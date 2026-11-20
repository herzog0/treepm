import { vi } from "vitest";
import type { ApiClient, ApiResult, Area, ConversationDetail, Me, Person, PlacementOutcome, Project, Team, TicketDetail, TicketStatus, TicketSummary } from "../api/client.js";

export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
export const failed = (kind: "unavailable" | "forbidden" | "unauthenticated" | "not_found" | "conflict" | "invalid" | "server_error", code?: string): ApiResult<never> => ({
  ok: false,
  error: code === undefined ? { kind } : { kind, code },
});

export function makeMe(overrides: { clerk?: "admin" | "member"; orgId?: string; orgName?: string; assistant?: boolean } = {}): Me {
  return {
    ...(overrides.assistant === undefined ? {} : { assistant: { enabled: overrides.assistant } }),
    person: { id: "person-1", displayName: "Ana", email: "ana@example.com", avatarUrl: null },
    organization: { orgId: overrides.orgId ?? "org-1", name: overrides.orgName ?? "Equipe Alfa", slug: "alfa" },
    roles: { clerk: overrides.clerk ?? "admin", teams: [], projects: [] },
  };
}

export function makePerson(id: string, displayName: string, extra: Partial<Person> = {}): Person {
  return { id, displayName, email: `${id}@example.com`, avatarUrl: null, clerkRole: "member", active: true, ...extra };
}

export function makeProject(id: string, key: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, key, name, visibility: "organization", archivedAt: null, members: [], teamIds: [], ...extra };
}

export function makeTicket(id: string, projectId: string, number: number, title: string, extra: Partial<TicketSummary> = {}): TicketSummary {
  const key = extra.key ?? `${projectId.toUpperCase()}-${number}`;
  return { id, projectId, number, key, parentId: null, title, kind: "ticket", status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "", ...extra };
}

/** Agrupador (ADR 0031): sem situação própria e com progresso sempre presente (vazio é 0 de 0). */
export function makeGroup(id: string, projectId: string, number: number, title: string, extra: Partial<TicketSummary> = {}): TicketSummary {
  return makeTicket(id, projectId, number, title, { kind: "group", status: null, progress: { done: 0, total: 0, excluded: 0 }, ...extra });
}

/** Conversa de criação com a IA (ADR 0029): uma troca de mensagens e, por padrão, um rascunho. */
export function makeConversation(id: string, projectId: string, extra: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id,
    projectId,
    status: "open",
    draft: { title: "Corrigir o login", description: "O login falha no Safari." },
    ready: true,
    createdTicketId: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    messages: [
      { id: `${id}-m1`, author: "person", body: "O login quebra no Safari", model: null, createdAt: "2026-11-20T10:00:00.000Z" },
      { id: `${id}-m2`, author: "assistant", body: "Entendi. Isso acontece em todas as versões?", model: "claude-opus-5-5", createdAt: "2026-11-20T10:00:05.000Z" },
    ],
    ...extra,
  };
}

export function makePlacement(extra: Partial<PlacementOutcome> = {}): PlacementOutcome {
  return { destination: { parentId: null, path: [] }, alternatives: [], discarded: [], uncertain: false, stoppedEarly: null, ...extra };
}

interface FakeData {
  me?: Me;
  projects?: Project[];
  areas?: Area[];
  teams?: Team[];
  people?: Person[];
  /** Tickets por ID de projeto, na ordem da listagem. */
  tickets?: Record<string, TicketSummary[]>;
}

/** Cliente falso: cada método lança se não for configurado, para o teste dizer o que precisa. */
export function makeClient(data: FakeData = {}): ApiClient {
  const unexpected = (name: string) => vi.fn(async () => {
    throw new Error(`chamada inesperada: ${name}`);
  });
  const names = [
    "createTeam", "renameTeam", "removeTeam", "putTeamMember", "removeTeamMember",
    "createArea", "renameArea", "removeArea", "getProject", "createProject", "updateProject",
    "putProjectMember", "removeProjectMember", "putProjectTeam", "removeProjectTeam",
    "getTicket", "createTicket", "updateTicket", "removeTicket", "putTicketAssignee", "removeTicketAssignee",
    "importTickets", "openConversation", "sendConversationMessage", "updateConversationDraft", "findPlacement",
    "createTicketFromConversation", "listConversations", "getConversation", "removeConversation",
  ] as const;
  const base = Object.fromEntries(names.map((name) => [name, unexpected(name)])) as unknown as ApiClient;
  return {
    ...base,
    getMe: vi.fn(async () => ok(data.me ?? makeMe())),
    listProjects: vi.fn(async () => ok(data.projects ?? [])),
    listAreas: vi.fn(async () => ok(data.areas ?? [])),
    listTeams: vi.fn(async () => ok(data.teams ?? [])),
    listPeople: vi.fn(async () => ok(data.people ?? [])),
    listTickets: vi.fn(async (projectId: string) => ok(data.tickets?.[projectId] ?? [])),
  };
}

/**
 * Cliente falso com a árvore de tickets em memória, que respeita o contrato da ADR 0031: o pai tem que ser
 * agrupador (409 `parent_not_group`), agrupador não tem situação (409 `group_has_no_status`), agrupador só vira
 * ticket vazio e só sai se estiver vazio (409 `ticket_has_children`). As chamadas continuam espiáveis (`vi.fn`).
 */
export function makeTreeClient(data: FakeData = {}): ApiClient {
  const base = makeClient(data);
  const all: TicketSummary[] = Object.values(data.tickets ?? {}).flat().map((entry) => ({ ...entry }));
  // A situação guardada de um agrupador, que volta a valer se ele virar ticket de novo (ADR 0031).
  const stored = new Map<string, TicketStatus>();
  const descriptions = new Map<string, string>();
  const find = (id: string) => all.find((entry) => entry.id === id);
  const childrenOf = (id: string) => all.filter((entry) => entry.parentId === id);
  const ticketLeaves = (id: string): TicketSummary[] => childrenOf(id).flatMap((child) => (child.kind === "group" ? ticketLeaves(child.id) : [child]));
  const withProgress = (entry: TicketSummary): TicketSummary => {
    if (entry.kind !== "group") return { ...entry };
    const leaves = ticketLeaves(entry.id);
    const excluded = leaves.filter((leaf) => leaf.status === "cancelled").length;
    return { ...entry, status: null, progress: { done: leaves.filter((leaf) => leaf.status === "done").length, total: leaves.length - excluded, excluded } };
  };
  const detail = (entry: TicketSummary): TicketDetail => ({
    ...withProgress(entry),
    description: descriptions.get(entry.id) ?? "",
    createdByPersonId: "person-1",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
  });
  const conflict = (code: string) => failed("conflict", code);
  const underTicket = (parentId: string | null) => parentId !== null && find(parentId)?.kind !== "group";

  return {
    ...base,
    listTickets: vi.fn(async (projectId: string) => ok(all.filter((entry) => entry.projectId === projectId).map(withProgress))),
    getTicket: vi.fn(async (id: string) => {
      const entry = find(id);
      return entry ? ok(detail(entry)) : failed("not_found");
    }),
    createTicket: vi.fn(async (projectId, body) => {
      const parentId = body.parentId ?? null;
      if (underTicket(parentId)) return conflict("parent_not_group");
      const number = Math.max(0, ...all.filter((entry) => entry.projectId === projectId).map((entry) => entry.number)) + 1;
      const id = `new-${projectId}-${number}`;
      const entry = body.kind === "group"
        ? makeGroup(id, projectId, number, body.title, { parentId })
        : makeTicket(id, projectId, number, body.title, { parentId, status: body.status ?? "todo" });
      all.push(entry);
      if (body.description) descriptions.set(id, body.description);
      return ok(detail(entry));
    }),
    updateTicket: vi.fn(async (id, body) => {
      const entry = find(id);
      if (!entry) return failed("not_found");
      if (body.status !== undefined && (entry.kind === "group" || body.kind === "group")) return conflict("group_has_no_status");
      if (body.parentId !== undefined) {
        if (underTicket(body.parentId)) return conflict("parent_not_group");
        for (let at = body.parentId; at !== null; at = find(at)?.parentId ?? null) if (at === id) return conflict("ticket_cycle");
      }
      if (body.kind === "ticket" && entry.kind === "group" && childrenOf(id).length > 0) return conflict("ticket_has_children");
      if (body.title !== undefined) entry.title = body.title;
      if (body.description !== undefined) descriptions.set(id, body.description);
      if (body.parentId !== undefined) entry.parentId = body.parentId;
      if (body.status !== undefined) entry.status = body.status;
      if (body.kind === "group" && entry.kind === "ticket") {
        if (entry.status) stored.set(id, entry.status);
        entry.kind = "group";
        entry.status = null;
      } else if (body.kind === "ticket" && entry.kind === "group") {
        entry.kind = "ticket";
        entry.status = stored.get(id) ?? "todo";
        entry.progress = null;
      }
      return ok(detail(entry));
    }),
    removeTicket: vi.fn(async (id: string) => {
      if (!find(id)) return failed("not_found");
      if (childrenOf(id).length > 0) return conflict("ticket_has_children");
      all.splice(all.findIndex((entry) => entry.id === id), 1);
      return ok(undefined);
    }),
  };
}

import { vi } from "vitest";
import type { ApiClient, ApiResult, Area, ConversationDetail, Me, Person, PlacementOutcome, Project, Team, TicketSummary } from "../api/client.js";

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
  return { id, projectId, number, key, parentId: null, title, status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "", ...extra };
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

import type { BootstrapData, ClassificationSuggestion, Project, Ticket, TicketEdge } from "@treepm/domain";

const API_URL = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const body = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "REQUEST_FAILED", body.message ?? "Falha na requisição.");
  return body;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/bootstrap"),
  createTicket: (projectId: string, input: unknown) => request<Ticket>(`/projects/${projectId}/tickets`, {
    method: "POST", body: JSON.stringify(input),
  }),
  updateTicket: (ticketId: string, input: unknown) => request<Ticket>(`/tickets/${ticketId}`, {
    method: "PATCH", body: JSON.stringify(input),
  }),
  deleteTicket: (ticketId: string, recursive: boolean) => request<{ deletedIds: string[] }>(`/tickets/${ticketId}?recursive=${recursive}`, { method: "DELETE" }),
  suggest: (projectId: string, input: { title: string; description: string }) => request<ClassificationSuggestion>(`/projects/${projectId}/tickets/suggest`, {
    method: "POST", body: JSON.stringify(input),
  }),
  createDependency: (projectId: string, sourceId: string, targetId: string) => request<TicketEdge>(`/projects/${projectId}/edges`, {
    method: "POST", body: JSON.stringify({ sourceId, targetId, type: "dependency", metadata: { origin: "canvas" } }),
  }),
  updateEdge: (edgeId: string, style: TicketEdge["style"]) => request<TicketEdge>(`/edges/${edgeId}`, {
    method: "PATCH", body: JSON.stringify({ style }),
  }),
  deleteEdge: (edgeId: string) => request<{ deletedId: string }>(`/edges/${edgeId}`, { method: "DELETE" }),
};

export type { Project };

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  childrenOf,
  createsDependencyCycle,
  descendantIds,
  validateParent,
} from "@treepm/domain";
import type { Database, TicketComponent, TicketEdge } from "@treepm/domain";
import { suggestClassification } from "./classifier.js";
import type { TreeRepository } from "./repository.js";

class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

const componentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  assigneeIds: z.array(z.string()).max(50).default([]),
}).strict();
const createTicketSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).default(""),
  parentId: z.string().nullable().default(null),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  assigneeIds: z.array(z.string()).max(50).default([]),
  components: z.array(componentSchema).max(30).default([]),
}).strict();
const updateTicketSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(5000).optional(),
  parentId: z.string().nullable().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  assigneeIds: z.array(z.string()).max(50).optional(),
  components: z.array(componentSchema).max(30).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.");
const suggestionSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).default(""),
}).strict();
const createEdgeSchema = z.object({
  sourceId: z.string(),
  targetId: z.string(),
  type: z.literal("dependency").default("dependency"),
  metadata: z.record(z.string(), z.string()).default({}),
}).strict();
const updateEdgeSchema = z.object({
  style: z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(1).max(8),
    dashed: z.boolean(),
  }).strict(),
}).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, "VALIDATION_ERROR", result.error.issues[0]?.message ?? "Dados inválidos.");
  return result.data;
}

function projectOrThrow(database: Database, projectId: string) {
  const project = database.projects.find((item) => item.id === projectId);
  if (!project) throw new HttpError(404, "PROJECT_NOT_FOUND", "Projeto não encontrado.");
  return project;
}

function ticketOrThrow(database: Database, ticketId: string) {
  const ticket = database.tickets.find((item) => item.id === ticketId);
  if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket não encontrado.");
  return ticket;
}

function assertPeople(database: Database, assigneeIds: string[], components: TicketComponent[]) {
  const userIds = new Set(database.users.map((user) => user.id));
  const allIds = [...assigneeIds, ...components.flatMap((component) => component.assigneeIds)];
  const hasDuplicate = new Set(assigneeIds).size !== assigneeIds.length
    || components.some((component) => new Set(component.assigneeIds).size !== component.assigneeIds.length);
  if (hasDuplicate) {
    throw new HttpError(400, "DUPLICATE_ASSIGNEE", "Há responsáveis repetidos na mesma lista.");
  }
  if (allIds.some((id) => !userIds.has(id))) {
    throw new HttpError(400, "USER_NOT_FOUND", "Um ou mais responsáveis não existem.");
  }
  const names = components.map((component) => component.name.toLocaleLowerCase());
  if (new Set(names).size !== names.length) {
    throw new HttpError(400, "DUPLICATE_COMPONENT", "Os componentes devem ter nomes distintos.");
  }
}

function hierarchyEdge(projectId: string, parentId: string, targetId: string): TicketEdge {
  return {
    id: randomUUID(),
    projectId,
    sourceId: parentId,
    targetId,
    type: "hierarchy",
    style: { color: "#b7b2c6", width: 2, dashed: false },
    metadata: { meaning: "parent-child" },
    createdAt: new Date().toISOString(),
  };
}

export async function registerRoutes(app: FastifyInstance, repository: TreeRepository) {
  app.get("/api/health", async () => ({
    status: "ok",
    persistence: "local-json-atomic",
    jev: process.env.TYPESAFE_API_KEY ? "configured" : "manual-fallback",
  }));

  app.get("/api/bootstrap", async () => repository.snapshot());
  app.get("/api/projects", async () => (await repository.snapshot()).projects);
  app.get("/api/users", async () => (await repository.snapshot()).users);
  app.get("/api/projects/:projectId", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const database = await repository.snapshot();
    const project = projectOrThrow(database, projectId);
    return {
      project,
      tickets: database.tickets.filter((ticket) => ticket.projectId === projectId),
      edges: database.edges.filter((edge) => edge.projectId === projectId),
      users: database.users,
    };
  });

  app.post("/api/projects/:projectId/tickets/suggest", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const input = parse(suggestionSchema, request.body);
    const database = await repository.snapshot();
    projectOrThrow(database, projectId);
    return suggestClassification(database, projectId, input);
  });

  app.post("/api/projects/:projectId/tickets", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const input = parse(createTicketSchema, request.body);
    const ticket = await repository.mutate((database) => {
      projectOrThrow(database, projectId);
      const projectTickets = database.tickets.filter((item) => item.projectId === projectId);
      const parentError = validateParent(projectTickets, null, input.parentId);
      if (parentError) throw new HttpError(400, "INVALID_PARENT", parentError);
      assertPeople(database, input.assigneeIds, input.components);
      const now = new Date().toISOString();
      const created = {
        id: randomUUID(),
        projectId,
        sequence: Math.max(0, ...projectTickets.map((item) => item.sequence)) + 1,
        parentId: input.parentId,
        title: input.title,
        description: input.description,
        status: input.status,
        assigneeIds: [...new Set(input.assigneeIds)],
        components: input.components,
        createdAt: now,
        updatedAt: now,
      };
      database.tickets.push(created);
      if (input.parentId) database.edges.push(hierarchyEdge(projectId, input.parentId, created.id));
      return created;
    });
    return reply.code(201).send(ticket);
  });

  app.patch("/api/tickets/:ticketId", async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const input = parse(updateTicketSchema, request.body);
    return repository.mutate((database) => {
      const ticket = ticketOrThrow(database, ticketId);
      const projectTickets = database.tickets.filter((item) => item.projectId === ticket.projectId);
      if (input.status !== undefined && childrenOf(projectTickets, ticket.id).length > 0) {
        throw new HttpError(409, "PARENT_STATUS_DERIVED", "O status de um pai é derivado das folhas e não pode ser editado.");
      }
      if (input.parentId !== undefined) {
        const parentError = validateParent(projectTickets, ticket.id, input.parentId);
        if (parentError) throw new HttpError(409, "INVALID_PARENT", parentError);
        database.edges = database.edges.filter((edge) => !(edge.type === "hierarchy" && edge.targetId === ticket.id));
        if (input.parentId) database.edges.push(hierarchyEdge(ticket.projectId, input.parentId, ticket.id));
      }
      assertPeople(database, input.assigneeIds ?? ticket.assigneeIds, input.components ?? ticket.components);
      Object.assign(ticket, input, { updatedAt: new Date().toISOString() });
      return ticket;
    });
  });

  app.delete("/api/tickets/:ticketId", async (request) => {
    const { ticketId } = request.params as { ticketId: string };
    const { recursive } = request.query as { recursive?: string };
    return repository.mutate((database) => {
      const ticket = ticketOrThrow(database, ticketId);
      const descendants = descendantIds(database.tickets, ticket.id);
      if (descendants.size > 0 && recursive !== "true") {
        throw new HttpError(409, "HAS_CHILDREN", "Este ticket tem descendentes. Repita com recursive=true para excluir toda a subárvore.");
      }
      const removedIds = new Set([ticket.id, ...descendants]);
      database.tickets = database.tickets.filter((item) => !removedIds.has(item.id));
      database.edges = database.edges.filter((edge) => !removedIds.has(edge.sourceId) && !removedIds.has(edge.targetId));
      return { deletedIds: [...removedIds], recursive: descendants.size > 0 };
    });
  });

  app.post("/api/projects/:projectId/edges", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const input = parse(createEdgeSchema, request.body);
    const edge = await repository.mutate((database) => {
      projectOrThrow(database, projectId);
      const source = ticketOrThrow(database, input.sourceId);
      const target = ticketOrThrow(database, input.targetId);
      if (source.projectId !== projectId || target.projectId !== projectId) {
        throw new HttpError(400, "CROSS_PROJECT_EDGE", "Dependências devem pertencer ao mesmo projeto.");
      }
      const dependencies = database.edges.filter((item) => item.projectId === projectId);
      if (dependencies.some((item) => item.type === "dependency" && item.sourceId === source.id && item.targetId === target.id)) {
        throw new HttpError(409, "DUPLICATE_DEPENDENCY", "Esta dependência já existe.");
      }
      if (createsDependencyCycle(dependencies, source.id, target.id)) {
        throw new HttpError(409, "DEPENDENCY_CYCLE", "A ligação criaria um ciclo ou ligaria o ticket a si mesmo.");
      }
      const created: TicketEdge = {
        id: randomUUID(),
        projectId,
        sourceId: source.id,
        targetId: target.id,
        type: "dependency",
        style: { color: "#d18445", width: 2, dashed: true },
        metadata: input.metadata,
        createdAt: new Date().toISOString(),
      };
      database.edges.push(created);
      return created;
    });
    return reply.code(201).send(edge);
  });

  app.patch("/api/edges/:edgeId", async (request) => {
    const { edgeId } = request.params as { edgeId: string };
    const input = parse(updateEdgeSchema, request.body);
    return repository.mutate((database) => {
      const edge = database.edges.find((item) => item.id === edgeId);
      if (!edge) throw new HttpError(404, "EDGE_NOT_FOUND", "Conexão não encontrada.");
      edge.style = input.style;
      return edge;
    });
  });

  app.delete("/api/edges/:edgeId", async (request) => {
    const { edgeId } = request.params as { edgeId: string };
    return repository.mutate((database) => {
      const edge = database.edges.find((item) => item.id === edgeId);
      if (!edge) throw new HttpError(404, "EDGE_NOT_FOUND", "Conexão não encontrada.");
      if (edge.type === "hierarchy") {
        throw new HttpError(409, "HIERARCHY_EDGE_PROTECTED", "Altere o pai do ticket; não exclua uma aresta hierárquica isoladamente.");
      }
      database.edges = database.edges.filter((item) => item.id !== edgeId);
      return { deletedId: edgeId };
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const frameworkError = error as { statusCode?: number; code?: string; message?: string };
    if (frameworkError.statusCode && frameworkError.statusCode >= 400 && frameworkError.statusCode < 500) {
      return reply.code(frameworkError.statusCode).send({ error: frameworkError.code ?? "BAD_REQUEST", message: frameworkError.message ?? "Requisição inválida." });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Erro interno inesperado." });
  });
}

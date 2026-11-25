import { Logger } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { retryableConflict } from "../common/error.filter.js";
import { isConnectionWaitTimeout } from "../common/connection-wait.js";
import type { ProjectQueryService } from "../query/project-query.service.js";
import { PEOPLE_READ_TOOL_DEFINITIONS, PEOPLE_TOOL_DEFINITIONS, ProjectTools, TOOL_DEFINITIONS, ToolInputError } from "./mcp-tools.js";
import type { PeopleSource, RunInTenant, ToolContext } from "./mcp-tools.js";
import { PEOPLE_WRITE_TOOL_DEFINITIONS, WRITE_TOOL_DEFINITIONS, WRITE_TOOL_NAMES, WriteTools, refusalMessage } from "./mcp-write-tools.js";
import type { WriteContext, WriteServices } from "./mcp-write-tools.js";

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const GENERIC_ERROR = "Something went wrong while reading the project. Try again.";
const GENERIC_WRITE_ERROR = "Something went wrong and nothing was changed.";
const SERVER_BUSY = "The server is busy. Try again in a moment.";
const MAX_MESSAGE = 200;

/**
 * Erro de ferramenta de uma frase só: sem quebras de linha, curto e só ASCII (caracteres fora de ASCII viram `?`; nenhum
 * detalhe interno sai pelo protocolo). Entrada inválida continua sendo uma frase de entrada inválida.
 */
function toolError(message: string): CallToolResult {
  const oneLine = message.replace(/\s+/g, " ").trim().replace(/[^\x20-\x7e]/g, "?");
  const short = oneLine.length > MAX_MESSAGE ? `${oneLine.slice(0, MAX_MESSAGE - 3)}...` : oneLine;
  return { content: [{ type: "text", text: short.length > 0 ? short : GENERIC_ERROR }], isError: true };
}

const logger = new Logger("McpTools");

/** Resultado de sucesso: o objeto estruturado e o mesmo JSON como texto, como a especificação recomenda. */
function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export async function guarded(name: string, work: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    if (error instanceof ToolInputError) return toolError(error.message);
    // A espera por conexão do pool estourou (ADR 0045, adendo 1): "tente de novo", sem texto do Prisma.
    if (isConnectionWaitTimeout(error)) return toolError(SERVER_BUSY);
    if (retryableConflict(error) !== null) return toolError("Another change happened at the same time. Try again in a moment.");
    const refusal = refusalMessage(error);
    if (refusal !== null) return toolError(refusal);
    // Falha de verdade (banco, bug): fica no log só com a mensagem, sem argumentos nem resultados; o cliente recebe uma frase genérica.
    logger.error(`tool ${name} failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    return toolError((WRITE_TOOL_NAMES as readonly string[]).includes(name) ? GENERIC_WRITE_ERROR : GENERIC_ERROR);
  }
}

/**
 * Monta o servidor MCP de UMA requisição, para o projeto e a identidade já resolvidos pelo token. O código das
 * ferramentas não vê o token.
 */
export function createProjectServer(
  run: RunInTenant,
  query: ProjectQueryService,
  context: ToolContext,
  write?: { services: WriteServices; context: WriteContext },
  peopleSource?: PeopleSource,
): McpServer {
  const server = new McpServer(
    { name: "treepm", version: "0.1.0" },
    {
      instructions: `${write ? "Access to" : "Read-only access to"} the tickets of project ${context.project.key} in TreePM. Tickets form a tree; start with get_project_overview, then search_tickets, list_tickets and get_ticket.`,
    },
  );
  // Toda falha de uma ferramenta, inclusive a validação da entrada que o SDK faz antes do nosso código, vira resultado
  // com `isError`; o SDK 2.4.0 monta esse resultado em `createToolError` (privado no tipo, método comum em execução).
  // Trocá-lo encurta a mensagem do SDK para uma frase e impede que detalhe interno saia pelo protocolo. O teste das
  // entradas inválidas cobre a troca, e a versão do SDK é exata no package.json.
  if (typeof (server as unknown as Record<string, unknown>)["createToolError"] !== "function") throw new Error("SDK sem createToolError: revisar a troca em mcp-server.ts.");
  Object.defineProperty(server, "createToolError", { value: toolError });
  // O alcance de pessoas (ADR 0062) só vale com a fonte das pessoas na mão: sem ela o servidor é montado como sem o alcance.
  const people = context.people === true && peopleSource !== undefined;
  const tools = new ProjectTools(run, query, { ...context, people }, peopleSource);
  const register = people ? PEOPLE_TOOL_DEFINITIONS : TOOL_DEFINITIONS;
  server.registerTool("search_tickets", { ...register.search_tickets, annotations: ANNOTATIONS }, (input) => guarded("search_tickets", () => tools.searchTickets(input)));
  server.registerTool("get_ticket", { ...register.get_ticket, annotations: ANNOTATIONS }, (input) => guarded("get_ticket", () => tools.getTicket(input)));
  server.registerTool("list_tickets", { ...register.list_tickets, annotations: ANNOTATIONS }, (input) => guarded("list_tickets", () => tools.listTickets(input)));
  server.registerTool("get_work_queue", { ...register.get_work_queue, annotations: ANNOTATIONS }, (input) => guarded("get_work_queue", () => tools.getWorkQueue(input)));
  server.registerTool("get_project_overview", { ...register.get_project_overview, annotations: ANNOTATIONS }, () => guarded("get_project_overview", () => tools.getProjectOverview()));
  if (people) server.registerTool("list_people", { ...PEOPLE_READ_TOOL_DEFINITIONS.list_people, annotations: ANNOTATIONS }, () => guarded("list_people", () => tools.listPeople()));
  // Escrita (ADR 0043): só para token de escrita com a chave da organização ligada. Fora disso as ferramentas nem existem.
  if (write) {
    const writer = new WriteTools(run, write.services, tools, write.context);
    server.registerTool("update_ticket_status", { ...WRITE_TOOL_DEFINITIONS.update_ticket_status, annotations: WRITE_ANNOTATIONS }, (input) => guarded("update_ticket_status", () => writer.updateTicketStatus(input)));
    server.registerTool("add_comment", { ...WRITE_TOOL_DEFINITIONS.add_comment, annotations: WRITE_ANNOTATIONS }, (input) => guarded("add_comment", () => writer.addComment(input)));
    server.registerTool("set_ticket_priority", { ...WRITE_TOOL_DEFINITIONS.set_ticket_priority, annotations: WRITE_ANNOTATIONS }, (input) => guarded("set_ticket_priority", () => writer.setTicketPriority(input)));
    server.registerTool("create_ticket", { ...WRITE_TOOL_DEFINITIONS.create_ticket, annotations: WRITE_ANNOTATIONS }, (input) => guarded("create_ticket", () => writer.createTicket(input)));
    server.registerTool("update_ticket", { ...WRITE_TOOL_DEFINITIONS.update_ticket, annotations: WRITE_ANNOTATIONS }, (input) => guarded("update_ticket", () => writer.updateTicket(input)));
    server.registerTool("move_ticket", { ...WRITE_TOOL_DEFINITIONS.move_ticket, annotations: WRITE_ANNOTATIONS }, (input) => guarded("move_ticket", () => writer.moveTicket(input)));
    server.registerTool("add_dependency", { ...WRITE_TOOL_DEFINITIONS.add_dependency, annotations: WRITE_ANNOTATIONS }, (input) => guarded("add_dependency", () => writer.addDependency(input)));
    server.registerTool("remove_dependency", { ...WRITE_TOOL_DEFINITIONS.remove_dependency, annotations: WRITE_ANNOTATIONS }, (input) => guarded("remove_dependency", () => writer.removeDependency(input)));
    if (people) server.registerTool("set_ticket_assignees", { ...PEOPLE_WRITE_TOOL_DEFINITIONS.set_ticket_assignees, annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true } }, (input) => guarded("set_ticket_assignees", () => writer.setTicketAssignees(input)));
    server.registerTool("set_agent_work", { ...WRITE_TOOL_DEFINITIONS.set_agent_work, annotations: WRITE_ANNOTATIONS }, (input) => guarded("set_agent_work", () => writer.setAgentWork(input)));
  }
  return server;
}

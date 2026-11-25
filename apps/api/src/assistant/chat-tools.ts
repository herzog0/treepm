import { NotFoundException } from "@nestjs/common";
import { z } from "zod";
import type { TenantRunner } from "../db/own-transactions.js";
import type { ProjectQueryService } from "../query/project-query.service.js";
import { ProjectToolExecutor, ToolInputError, parseToolInput } from "./ask-executor.js";
import type { Labeler } from "./ask-executor.js";
import { listTicketsInput, searchTicketsInput } from "./ask-tools.js";
import { hasForbiddenChatChars } from "@treepm/domain";
import type { DraftToolState, ToolExecutor, ToolOutcome } from "./ports.js";
import { DRAFT_BLOCKED, TOOL_DATA_HEADER } from "./prompts.js";

/**
 * As ferramentas de consulta das conversas (ADR 0056, item 2): as quatro da pergunta sobre o projeto, agora sobre todos os projetos
 * que a pessoa enxerga. O ticket vai pela chave de verdade (`TREEPM-88`) e o projeto nos argumentos (`project`: `TREEPM`); "atribuídos a quem pergunta" é um
 * filtro (`assigned_to_me`) que o servidor aplica, sem nome, e-mail nem identificador de pessoa no caminho.
 */

const project = z.string().trim().describe("Chave do projeto, como TREEPM (a lista de projetos vem no contexto).");
const ticketKey = z.string().trim().describe("Chave do ticket, como TREEPM-88.");
const assignedToMe = z.boolean().optional().describe("Só os tickets atribuídos a quem está perguntando. O servidor aplica o filtro; você nunca vê nomes.");

export const chatSearchInput = searchTicketsInput.extend({
  project: project.optional().describe("Chave do projeto, como TREEPM. Sem ele a busca vale para todos os projetos."),
  assigned_to_me: assignedToMe,
});
export const chatReadInput = z.strictObject({ ticket: ticketKey });
/** Teto de custo por chamada (ADR 0056): a lista das conversas é menor que a da pergunta sobre o projeto. */
export const CHAT_LIST_DEFAULT_LIMIT = 20;
export const CHAT_LIST_MAX_LIMIT = 50;
/** Quantos projetos uma busca sem `project` percorre, no máximo, e o tamanho máximo do JSON de um resultado. */
export const CHAT_SEARCH_MAX_PROJECTS = 5;
export const CHAT_RESULT_MAX_CHARS = 20_000;
export const chatListInput = listTicketsInput.extend({
  project,
  under: ticketKey.optional().describe("Só os descendentes deste ticket (chave), em todos os níveis (o próprio ticket não entra)."),
  after: ticketKey.optional().describe("Chave devolvida em `after` pela página anterior; devolve só tickets depois dela."),
  assigned_to_me: assignedToMe,
  limit: z.number().int().min(1).max(CHAT_LIST_MAX_LIMIT).optional().describe(`Tamanho da página (padrão ${CHAT_LIST_DEFAULT_LIMIT}, máximo ${CHAT_LIST_MAX_LIMIT}).`),
});
export const chatOverviewInput = z.strictObject({ project });

/** O pedido que abre o rascunho: uma ou duas frases. A ferramenta não aceita projeto, lugar nem nada além disto (ADR 0056, item 5). */
export const DRAFT_REQUEST_MAX = 600;
export const openDraftInput = z.strictObject({
  request: z
    .string()
    .trim()
    .min(1)
    .max(DRAFT_REQUEST_MAX)
    .refine((text) => !hasForbiddenChatChars(text), "caractere inválido")
    .describe("O que a pessoa quer que o ticket novo seja, em uma ou duas frases, nas palavras dela."),
});

export const CHAT_TOOLS = [
  {
    name: "search_tickets",
    description:
      "Procura tickets por texto, no título e na descrição, num projeto (`project`) ou em todos. Devolve resumos (rótulo, título, trecho da descrição, situação, pai) dos que melhor casam. Com `assigned_to_me` só os atribuídos a quem pergunta.",
    schema: chatSearchInput,
  },
  {
    name: "read_ticket",
    description:
      "Lê um ticket inteiro pela chave (como TREEPM-88): descrição completa, situação, pai, caminho do topo até o pai, filhos e ligações nos dois sentidos. `mentions.outgoing`: tickets que este cita no texto; `mentions.incoming`: tickets que citam este. `depends_on.outgoing`: tickets que precisam estar prontos antes deste; `depends_on.incoming`: tickets que esperam por este.",
    schema: chatReadInput,
  },
  {
    name: "list_tickets",
    description:
      "Lista resumos de tickets de UM projeto (`project`), em ordem de número, com filtro de situação, de ramo (`under`) e `assigned_to_me` (o que está com quem pergunta). Quando `truncated` for verdadeiro há mais: peça a página seguinte com `after`. Para o que está com a pessoa em todos os projetos, liste um projeto por vez.",
    schema: chatListInput,
  },
  {
    name: "project_overview",
    description: "Visão geral de um projeto (`project`): total de tickets, contagem por situação e os tickets do topo da árvore com o progresso de cada um.",
    schema: chatOverviewInput,
  },
] as const;

/**
 * A única ferramenta que não consulta: abre a thread de criação de ticket (ADR 0056, item 5). Ela NÃO cria ticket: o rascunho nasce com a
 * pessoa, que o confirma ou descarta, e a vez do assistente termina na chamada. Só é oferecida onde o assistente fala sozinho com a pessoa.
 */
export const OPEN_DRAFT_TOOL = {
  name: "open_ticket_draft",
  description:
    "Abre um rascunho de ticket novo para a pessoa revisar, quando ela pedir para criar um ticket. Você NÃO cria o ticket: o rascunho abre numa thread própria, onde ela confirma ou descarta. Ao chamar, a sua vez termina; não escreva resposta. Argumento: só o pedido dela, em uma ou duas frases.",
  schema: openDraftInput,
} as const;

/** As definições no formato do SDK, geradas do mesmo esquema que valida a entrada. `withDraft`: inclui a ferramenta que abre o rascunho. */
export function chatToolDefinitions(withDraft = false): { name: string; description: string; input_schema: { type: "object"; [key: string]: unknown } }[] {
  return [...CHAT_TOOLS, ...(withDraft ? [OPEN_DRAFT_TOOL] : [])].map((tool) => {
    const schema: { type: "object"; [key: string]: unknown } = { ...(z.toJSONSchema(tool.schema, { io: "input" }) as Record<string, unknown>), type: "object" };
    delete schema["$schema"];
    return { name: tool.name, description: tool.description, input_schema: schema };
  });
}

export type ChatProject = { id: string; key: string };

/** A chave que o modelo escreveu (`TREEPM-88`, `treepm-88`, `#TREEPM-88`) em forma canônica; `null` se não tem forma de chave. */
function parseKey(text: string): { project: string; number: number } | null {
  const match = /^#?([A-Za-z][A-Za-z0-9]*)-([1-9]\d{0,8})$/.exec(text.trim());
  return match ? { project: (match[1] as string).toUpperCase(), number: Number(match[2]) } : null;
}

/** As chaves de verdade nos dois sentidos: o que o modelo vê é o que está guardado. */
function projectLabeler(key: string): Labeler {
  return {
    label: (number) => `${key}-${number}`,
    parse: (text) => {
      const parsed = parseKey(text);
      return parsed && parsed.project === key.toUpperCase() ? parsed.number : null;
    },
    example: "TREEPM-88",
  };
}

/** Resultado grande demais é cortado (o aviso vai dentro do próprio dado, que continua sendo um JSON válido). */
function capped(json: string): string {
  if (json.length <= CHAT_RESULT_MAX_CHARS) return json;
  return JSON.stringify({ truncated_by_server: true, warning: "Resultado grande demais: só o começo está em partial_json. Peça menos (limit menor, outro filtro ou um ticket só).", partial_json: json.slice(0, CHAT_RESULT_MAX_CHARS) });
}

/** Projeto ou ticket que não existe e projeto ou ticket que a pessoa não enxerga: a mesma mensagem. */
const notFound = (what: "ticket" | "project", text: string): ToolInputError => {
  const parsed = what === "ticket" ? parseKey(text) : null;
  const shown = parsed ? `${parsed.project}-${parsed.number}` : text.trim().replace(/^#/, "").toUpperCase();
  return new ToolInputError(what === "ticket" ? `Ticket ${shown} não existe neste projeto.` : `Projeto ${shown} não existe.`);
};

/**
 * Executa as ferramentas das conversas sobre `ProjectQueryService`, que confere a visibilidade a CADA execução. Projeto que a pessoa
 * não enxerga não está na lista de rótulos: um rótulo dele responde igual a ticket inexistente. Cada execução abre a sua transação,
 * curta; nada fica aberto enquanto o provedor pensa.
 */
export class ChatToolExecutor implements ToolExecutor {
  private readonly executors = new Map<string, ProjectToolExecutor>();
  private readonly byKey = new Map<string, ChatProject>();

  /** `projects`: os que a pessoa enxerga e não estão arquivados; qualquer outra chave responde como inexistente. */
  constructor(
    tenant: TenantRunner,
    query: ProjectQueryService,
    private readonly projects: readonly ChatProject[],
    private readonly draftTool: DraftToolState | null = null,
    /** Chamada quando o modelo pede o rascunho e a ferramenta sai bloqueada por rascunho aberto (a pessoa precisa vê-lo na barra). */
    private readonly onDraftOpen: (() => Promise<void>) | null = null,
  ) {
    for (const entry of projects) {
      this.byKey.set(entry.key.toUpperCase(), entry);
      this.executors.set(entry.id, new ProjectToolExecutor(tenant, query, entry.id, projectLabeler(entry.key)));
    }
  }

  async execute(name: string, input: unknown): Promise<ToolOutcome> {
    try {
      if (name === OPEN_DRAFT_TOOL.name && this.draftTool !== null) {
        const { request } = parseToolInput([OPEN_DRAFT_TOOL], name, input) as { request: string };
        // Bloqueada (vários projetos possíveis, rascunho já aberto): o motivo volta ao modelo, que o diz à pessoa; nada é aberto.
        if (this.draftTool.kind === "blocked") {
          // Falha ao reabrir não esconde a resposta ao modelo: o motivo continua valendo.
          if (this.draftTool.reason === "draft_open") await this.onDraftOpen?.().catch(() => undefined);
          return { content: DRAFT_BLOCKED[this.draftTool.reason], isError: true };
        }
        return { content: "Rascunho aberto.", isError: false, openDraft: request };
      }
      const args = parseToolInput(CHAT_TOOLS, name, input);
      // O resultado é dado, cercado como dado: o cabeçalho diz isso, e o JSON escapa quebras de linha do texto dos tickets.
      return { content: `${TOOL_DATA_HEADER}\n${capped(JSON.stringify(await this.run(name, args)))}`, isError: false };
    } catch (error) {
      if (error instanceof ToolInputError) return { content: error.message, isError: true };
      throw error;
    }
  }

  private executorOf(projectId: string): ProjectToolExecutor {
    const executor = this.executors.get(projectId);
    if (!executor) throw new Error("Projeto fora da lista.");
    return executor;
  }

  private projectArg(text: unknown): string {
    const found = typeof text === "string" ? this.byKey.get(text.trim().replace(/^#/, "").toUpperCase()) : undefined;
    if (!found) throw notFound("project", String(text));
    return found.id;
  }

  private async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      switch (name) {
        case "read_ticket": {
          const text = args["ticket"] as string;
          const parsed = parseKey(text);
          if (!parsed) throw new ToolInputError("Chave inválida: use o formato TREEPM-88.");
          const project = this.byKey.get(parsed.project);
          if (!project) throw notFound("ticket", text);
          return await this.executorOf(project.id).run(name, args);
        }
        case "list_tickets":
          return await this.executorOf(this.projectArg(args["project"])).run(name, { ...args, limit: args["limit"] ?? CHAT_LIST_DEFAULT_LIMIT });
        case "search_tickets": {
          if (args["project"] !== undefined) return await this.executorOf(this.projectArg(args["project"])).run(name, args);
          return await this.searchEverywhere(args);
        }
        default:
          return await this.executorOf(this.projectArg(args["project"])).run(name, args);
      }
    } catch (error) {
      // O projeto sumiu ou ficou invisível no meio da conversa: a mesma resposta de ticket que não existe.
      if (error instanceof NotFoundException && error.message === "Projeto não encontrado.") {
        throw notFound(name === "read_ticket" ? "ticket" : "project", String(args["ticket"] ?? args["project"] ?? ""));
      }
      throw error;
    }
  }

  /** Busca nos projetos da lista (no máximo `CHAT_SEARCH_MAX_PROJECTS`); o corte vale para o conjunto. */
  private async searchEverywhere(args: Record<string, unknown>): Promise<unknown> {
    const limit = typeof args["limit"] === "number" ? args["limit"] : 8;
    const tickets: unknown[] = [];
    const scanned = this.projects.slice(0, CHAT_SEARCH_MAX_PROJECTS);
    let truncated = this.projects.length > scanned.length;
    for (const entry of scanned) {
      try {
        const found = (await this.executorOf(entry.id).run("search_tickets", { ...args, limit })) as { tickets: unknown[]; truncated: boolean };
        tickets.push(...found.tickets);
        truncated ||= found.truncated;
      } catch (error) {
        // Um projeto que deixou de ser visível no meio da conversa simplesmente não entra.
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    return { tickets: tickets.slice(0, limit), truncated: truncated || tickets.length > limit };
  }
}

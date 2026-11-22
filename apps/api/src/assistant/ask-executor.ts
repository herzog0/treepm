import { NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { TicketStatus } from "@treepm/domain";
import type { TenantRunner } from "../db/own-transactions.js";
import type { ProjectQueryService } from "../query/project-query.service.js";
import type { QueryOverview, QueryTicket, QueryTicketList, QueryTicketPage, QueryTicketSummary } from "../query/query.schema.js";
import { fromNeutralLabels, labelOf, parseLabel, toNeutralLabels } from "./ask-labels.js";
import { ASK_TOOLS } from "./ask-tools.js";
import type { ToolExecutor, ToolOutcome } from "./ports.js";

/** Entrada do modelo que não vale: vira resultado de ferramenta com erro, nunca uma falha da pergunta. */
class ToolInputError extends Error {}

/** O que o modelo vê de um ticket nas listas: o rótulo no lugar de id, chave, número e parentId. */
type Brief = { label: string; title: string; excerpt: string; status: TicketStatus; parent: string | null };
type BriefList = { tickets: Brief[]; truncated: boolean };

const everyLabel = { has: () => true };

/**
 * Executa as ferramentas da pergunta sobre o projeto (ADR 0037) sobre a camada de consulta, em rótulos neutros. Cada
 * execução abre a sua transação, curta (`TenantRunner`): permissões são conferidas de novo a cada uma, e nada fica
 * aberto enquanto o provedor pensa. O que volta ao modelo é a saída reduzida e já convertida para rótulos.
 */
export class ProjectToolExecutor implements ToolExecutor {
  constructor(
    private readonly tenant: TenantRunner,
    private readonly query: ProjectQueryService,
    private readonly projectId: string,
    private readonly projectKey: string,
  ) {}

  async execute(name: string, input: unknown): Promise<ToolOutcome> {
    try {
      return { content: JSON.stringify(await this.run(name, input)), isError: false };
    } catch (error) {
      if (error instanceof ToolInputError) return { content: error.message, isError: true };
      throw error;
    }
  }

  private async run(name: string, input: unknown): Promise<unknown> {
    const tool = ASK_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) throw new ToolInputError("Ferramenta desconhecida. Use search_tickets, read_ticket, list_tickets ou project_overview.");
    const parsed = tool.schema.safeParse(input ?? {});
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(raiz)"))].join(", ");
      throw new ToolInputError(`Entrada inválida em: ${fields}.`);
    }
    const args = parsed.data as Record<string, unknown>;
    switch (tool.name) {
      case "search_tickets":
        return this.tenant.run(async (tx, principal) => {
          // O modelo só conhece rótulos; a busca é pelo texto e pela chave real.
          const text = fromNeutralLabels(args["query"] as string, this.projectKey, everyLabel);
          const found = await this.query.search(tx, principal, this.projectId, text, args["limit"] === undefined ? {} : { limit: args["limit"] as number });
          return this.briefList(tx, found);
        });
      case "read_ticket": {
        const number = this.number(args["ticket"] as string);
        return this.tenant.run(async (tx, principal) => this.reduceTicket(tx, await this.found(number, () => this.query.ticket(tx, principal, this.projectId, number))));
      }
      case "list_tickets": {
        const under = args["under"] === undefined ? undefined : this.number(args["under"] as string);
        const after = args["after"] === undefined ? undefined : this.number(args["after"] as string);
        return this.tenant.run(async (tx, principal) => {
          const page = await this.found(under ?? 0, () =>
            this.query.list(tx, principal, this.projectId, {
              ...(args["status"] ? { status: args["status"] as TicketStatus[] } : {}),
              ...(under !== undefined ? { under } : {}),
              ...(after !== undefined ? { after } : {}),
              ...(args["limit"] === undefined ? {} : { limit: args["limit"] as number }),
            }),
          );
          return { ...(await this.briefList(tx, page)), after: page.after === null ? null : labelOf(page.after) };
        });
      }
      default:
        return this.tenant.run(async (tx, principal) => this.reduceOverview(tx, await this.query.overview(tx, principal, this.projectId)));
    }
  }

  private number(label: string): number {
    const number = parseLabel(label);
    if (number === null) throw new ToolInputError("Rótulo inválido: use o formato T47.");
    return number;
  }

  /** Ticket inexistente no projeto é erro do modelo; projeto que sumiu ou ficou invisível (outra mensagem) sobe como 404. */
  private async found<T>(number: number, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof NotFoundException && error.message === "Ticket não encontrado.") throw new ToolInputError(`Ticket ${labelOf(number)} não existe neste projeto.`);
      throw error;
    }
  }

  private neutral(text: string): string {
    return toNeutralLabels(text, this.projectKey);
  }

  /** O trecho cortado (termina em "…") perde a última palavra: uma chave cortada ao meio não pode virar rótulo errado nem vazar. */
  private excerpt(text: string): string {
    return text.endsWith("…") ? `${this.neutral(text.slice(0, -1).replace(/\S+$/, ""))}…` : this.neutral(text);
  }

  /** Número do pai de cada resumo: os que já estão no resultado, mais uma consulta para os que faltam. */
  private async numbersById(tx: TenantClient, summaries: readonly QueryTicketSummary[]): Promise<Map<string, number>> {
    const byId = new Map(summaries.map((summary) => [summary.id, summary.number]));
    const missing = [...new Set(summaries.map((summary) => summary.parentId).filter((id): id is string => id !== null && !byId.has(id)))];
    if (missing.length > 0) {
      for (const row of await tx.ticket.findMany({ where: { projectId: this.projectId, id: { in: missing } }, select: { id: true, number: true } })) byId.set(row.id, row.number);
    }
    return byId;
  }

  private brief(summary: QueryTicketSummary, numbers: ReadonlyMap<string, number>): Brief {
    const parent = summary.parentId === null ? undefined : numbers.get(summary.parentId);
    return {
      label: labelOf(summary.number),
      title: this.neutral(summary.title),
      excerpt: this.excerpt(summary.descriptionExcerpt),
      status: summary.status,
      parent: parent === undefined ? null : labelOf(parent),
    };
  }

  private async briefList(tx: TenantClient, list: QueryTicketList | QueryTicketPage): Promise<BriefList> {
    const numbers = await this.numbersById(tx, list.tickets);
    return { tickets: list.tickets.map((summary) => this.brief(summary, numbers)), truncated: list.truncated };
  }

  private async reduceTicket(tx: TenantClient, ticket: QueryTicket): Promise<unknown> {
    const { relations } = ticket;
    const lists = [ticket.children, relations.mentions.outgoing, relations.mentions.incoming, relations.dependsOn.outgoing, relations.dependsOn.incoming];
    const numbers = await this.numbersById(tx, [ticket, ...ticket.path, ...lists.flatMap((list) => list.tickets)]);
    const reduce = (list: QueryTicketList): BriefList => ({ tickets: list.tickets.map((summary) => this.brief(summary, numbers)), truncated: list.truncated });
    const directions = (pair: { outgoing: QueryTicketList; incoming: QueryTicketList }) => ({ outgoing: reduce(pair.outgoing), incoming: reduce(pair.incoming) });
    const self = this.brief(ticket, numbers);
    return {
      label: self.label,
      title: self.title,
      status: self.status,
      description: this.neutral(ticket.description),
      parent: self.parent,
      path: ticket.path.map((summary) => this.brief(summary, numbers)),
      children: reduce(ticket.children),
      relations: { mentions: directions(relations.mentions), depends_on: directions(relations.dependsOn) },
    };
  }

  private async reduceOverview(tx: TenantClient, overview: QueryOverview): Promise<unknown> {
    const numbers = await this.numbersById(tx, overview.top.tickets);
    return {
      total: overview.total,
      by_status: overview.byStatus,
      top: {
        tickets: overview.top.tickets.map((summary) => ({ ...this.brief(summary, numbers), progress: summary.progress })),
        truncated: overview.top.truncated,
      },
    };
  }
}

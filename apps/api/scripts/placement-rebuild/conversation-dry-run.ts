import { readFileSync } from "node:fs";
import { TicketCommandError, call, listRows, resolveNumber } from "./ticket-commands.js";
import type { Row, TicketContext } from "./ticket-commands.js";

/**
 * `conversation-dry-run`: o que a tela faz para um pedido novo (abre a conversa com o texto, recebe o rascunho e pede o lugar
 * proposto), sem criar ticket. A conversa aberta é descartada no fim, com sucesso ou erro. A procura de lugar da API grava o
 * resumo dos agrupadores que ainda não tinham (`createMany` em `placement.service.ts`); isso não dá para evitar daqui e o
 * comando lista quais foram em `summariesCreated`.
 */
export type ConversationDryRunInput = { textFile: string; scope?: number };

type Draft = { title: string; description: string; children: { title: string; description: string }[]; idea: boolean } | null;
type Conversation = { id: string; draft: Draft; ready: boolean };
type Target = { parentId: string | null; path: { id: string; title: string }[] };
type Outcome = { destination: Target; alternatives: Target[]; discarded: unknown[]; [rest: string]: unknown };

export async function conversationDryRunCommand(ctx: TicketContext, input: ConversationDryRunInput): Promise<void> {
  let text: string;
  try {
    text = readFileSync(input.textFile, "utf8");
  } catch {
    throw new TicketCommandError(`Não consegui ler o arquivo do pedido ${input.textFile}.`);
  }
  const rows = await listRows(ctx);
  const scope = input.scope === undefined ? null : await resolveNumber(ctx, rows, input.scope);
  const scopeBody = scope ? { scopeId: scope.id } : {};

  const conversation = await call<Conversation>("abrir conversa", ctx, "POST", `/projects/${ctx.project}/ticket-conversations`, { message: text, ...scopeBody });
  let result: Record<string, unknown>;
  let discarded = false;
  try {
    if (!conversation.draft) throw new TicketCommandError("O assistente não montou um rascunho a partir do texto: não há o que procurar.");
    const branches = rows.filter((row) => rows.some((other) => other.parentId === row.id));
    const withSummary = async (): Promise<Set<string>> => {
      const found = new Set<string>();
      for (const branch of branches) {
        const view = await call<{ summary: unknown }>("ler resumo", ctx, "GET", `/tickets/${branch.id}/summary`);
        if (view.summary) found.add(branch.key);
      }
      return found;
    };
    const before = await withSummary();
    const outcome = await call<Outcome>("procurar o lugar", ctx, "POST", `/ticket-conversations/${conversation.id}/placement`, scopeBody);
    const after = await withSummary();

    const byId = new Map<string, Row>(rows.map((row) => [row.id, row]));
    const keyOf = (id: string | null): string | null => (id === null ? null : (byId.get(id)?.key ?? null));
    const target = (value: Target) => ({
      parentKey: keyOf(value.parentId),
      path: value.path.map((step) => ({ key: keyOf(step.id), title: step.title })),
    });
    const { destination, alternatives, ...decision } = outcome;
    result = {
      draft: conversation.draft,
      ready: conversation.ready,
      destination: target(destination),
      alternatives: alternatives.map(target),
      decision,
      summariesCreated: [...after].filter((key) => !before.has(key)),
    };
  } finally {
    discarded = (await ctx.client.request("DELETE", `/ticket-conversations/${conversation.id}`)).status === 204;
  }
  ctx.log(JSON.stringify({ ...result, conversationDiscarded: discarded, ...(discarded ? {} : { conversationId: conversation.id }) }));
}

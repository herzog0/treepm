import { TicketCommandError, call, listRows, resolveNumber } from "./ticket-commands.js";
import type { TicketContext } from "./ticket-commands.js";

/**
 * `chat-show` (TREEPM-403): a coordenação lê as conversas do usuário da ferramenta. Só leitura, só pelas rotas da API (a conversa de
 * quem roda o comando, com a mesma regra de visibilidade da tela): nada é aberto, criado nem marcado como lido. O autor sai como
 * `pessoa` ou `assistente`, sem nome.
 */
export type ChatShowInput = { general: true } | { ticket: number } | { thread: string };

type Message = { id: string; authorKind: "person" | "assistant"; body: string; createdAt: string; thread: Card | null };
type Card = { id: string; opening: { body: string }; replyCount: number; purpose: string; title: string | null };
type View = {
  conversation: { id: string; kind: string; purpose: string | null; title: string | null; trail: { id: string; kind: string; label: string | null; title: string | null }[]; opening: { body: string; createdAt: string; authorKind: string } | null } | null;
  ticket: { key: string; title: string } | null;
  messages: { items: Message[]; nextBefore: string | null };
  threads: Card[];
};
type Tree = { items: { id: string | null; kind: string }[] };

const TITLE_MAX = 80;
const title = (body: string): string => body.replace(/\s+/g, " ").slice(0, TITLE_MAX);
const PURPOSE: Record<string, string> = { people: "entre pessoas", topic: "assunto", creation: "novo ticket" };
const who = (kind: string): string => (kind === "assistant" ? "assistente" : "pessoa");

/** Todas as páginas de uma conversa (as mais recentes vêm primeiro; sai em ordem de hora). */
async function readAll(ctx: TicketContext, path: string): Promise<View> {
  const first = await call<View>("ler conversa", ctx, "GET", `${path}?limit=100`);
  const items = [...first.messages.items];
  for (let next = first.messages.nextBefore; next !== null; ) {
    const page = await call<View>("ler conversa", ctx, "GET", `${path}?limit=100&before=${encodeURIComponent(next)}`);
    items.push(...page.messages.items);
    next = page.messages.nextBefore;
  }
  return { ...first, messages: { items: items.reverse(), nextBefore: null } };
}

function print(ctx: TicketContext, heading: string, view: View): void {
  ctx.log(heading);
  const conversation = view.conversation;
  if (conversation?.kind === "thread") {
    ctx.log(`Trilha: ${conversation.trail.map((t) => (t.title ?? t.label ? `«${title(t.title ?? t.label ?? "")}»` : t.kind)).join(" > ") || "(esta thread é o ponto de entrada)"}`);
    ctx.log(`Propósito: ${PURPOSE[conversation.purpose ?? ""] ?? conversation.purpose ?? "?"}; título: ${conversation.title === null ? "(sem título)" : `«${conversation.title}»`}`);
    if (conversation.opening) ctx.log(`[${conversation.opening.createdAt}] ${who(conversation.opening.authorKind)} (abertura): ${conversation.opening.body}`);
  }
  if (view.messages.items.length === 0 && !conversation?.opening) ctx.log("(sem mensagens)");
  for (const message of view.messages.items) ctx.log(`[${message.createdAt}] ${who(message.authorKind)}: ${message.body}`);
  ctx.log(`Threads (${view.threads.length}):`);
  for (const thread of view.threads) {
    const kind = thread.purpose === "people" ? "" : ` [${PURPOSE[thread.purpose] ?? thread.purpose}]`;
    ctx.log(`- ${thread.id}${kind} «${title(thread.title ?? thread.opening.body)}» ${thread.replyCount} ${thread.replyCount === 1 ? "resposta" : "respostas"}`);
  }
}

export async function chatShowCommand(ctx: TicketContext, input: ChatShowInput): Promise<void> {
  if ("thread" in input) {
    // O id vai para o caminho da rota: só um uuid passa.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.thread)) throw new TicketCommandError("--thread pede o id (uuid) de uma thread.");
    print(ctx, `Thread ${input.thread}`, await readAll(ctx, `/conversations/${input.thread}`));
    return;
  }
  if ("general" in input) {
    // A árvore não cria nada (a rota de abrir criaria): o chat geral sem id é "ainda não existe".
    const tree = await call<Tree>("ler conversas", ctx, "GET", "/conversations");
    const id = tree.items.find((node) => node.kind === "general")?.id ?? null;
    if (id === null) throw new TicketCommandError("Meu chat ainda não existe para este usuário.");
    print(ctx, "Meu chat", await readAll(ctx, `/conversations/${id}`));
    return;
  }
  const row = await resolveNumber(ctx, await listRows(ctx), input.ticket);
  const view = await readAll(ctx, `/tickets/${row.id}/conversation`);
  if (view.conversation === null && view.threads.length === 0) throw new TicketCommandError(`Este usuário não tem conversa em ${row.key}.`);
  print(ctx, `Chat de ${row.key}${view.ticket ? ` — ${view.ticket.title}` : ""}`, view);
}

import type { TFunction } from "i18next";
import { fold, MAX_RESULTS, searchTickets } from "../../command/search.js";
import type { MentionContext } from "./decorations.js";
import type { MenuItem } from "./suggestions.js";

/** Os blocos do menu "/" (ADR 0036), com o atalho de markdown que faz o mesmo. */
export function blockItems(t: TFunction<"ticket">, query: string): MenuItem[] {
  const all: MenuItem[] = [
    { id: "text", label: t("blocks.text"), glyph: "T", hint: "", run: (editor, range) => void editor.chain().focus().deleteRange(range).setParagraph().run() },
    { id: "heading", label: t("blocks.heading"), glyph: "H", hint: "#", run: (editor, range) => void editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
    { id: "bulletList", label: t("blocks.bulletList"), glyph: "•", hint: "-", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleBulletList().run() },
    { id: "taskList", label: t("blocks.taskList"), glyph: "✓", hint: "[]", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleTaskList().run() },
    { id: "quote", label: t("blocks.quote"), glyph: "”", hint: ">", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
    { id: "code", label: t("blocks.code"), glyph: "<>", hint: "```", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
    // Escrever "@" no lugar abre a lista de tickets pelo mesmo caminho de quem digita.
    { id: "mention", label: t("blocks.mention"), glyph: "@", hint: "@", run: (editor, range) => void editor.chain().focus().deleteRange(range).insertContent("@").run() },
  ];
  const needle = fold(query).trim();
  return needle === "" ? all : all.filter((item) => fold(item.label).includes(needle));
}

/** A lista do "@": tickets do mesmo projeto, sem o aberto, pela busca da barra. Sem texto, os primeiros do projeto. */
export function mentionItems(query: string, context: MentionContext): MenuItem[] {
  const pool = context.tickets.filter((ticket) => ticket.projectId === context.projectId && ticket.id !== context.ownId);
  const found = query.trim() === "" ? pool.slice(0, MAX_RESULTS) : searchTickets(query, { [context.projectId]: pool });
  return found.map((ticket) => ({
    id: ticket.id,
    label: `${ticket.key} ${ticket.title}`,
    ticket,
    // A chave entra como texto, com um espaço depois para continuar a frase.
    run: (editor, range) => void editor.chain().focus().insertContentAt(range, { type: "text", text: `${ticket.key} ` }).run(),
  }));
}

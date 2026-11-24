import type { Editor, Range } from "@tiptap/core";
import type { TFunction } from "i18next";
import type { Person } from "../../api/client.js";
import { fold, MAX_RESULTS, searchTickets } from "../../command/search.js";
import type { MentionContext } from "./decorations.js";
import type { MenuItem } from "./suggestions.js";

/** Os blocos do menu "/" (ADR 0036), com o atalho de markdown que faz o mesmo. */
export function blockItems(t: TFunction<"ticket">, query: string, askAssistant?: (editor: Editor, range: Range) => void): MenuItem[] {
  const all: MenuItem[] = [
    { id: "text", label: t("blocks.text"), glyph: "T", hint: "", run: (editor, range) => void editor.chain().focus().deleteRange(range).setParagraph().run() },
    { id: "heading", label: t("blocks.heading"), glyph: "H", hint: "#", run: (editor, range) => void editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run() },
    { id: "bulletList", label: t("blocks.bulletList"), glyph: "•", hint: "-", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleBulletList().run() },
    { id: "taskList", label: t("blocks.taskList"), glyph: "✓", hint: "[]", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleTaskList().run() },
    { id: "quote", label: t("blocks.quote"), glyph: "”", hint: ">", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
    { id: "code", label: t("blocks.code"), glyph: "<>", hint: "```", run: (editor, range) => void editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
    // Escrever "#" no lugar abre a lista de tickets pelo mesmo caminho de quem digita.
    { id: "mention", label: t("blocks.mention"), glyph: "#", hint: "#", run: (editor, range) => void editor.chain().focus().deleteRange(range).insertContent("#").run() },
    // Só com o assistente ligado e a pessoa podendo editar: depois de uma linha separadora.
    ...(askAssistant
      ? [{ id: "assistant", label: t("blocks.assistant"), glyph: "✦", hint: "", separatorBefore: true, run: (editor: Editor, range: Range) => askAssistant(editor, range) }]
      : []),
  ];
  const needle = fold(query).trim();
  return needle === "" ? all : all.filter((item) => fold(item.label).includes(needle));
}

/** O trecho do gatilho (com o espaço que já vem depois dele, se houver) trocado pelo item e por um espaço para continuar a frase. */
export function insertMention(editor: Editor, range: Range, node: { type: string; attrs: Record<string, string> }): void {
  const size = editor.state.doc.content.size;
  // Escolher com o cursor no meio do trecho (`@bi|a`) troca o trecho inteiro: o que sobra da palavra depois do cursor sai junto.
  const rest = /^[\p{L}\p{N}_-]*/u.exec(editor.state.doc.textBetween(range.to, Math.min(range.to + 80, size), "\n", "\n"))?.[0] ?? "";
  const end = range.to + rest.length;
  const next = editor.state.doc.textBetween(end, Math.min(end + 1, size), "\n", "\n");
  const to = next === " " ? end + 1 : end;
  editor.chain().focus().insertContentAt({ from: range.from, to }, [node, { type: "text", text: " " }]).run();
}

/** A lista do "#": tickets do mesmo projeto, sem o aberto, pela busca da barra. Sem texto, os primeiros do projeto. */
export function ticketItems(query: string, context: MentionContext): MenuItem[] {
  const pool = context.tickets.filter((ticket) => ticket.projectId === context.projectId && ticket.id !== context.ownId);
  const found = query.trim() === "" ? pool.slice(0, MAX_RESULTS) : searchTickets(query, { [context.projectId]: pool });
  return found.map((ticket) => ({
    id: ticket.id,
    label: `${ticket.key} ${ticket.title}`,
    ticket,
    run: (editor, range) => insertMention(editor, range, { type: "ticketMention", attrs: { key: ticket.key } }),
  }));
}

/** A lista do "@": as pessoas que se pode marcar, pelo nome. */
export function personItems(query: string, options: readonly { person: Person; blocked: boolean }[]): MenuItem[] {
  const wanted = fold(query).trim();
  return options
    .filter(({ person }) => fold(person.displayName).includes(wanted))
    .map(({ person, blocked }) => ({
      id: person.id,
      label: person.displayName,
      person: { id: person.id, name: person.displayName, blocked, isTest: person.isTest === true },
      run: (editor, range) => insertMention(editor, range, { type: "personMention", attrs: { id: person.id, name: person.displayName } }),
    }));
}

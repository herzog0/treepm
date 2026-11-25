import { act, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { personIdsIn } from "@treepm/domain";
import { chatTextFromDoc } from "./chatText.js";

/**
 * O campo das conversas é um editor (ProseMirror), não mais um `textarea`: estes ajudantes o dirigem pelo caminho do próprio editor
 * (o evento de tecla passa pelas regras de tecla do produto: Enter envia, Enter com a lista aberta confirma, Backspace apaga o item;
 * o texto digitado passa por `handleTextInput`, como o navegador o entrega). O que o jsdom não faz sozinho (mover o cursor com as
 * setas, apagar um caractere comum) é feito aqui só quando o editor deixou a tecla passar, com a mesma regra do navegador.
 */
const FIELD_NAME = /^(Mensagem|Responder na thread)$/;

/** O campo (a caixa de combinação do editor) e o editor por trás dele. */
export async function composer(name: RegExp | string = FIELD_NAME): Promise<{ dom: HTMLElement; editor: Editor }> {
  const dom = await screen.findByRole("combobox", { name });
  return { dom, ...editorOf(dom) };
}

export function composerNow(name: RegExp | string = FIELD_NAME): { dom: HTMLElement; editor: Editor } {
  const dom = screen.getByRole("combobox", { name });
  return { dom, ...editorOf(dom) };
}

function editorOf(dom: HTMLElement): { editor: Editor } {
  const editor = (dom as HTMLElement & { editor?: Editor }).editor;
  if (!editor) throw new Error("o campo não é um editor");
  return { editor };
}

/** Põe o cursor no fim do texto, como o clique no fim do campo (só se o cursor ainda não estiver dentro dele). */
function focusEnd(editor: Editor) {
  if (!editor.isFocused) act(() => void editor.commands.focus("end"));
}

type Field = { dom: HTMLElement; editor: Editor };
const KEYS = new Set(["Enter", "Backspace", "Delete", "Escape", "Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function typeChar(char: string, field: Field) {
  const { editor } = field;
  if (!editor.isEditable) return;
  act(() => {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  });
}

/**
 * Digita como o navegador entrega: um caractere por vez, no cursor, passando por `handleTextInput` (é por onde o `#` e o `@` abrem a
 * lista). Teclas entre chaves, como no `user-event`: `{Enter}`, `{Backspace}`, `{Escape}`, `{Tab}`, `{ArrowDown}`; `{Shift>}{Enter}{/Shift}`
 * é Shift+Enter e `\n` também quebra a linha.
 */
export function typeInComposer(text: string, field: Field = composerNow()) {
  focusEnd(field.editor);
  const parts = text.split(/(\{[^}]+\})/).filter((part) => part !== "");
  let shift = false;
  for (const part of parts) {
    const token = /^\{([^}]+)\}$/.exec(part)?.[1];
    if (token === undefined) {
      for (const char of part) {
        if (char === "\n") pressInComposer("Shift+Enter", field);
        else typeChar(char, field);
      }
    } else if (token === "Shift>") shift = true;
    else if (token === "/Shift") shift = false;
    else if (KEYS.has(token)) pressInComposer((shift ? `Shift+${token}` : token) as KeySpec, field);
    else throw new Error(`tecla desconhecida: {${token}}`);
  }
}

/** Troca o texto do campo de uma vez só (uma transação), como o IME ou um colar entregariam: para textos compridos, que digitar letra por letra tornaria lento. */
export function fillComposer(text: string, field: Field = composerNow()) {
  const { editor } = field;
  act(() => {
    editor.commands.focus();
    editor.view.dispatch(editor.state.tr.replaceWith(1, editor.state.doc.content.size - 1, text === "" ? [] : editor.state.schema.text(text)));
  });
}

/** Seleciona o trecho `from`–`to` (posições do documento), como o arrastar do mouse. */
export function selectInComposer(from: number, to: number, field: Field = composerNow()) {
  act(() => void field.editor.chain().focus().setTextSelection({ from, to }).run());
}

/** Põe o cursor em `at` (posição do documento) ou no fim; para "digitar no começo" e "no meio". */
export function placeCursor(at: number | "start" | "end", field: Field = composerNow()) {
  const { editor } = field;
  act(() => void editor.commands.focus(at === "start" ? "start" : at === "end" ? "end" : at));
}

type KeySpec = "Enter" | "Shift+Enter" | "Backspace" | "Delete" | "Escape" | "Tab" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Shift+Tab";

/** Aperta uma tecla: devolve se o editor ou a lista a tratou (como `preventDefault` no navegador). */
export function pressInComposer(spec: KeySpec, field: Field = composerNow()): boolean {
  const { dom, editor } = field;
  focusEnd(editor);
  const shift = spec.startsWith("Shift+");
  const key = shift ? spec.slice(6) : spec;
  const event = new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true });
  act(() => void dom.dispatchEvent(event));
  if (event.defaultPrevented) return true;
  // O navegador faria o resto (o cursor anda, o caractere some): sem layout, o jsdom não.
  act(() => {
    const { state, view } = editor;
    const { from, empty } = state.selection;
    if (!editor.isEditable) return;
    // Um item de menção ao lado do cursor é do produto (regra de tecla de `MentionKeys`): se ela não tratou a tecla, o teste não pode fingir
    // que o navegador apagaria o item (o nó mede 1 e a posição sumiria igual). Quem testa o comportamento real é a suíte de navegador.
    const beside = key === "Backspace" ? state.selection.$from.nodeBefore : key === "Delete" ? state.selection.$from.nodeAfter : null;
    if (empty && beside && /Mention$/.test(beside.type.name)) throw new Error(`${key} ao lado de um item de menção não foi tratado pelo editor`);
    if (key === "Backspace" && empty && from > 1) view.dispatch(state.tr.delete(from - 1, from));
    else if (key === "Delete" && empty && from < state.doc.content.size - 1) view.dispatch(state.tr.delete(from, from + 1));
    else if (key === "ArrowLeft") editor.commands.setTextSelection(Math.max(1, from - 1));
    else if (key === "ArrowRight") editor.commands.setTextSelection(Math.min(state.doc.content.size - 1, from + 1));
  });
  return false;
}

/** Cola texto puro, como o evento de colar do navegador. */
export function pasteInComposer(text: string, field: Field = composerNow(), html = "") {
  const { dom, editor } = field;
  focusEnd(editor);
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  event.clipboardData = { getData: (type: string) => (type === "text/plain" ? text : type === "text/html" ? html : "") };
  act(() => void dom.dispatchEvent(event));
}

/** Escolhe a pessoa na lista aberta, clicando na opção (o cursor continua no campo). */
export async function pickPerson(name: string) {
  const list = await screen.findByRole("listbox", { name: "Pessoas" });
  await act(async () => void within(list).getByRole("option", { name: new RegExp(name) }).click());
}

/** Escolhe o ticket na lista aberta, pela chave. */
export async function pickTicket(key: string) {
  const list = await screen.findByRole("listbox", { name: "Tickets" });
  const option = await within(list).findByRole("option", { name: new RegExp(`\\b${key}\\b`) });
  await act(async () => void option.click());
}

/** O que a pessoa vê no campo (`@Nome` e `#CHAVE` no lugar dos itens, quebras como `\n`): o que o `toHaveValue` do campo antigo dizia. */
export function composerShown(field: Field = composerNow()): string {
  return field.editor.getText({ blockSeparator: "\n" });
}

/** O texto que será enviado (com os elos `#CHAVE` e `[@Nome](person:id)`), lido do documento do editor. */
export function composerText(field: Field = composerNow()): string {
  return chatTextFromDoc((field).editor.getJSON());
}

/** Os ids das pessoas marcadas no texto, na ordem em que aparecem. */
export function composerMentions(field: Field = composerNow()): string[] {
  return personIdsIn(composerText(field));
}

/** O cabeçalho "Nova thread · com …" do campo (ADR 0059); `null` quando a mensagem não vai abrir thread. */
export const newThreadHead = (): HTMLElement | null => document.querySelector<HTMLElement>(".chat-newthread-head");

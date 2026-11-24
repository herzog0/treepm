import { Extension, Node } from "@tiptap/core";
import type { Editor, JSONContent, MarkdownToken } from "@tiptap/core";
import { personLink } from "@treepm/domain";

/** Chave de ticket logo depois do `#` (a mesma regra de `scanTicketKeys`, com fronteira no fim). */
const TICKET_AT_START = /^#([A-Z][A-Z0-9]*-\d+)(?![\p{L}\p{N}_-])/u;
/** O que não pode vir antes do `#` para a chave valer como menção (mesma regra de `scanTicketRefs`). */
const GLUED = /[\p{L}\p{N}_#/&=?-]/u;
const PERSON_AT_START = /^\[@((?:[^[\]\\\n]|\\.)*)\]\(person:([A-Za-z0-9_-]+)\)/;

export interface TicketMentionOptions {
  /** Diz se a chave é de um ticket que existe onde o texto vale (no projeto, ou em qualquer um). Chave que não existe fica como texto. */
  exists: (key: string) => boolean;
}

/** O ticket mencionado no meio do texto (ADR 0058): um item indivisível, guardado como `#CHAVE`. O desenho (situação e título) vem das decorações. */
export const TicketMention = Node.create<TicketMentionOptions>({
  name: "ticketMention",
  group: "inline",
  inline: true,
  atom: true,
  // Sem seleção de nó: a seta passa por ele como por um caractere, e o clique põe o cursor ao lado.
  selectable: false,
  addOptions() {
    return { exists: () => true };
  },
  addAttributes() {
    return { key: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-ticket-key]", getAttrs: (element) => ({ key: (element as HTMLElement).getAttribute("data-ticket-key") ?? "" }) }];
  },
  renderHTML({ node }) {
    return ["span", { class: "description-mention", "data-ticket-key": node.attrs["key"] as string }, node.attrs["key"] as string];
  },
  renderText({ node }) {
    return `#${node.attrs["key"] as string}`;
  },
  markdownTokenName: "ticketMention",
  markdownTokenizer: {
    name: "ticketMention",
    level: "inline",
    start: (src: string) => src.indexOf("#"),
    tokenize(src: string, tokens: MarkdownToken[]) {
      const match = TICKET_AT_START.exec(src);
      if (match === null) return undefined;
      const before = tokens.length === 0 ? "" : ((tokens[tokens.length - 1] as { raw?: string }).raw ?? "").slice(-1);
      if (before !== "" && GLUED.test(before)) return undefined;
      return { type: "ticketMention", raw: match[0], key: match[1] } as MarkdownToken;
    },
  },
  parseMarkdown(token): JSONContent {
    const key = (token as unknown as { key: string }).key;
    return this.options.exists(key) ? { type: "ticketMention", attrs: { key } } : { type: "text", text: `#${key}` };
  },
  renderMarkdown(node) {
    return `#${(node.attrs as { key: string }).key}`;
  },
});

/** A pessoa mencionada no meio do texto (ADR 0058): um item indivisível, guardado como `[@Nome](person:id)`. */
export const PersonMention = Node.create({
  name: "personMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { id: { default: "" }, name: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-person-id]",
        getAttrs: (element) => ({ id: (element as HTMLElement).getAttribute("data-person-id") ?? "", name: (element as HTMLElement).getAttribute("data-person-name") ?? "" }),
      },
    ];
  },
  renderHTML({ node }) {
    const { id, name } = node.attrs as { id: string; name: string };
    return ["span", { class: "mention-person", "data-person-id": id, "data-person-name": name }, `@${name}`];
  },
  renderText({ node }) {
    return `@${(node.attrs as { name: string }).name}`;
  },
  // O item mostra o nome atual da pessoa (decoração `data-person-current`, posta por quem conhece a organização), nunca o guardado no texto:
  // `[@Administrador](person:<id de outra pessoa>)` escrito à mão não faz uma pessoa passar por outra. O texto guardado continua o do nó.
  addNodeView() {
    return ({ node, decorations }) => {
      const dom = document.createElement("span");
      dom.className = "mention-person";
      const paint = (current: typeof node, decorations: readonly { type: { attrs?: Record<string, unknown> } }[]) => {
        const { id, name } = current.attrs as { id: string; name: string };
        const now = decorations.map((decoration) => decoration.type.attrs?.["data-person-current"]).find((value) => typeof value === "string");
        dom.setAttribute("data-person-id", id);
        dom.setAttribute("data-person-name", name);
        dom.textContent = `@${typeof now === "string" ? now : name}`;
      };
      paint(node, decorations as never);
      return {
        dom,
        update: (updated, decorations) => {
          if (updated.type !== node.type) return false;
          paint(updated, decorations as never);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
  markdownTokenName: "personMention",
  markdownTokenizer: {
    name: "personMention",
    level: "inline",
    start: (src: string) => src.indexOf("[@"),
    tokenize(src: string) {
      const match = PERSON_AT_START.exec(src);
      if (match === null) return undefined;
      return { type: "personMention", raw: match[0], id: match[2], name: (match[1] as string).replace(/\\(.)/g, "$1") } as MarkdownToken;
    },
  },
  parseMarkdown(token): JSONContent {
    const { id, name } = token as unknown as { id: string; name: string };
    return { type: "personMention", attrs: { id, name } };
  },
  renderMarkdown(node) {
    const { id, name } = node.attrs as { id: string; name: string };
    return personLink(id, name);
  },
});

const MENTION_NODES = new Set(["ticketMention", "personMention"]);

/** Apaga o item inteiro quando a tecla pega colada a ele (Backspace depois, Delete antes), em qualquer um dos três lugares. */
function removeBeside(editor: Editor, direction: -1 | 1): boolean {
  const { selection } = editor.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  const node = direction < 0 ? $from.nodeBefore : $from.nodeAfter;
  if (node === null || !MENTION_NODES.has(node.type.name)) return false;
  const from = direction < 0 ? $from.pos - node.nodeSize : $from.pos;
  editor.view.dispatch(editor.state.tr.delete(from, from + node.nodeSize).scrollIntoView());
  return true;
}

export const MentionKeys = Extension.create({
  name: "mentionKeys",
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => removeBeside(editor, -1),
      Delete: ({ editor }) => removeBeside(editor, 1),
    };
  },
});

/** Os tipos de item e as teclas deles. `people: false` (a descrição, que não leva pessoa): sem o item de pessoa, o que vier dele é texto `@Nome`. */
export const mentionExtensions = (options: TicketMentionOptions, people = true) => [TicketMention.configure(options), ...(people ? [PersonMention] : []), MentionKeys];

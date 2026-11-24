import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Tokenizer } from "marked";
import { hashTicketKeys, withoutPersonLinksDeep } from "@treepm/domain";
import { mentionExtensions } from "../../mentions/nodes.js";

/**
 * O que a `marked` não interpreta (ADR 0036): HTML, tabela, riscado e URL solta ficam como texto; imagem também (vira o próprio
 * texto `![…](…)`). Assim o texto lido é o texto gravado, e HTML escrito na descrição nunca vira elemento.
 */
class PlainTextTokenizer extends Tokenizer {
  override html() {
    return undefined as never;
  }
  override tag() {
    return undefined as never;
  }
  override table() {
    return undefined as never;
  }
  override del() {
    return undefined as never;
  }
  override url() {
    return undefined as never;
  }
  override link(src: string) {
    const token = super.link(src);
    return token && token.type === "image" ? ({ type: "text", raw: token.raw, text: token.raw } as never) : token;
  }
}

/**
 * O serializador do Tiptap escapa o texto (`x_y` → `x\_y`, `&` → `&amp;`, `<` → `&lt;`), o que reescreveria URLs e
 * chaves. Aqui o texto vai como está; o código em bloco e em linha já era literal.
 */
const MarkdownAsWritten = Markdown.extend({
  onBeforeCreate() {
    (this.parent as (() => void) | undefined)?.();
    (this.editor as unknown as { markdown: { encodeTextForMarkdown: (text: string) => string } }).markdown.encodeTextForMarkdown = (text) => text;
  },
});

export interface DescriptionExtensionOptions {
  /** Diz se, com o texto só para leitura, a pessoa pode marcar e desmarcar tarefas (quem escreve no documento é o componente). */
  canToggleTasks?: () => boolean;
  /** Nome acessível da caixa de uma tarefa, no idioma ativo (o padrão do Tiptap é em inglês). */
  taskLabel?: (text: string) => string;
  /** Diz se uma chave é de um ticket que existe onde o texto vale (ADR 0058): só essas viram menção. Sem isso, nenhuma vale. */
  ticketExists?: (key: string) => boolean;
  /** O editor leva item de pessoa (comentários). Sem isso (a descrição), pessoa é só o texto `@Nome`. */
  people?: boolean;
}

/** As extensões do editor da descrição: o subconjunto da ADR 0036 e nada além dele. */
export function descriptionExtensions({ canToggleTasks, taskLabel, ticketExists, people }: DescriptionExtensionOptions = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2] },
      underline: false,
      strike: false,
      horizontalRule: false,
      trailingNode: false,
      link: { autolink: false, linkOnPaste: false, openOnClick: false, HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" } },
    }),
    TaskList,
    TaskItem.configure({
      nested: false,
      ...(canToggleTasks ? { onReadOnlyChecked: () => canToggleTasks() } : {}),
      ...(taskLabel ? { a11y: { checkboxLabel: (node: { textContent: string }) => taskLabel(node.textContent) } } : {}),
    }),
    ...mentionExtensions({ exists: ticketExists ?? (() => false) }, people === true),
    MarkdownAsWritten.configure({ markedOptions: { breaks: false, gfm: true, tokenizer: new PlainTextTokenizer() } }),
  ];
}

/**
 * O texto como o editor o lê (ADR 0058): a chave solta de um ticket que existe, dos textos antigos, ganha o `#` e vira menção; ao
 * salvar depois de uma edição ela sai com `#`. Sem edição, a leitura não regrava nada.
 */
export function prepareDescription(text: string, ticketExists?: (key: string) => boolean, people = false): string {
  // Sem item de pessoa no editor (a descrição), um elo `[@Nome](person:id)` que sobrou aparece como o `@Nome` simples.
  const plain = people ? text : withoutPersonLinksDeep(text);
  return ticketExists ? hashTicketKeys(plain, ticketExists) : plain;
}

/** Serializa o documento para o texto guardado: sem as quebras de linha que o serializador deixa no fim. */
export const readMarkdown = (editor: Editor): string => editor.getMarkdown().replace(/\n+$/, "");

/** O texto como o editor o escreveria de volta sem edição: a base para saber se a pessoa mudou algo. */
export function normalizeDescription(text: string, ticketExists?: (key: string) => boolean, people = false): string {
  const editor = new Editor({ extensions: descriptionExtensions({ ...(ticketExists ? { ticketExists } : {}), people }), content: prepareDescription(text, ticketExists, people), contentType: "markdown" });
  try {
    return readMarkdown(editor);
  } finally {
    editor.destroy();
  }
}

/**
 * O texto a guardar depois de a pessoa mexer no editor. Igual à base: ela não editou (ou desfez), então vale o texto guardado,
 * tal como está — a leitura nunca regrava a descrição. Diferente: vale o que o editor escreveu.
 */
export const valueAfterEdit = (serialized: string, baseline: string, original: string): string => (serialized === baseline ? original : serialized);

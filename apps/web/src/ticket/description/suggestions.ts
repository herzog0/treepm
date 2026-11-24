import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import Suggestion, { exitSuggestion } from "@tiptap/suggestion";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { TicketSummary } from "../../api/client.js";

/** `/` abre os blocos, `#` os tickets e `@` as pessoas (ADR 0058). */
export type MenuKind = "blocks" | "ticket" | "person";

export interface MenuItem {
  id: string;
  label: string;
  /** Bloco: o glifo e o atalho de markdown mostrados na linha. */
  glyph?: string;
  hint?: string;
  /** Uma linha separadora antes deste item (o do assistente). */
  separatorBefore?: boolean;
  /** Menção de ticket. */
  ticket?: TicketSummary;
  /** Menção de pessoa; `blocked`: não enxerga o projeto e aparece apagada, com o motivo. */
  person?: { id: string; name: string; blocked: boolean; isTest?: boolean };
  run: (editor: Editor, range: Range) => void;
}

export interface SuggestionHost {
  show: (kind: MenuKind, props: SuggestionProps<MenuItem, MenuItem>) => void;
  key: (kind: MenuKind, event: KeyboardEvent) => boolean;
  hide: (kind: MenuKind) => void;
}

/** Uma chave por lista (e não uma nova a cada editor): quem fecha a lista de fora (`closeSuggestion`) precisa achá-la. */
const SUGGESTION_KEYS = { blocks: new PluginKey("blocksSuggestion"), ticket: new PluginKey("ticketSuggestion"), person: new PluginKey("personSuggestion") } as const;

/** Fecha a lista aberta (a de `kind`) sem mexer no texto: o mesmo que Esc faz. */
export function closeSuggestion(view: EditorView, kind: MenuKind) {
  exitSuggestion(view, SUGGESTION_KEYS[kind]);
}

const CHAR = { blocks: "/", ticket: "#", person: "@" } as const;

/**
 * O gatilho de cada lista. O menu é nosso: o `@tiptap/suggestion` só dá o gatilho, a posição e o ciclo de vida. Só um caractere digitado
 * abre a lista (colar ou mover o cursor para dentro de um `#abc` já escrito não abre); aberta, ela acompanha o cursor.
 */
export function suggestionExtension(kind: MenuKind, host: SuggestionHost, items: (query: string) => MenuItem[], enabled: () => boolean = () => true) {
  return Extension.create({
    name: `${kind}Suggestion`,
    addProseMirrorPlugins() {
      let active = false;
      return [
        Suggestion<MenuItem, MenuItem>({
          editor: this.editor,
          char: CHAR[kind],
          pluginKey: SUGGESTION_KEYS[kind],
          items: ({ query }) => items(query),
          allow: () => enabled(),
          shouldShow: ({ transaction }) => active || (transaction.docChanged && transaction.getMeta("uiEvent") === undefined && !transaction.getMeta("paste")),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => ({
            onStart: (props: SuggestionProps<MenuItem, MenuItem>) => {
              active = true;
              host.show(kind, props);
            },
            onUpdate: (props: SuggestionProps<MenuItem, MenuItem>) => host.show(kind, props),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => host.key(kind, event),
            onExit: () => {
              active = false;
              host.hide(kind);
            },
          }),
        }),
      ];
    },
  });
}

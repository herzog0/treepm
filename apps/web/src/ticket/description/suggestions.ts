import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import type { TicketSummary } from "../../api/client.js";

export type MenuKind = "blocks" | "mention";

export interface MenuItem {
  id: string;
  label: string;
  /** Bloco: o glifo e o atalho de markdown mostrados na linha. */
  glyph?: string;
  hint?: string;
  /** Menção: o ticket. */
  ticket?: TicketSummary;
  run: (editor: Editor, range: Range) => void;
}

export interface SuggestionHost {
  show: (kind: MenuKind, props: SuggestionProps<MenuItem, MenuItem>) => void;
  key: (kind: MenuKind, event: KeyboardEvent) => boolean;
  hide: (kind: MenuKind) => void;
}

/** "/" abre os blocos; "@" abre os tickets do projeto. O menu é nosso: o `@tiptap/suggestion` só dá o gatilho, a posição e o ciclo de vida. */
export function suggestionExtension(kind: MenuKind, host: SuggestionHost, items: (query: string) => MenuItem[]) {
  const char = kind === "blocks" ? "/" : "@";
  return Extension.create({
    name: `${kind}Suggestion`,
    addProseMirrorPlugins() {
      return [
        Suggestion<MenuItem, MenuItem>({
          editor: this.editor,
          char,
          pluginKey: new PluginKey(`${kind}Suggestion`),
          items: ({ query }) => items(query),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => ({
            onStart: (props: SuggestionProps<MenuItem, MenuItem>) => host.show(kind, props),
            onUpdate: (props: SuggestionProps<MenuItem, MenuItem>) => host.show(kind, props),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => host.key(kind, event),
            onExit: () => host.hide(kind),
          }),
        }),
      ];
    },
  });
}

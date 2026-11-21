import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { TicketStatus, TicketSummary } from "../../api/client.js";
import { FILL } from "../../map/StatusMark.js";
import { findMentions } from "./mentions.js";

export interface MentionContext {
  projectId: string;
  /** Tickets do projeto, com situação e título atuais. */
  tickets: readonly TicketSummary[];
  /** O ticket aberto: fica fora da lista do "@", mas a chave dele no texto também é menção. */
  ownId?: string;
  /** Abre o ticket da menção. Sem ela, a menção aparece mas não leva a lugar nenhum. */
  onOpen?: (ticketId: string) => void;
}

export interface DecorationSource {
  context: MentionContext | null;
  placeholder: string;
  /** Texto de cada situação, no idioma ativo, para o nome acessível da menção. */
  statusText: (status: TicketStatus) => string;
}

/** Quem pede para refazer as decorações (contexto, situação ou título mudaram; a edição abriu ou fechou). */
export const decorationsKey = new PluginKey("descriptionDecorations");

const TITLE_MAX = 36;
/** O título que a etiqueta mostra: cortado por caracteres, para a etiqueta nunca passar da largura de uma linha. */
const shortTitle = (title: string) => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title);

/**
 * Decorações da descrição (ADR 0036): toda chave de ticket do mesmo projeto vira menção, com marcador de situação, chave e
 * título atuais; o texto continua sendo só a chave. Código não vira menção. E o convite quando o texto está vazio.
 */
export function descriptionDecorations(source: () => DecorationSource) {
  return Extension.create({
    name: "descriptionDecorations",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const build = (doc: ProseNode): DecorationSet => {
        const { context, placeholder, statusText } = source();
        const decorations: Decoration[] = [];
        const first = doc.firstChild;
        if (doc.childCount === 1 && first && first.isTextblock && first.content.size === 0 && placeholder !== "") {
          decorations.push(Decoration.node(0, first.nodeSize, { class: "is-empty", "data-placeholder": placeholder }));
        }
        if (context) {
          const interactive = context.onOpen !== undefined;
          doc.descendants((node, pos) => {
            if (node.type.name === "codeBlock") return false;
            if (!node.isText || node.marks.some((mark) => mark.type.name === "code")) return true;
            for (const match of findMentions(node.text ?? "", context.tickets, context.projectId)) {
              const { ticket } = match;
              const from = pos + match.start;
              const to = pos + match.end;
              // Uma etiqueta só: o marcador e o título são desenhados pelo CSS em volta da chave, que continua sendo o texto.
              decorations.push(
                Decoration.inline(from, to, {
                  nodeName: "span",
                  class: "description-mention",
                  "data-ticket-id": ticket.id,
                  "data-state": ticket.status,
                  "data-fill": String(FILL[ticket.status]),
                  style: `--fill: ${FILL[ticket.status]}`,
                  "data-title": shortTitle(ticket.title),
                  "aria-label": `${ticket.key} ${ticket.title}, ${statusText(ticket.status)}`,
                  title: ticket.title,
                  ...(interactive && !editor.isEditable ? { role: "link", tabindex: "0" } : {}),
                }),
              );
            }
            return true;
          });
        }
        return DecorationSet.create(doc, decorations);
      };
      return [
        new Plugin({
          key: decorationsKey,
          state: {
            init: (_config, state) => build(state.doc),
            apply: (transaction, previous) => (transaction.docChanged || transaction.getMeta(decorationsKey) ? build(transaction.doc) : previous),
          },
          props: { decorations: (state) => decorationsKey.getState(state) as DecorationSet },
        }),
      ];
    },
  });
}

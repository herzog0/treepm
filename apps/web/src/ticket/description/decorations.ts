import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Person, TicketStatus, TicketSummary } from "../../api/client.js";
import { FILL } from "../../map/StatusMark.js";

/** Quem se pode marcar com `@` e como cada pessoa se chama hoje (comentários e conversas; a descrição não leva pessoa, ADR 0058). */
export interface PeopleContext {
  options: readonly { person: Person; blocked: boolean }[];
  /** Nome atual de cada pessoa da organização: o item mostra esse nome; quem não está aqui deixou a organização. */
  names: ReadonlyMap<string, string>;
}

export interface MentionContext {
  projectId: string;
  /** Tickets do projeto, com situação e título atuais. */
  tickets: readonly TicketSummary[];
  /** As chaves de qualquer projeto valem (a conversa do chat cita tickets de vários); `projectId` não filtra. */
  anyProject?: boolean;
  /** O ticket aberto: fica fora da lista do "#", mas a chave dele no texto também é menção. */
  ownId?: string;
  /** Abre o ticket da menção. Sem ela, a menção aparece mas não leva a lugar nenhum. */
  onOpen?: (ticketId: string) => void;
}

/** As chaves que valem como menção neste contexto: os tickets do projeto (ou de qualquer projeto). */
export function keysInScope(context: MentionContext | undefined): ReadonlySet<string> {
  if (context === undefined) return new Set();
  return new Set(context.tickets.filter((ticket) => context.anyProject || ticket.projectId === context.projectId).map((ticket) => ticket.key));
}

export interface DecorationSource {
  context: MentionContext | null;
  people: PeopleContext | null;
  placeholder: string;
  /** Texto de cada situação, no idioma ativo, para o nome acessível da menção. */
  statusText: (status: TicketStatus) => string;
}

/** Quem pede para refazer as decorações (contexto, situação ou título mudaram; a edição abriu ou fechou). */
export const decorationsKey = new PluginKey("descriptionDecorations");

const TITLE_MAX = 36;
/** O título que a etiqueta mostra: cortado por caracteres, para a etiqueta nunca passar da largura de uma linha. */
const shortTitle = (title: string) => (title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title);

/** Os atributos do desenho de uma menção de ticket: o mesmo na descrição, nos comentários e nas mensagens das conversas. */
export function ticketMentionAttrs(ticket: TicketSummary, statusText: (status: TicketStatus) => string): Record<string, string> {
  return {
    "data-ticket-id": ticket.id,
    "data-state": ticket.status,
    "data-fill": String(FILL[ticket.status]),
    style: `--fill: ${FILL[ticket.status]}`,
    "data-title": shortTitle(ticket.title),
    "aria-label": `${ticket.key} ${ticket.title}, ${statusText(ticket.status)}`,
    title: ticket.title,
  };
}

/**
 * Decorações do editor (ADR 0036 e 0058): cada item de ticket ganha o marcador de situação, a chave e o título atuais (o item guarda só a
 * chave); o item de pessoa que saiu da organização perde o destaque. E o convite quando o texto está vazio.
 */
export function descriptionDecorations(source: () => DecorationSource) {
  return Extension.create({
    name: "descriptionDecorations",
    addProseMirrorPlugins() {
      const editor = this.editor;
      const build = (doc: ProseNode): DecorationSet => {
        const { context, people, placeholder, statusText } = source();
        const decorations: Decoration[] = [];
        const first = doc.firstChild;
        if (doc.childCount === 1 && first && first.isTextblock && first.content.size === 0 && placeholder !== "") {
          decorations.push(Decoration.node(0, first.nodeSize, { class: "is-empty", "data-placeholder": placeholder }));
        }
        const byKey = new Map<string, TicketSummary>();
        if (context) for (const ticket of context.tickets) if (context.anyProject || ticket.projectId === context.projectId) byKey.set(ticket.key, ticket);
        const interactive = context?.onOpen !== undefined && !editor.isEditable;
        doc.descendants((node, pos) => {
          if (node.type.name === "ticketMention") {
            const ticket = byKey.get(node.attrs["key"] as string);
            decorations.push(
              Decoration.node(
                pos,
                pos + node.nodeSize,
                ticket ? { ...ticketMentionAttrs(ticket, statusText), ...(interactive ? { role: "link", tabindex: "0" } : {}) } : { class: "is-unresolved" },
              ),
            );
          } else if (node.type.name === "personMention" && people) {
            // Pessoa da organização: o nome atual dela. Id inexistente ou de outra organização: o nome guardado, sem destaque.
            const current = people.names.get(node.attrs["id"] as string);
            decorations.push(Decoration.node(pos, pos + node.nodeSize, current === undefined ? { class: "is-gone" } : { "data-person-current": current }));
          }
          return true;
        });
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

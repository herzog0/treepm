import type { JSONContent } from "@tiptap/core";
import { personLink, scanPersonLinks, withoutPersonLinksDeep } from "@treepm/domain";
import type { TicketSummary } from "../api/client.js";
import { ticketKeyRefs } from "./mentions.js";

/**
 * O campo de escrever das conversas é o editor em configuração mínima (ADR 0058): um parágrafo com quebras de linha e os itens de menção.
 * O texto da mensagem continua sendo texto: `#CHAVE` para ticket e `[@Nome](person:id)` para pessoa. Estas funções vão e voltam entre os dois.
 */

type Piece = { start: number; end: number; node: JSONContent };

/** O texto guardado como documento do editor: as quebras viram `hardBreak`, os elos de pessoa e o `#CHAVE` de ticket visível viram itens. */
export function chatDocFromText(text: string, byKey: ReadonlyMap<string, TicketSummary>): JSONContent {
  const pieces: Piece[] = scanPersonLinks(text).map((link) => ({ start: link.start, end: link.end, node: { type: "personMention", attrs: { id: link.id, name: link.name } } }));
  for (const { key, start, end, hashed } of ticketKeyRefs(text)) {
    if (hashed && byKey.has(key)) pieces.push({ start: start - 1, end, node: { type: "ticketMention", attrs: { key } } });
  }
  pieces.sort((a, b) => a.start - b.start);
  const content: JSONContent[] = [];
  const plain = (chunk: string) => {
    chunk.split("\n").forEach((line, index) => {
      if (index > 0) content.push({ type: "hardBreak" });
      if (line !== "") content.push({ type: "text", text: line });
    });
  };
  let at = 0;
  for (const piece of pieces) {
    if (piece.start < at) continue;
    plain(text.slice(at, piece.start));
    content.push(piece.node);
    at = piece.end;
  }
  plain(text.slice(at));
  return { type: "doc", content: [{ type: "paragraph", ...(content.length > 0 ? { content } : {}) }] };
}

/** O documento do editor como o texto que será enviado (e contado para o limite). */
export function chatTextFromDoc(doc: JSONContent): string {
  const inline = (node: JSONContent): string => {
    switch (node.type) {
      case "text":
        return node.text ?? "";
      case "hardBreak":
        return "\n";
      case "ticketMention":
        return `#${(node.attrs as { key: string }).key}`;
      case "personMention": {
        const { id, name } = node.attrs as { id: string; name: string };
        return personLink(id, name);
      }
      default:
        return (node.content ?? []).map(inline).join("");
    }
  };
  return (doc.content ?? []).map(inline).join("\n");
}

/** O que se cola no campo entra como texto puro: um elo de pessoa colado vira o `@Nome` simples, nunca uma menção. */
export const neutralizePaste = (text: string): string => withoutPersonLinksDeep(text);

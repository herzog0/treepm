import type { ExplodedNode } from "@treepm/domain";
import { CARD_HEIGHT, CARD_WIDTH, COLUMN_WIDTH, ROW_HEIGHT } from "./geometry.js";
import type { Size } from "./geometry.js";

const CODE = /^\[([^\]]+)\]\s*/;

/**
 * O texto do card da árvore: a linha 1 é o código que abre o título entre colchetes (`[ABC-01] …`, como nos projetos vindos do Linear),
 * ou a chave do ticket; a linha 2 é o resto do título.
 */
export function cardText(ticket: { key: string; title: string }): { code: string; title: string } {
  const match = CODE.exec(ticket.title);
  return match ? { code: match[1]!, title: ticket.title.slice(match[0].length) } : { code: ticket.key, title: ticket.title };
}

const byPosition = (a: ExplodedNode, b: ExplodedNode) => a.column - b.column || a.row - b.row;

/**
 * A manchete acima da árvore: "Pegue agora" são os nós livres sem impedimento (em andamento também: dá para seguir agora); "Abre em
 * seguida" são os próximos sem impedimento. Só os de dentro do foco, por coluna e linha, pelo mesmo código da linha 1 do card (a chave,
 * ou o `[CÓDIGO]` do título): o que a manchete diz se acha na árvore.
 */
export function headline(nodes: readonly ExplodedNode[], tickets: ReadonlyMap<string, { key: string; title: string; blocked?: boolean }>): { now: string[]; next: string[] } {
  const keysOf = (place: "free" | "next") =>
    nodes
      .filter((node) => !node.outside && node.place === place && tickets.get(node.id)?.blocked !== true)
      .sort(byPosition)
      .flatMap((node) => {
        const ticket = tickets.get(node.id);
        return ticket === undefined ? [] : [cardText(ticket).code];
      });
  return { now: keysOf("free"), next: keysOf("next") };
}

/** Escala da primeira vista: o card de 132 px com o texto de 11 a 12 px, legível. */
export const READ_SCALE = 1;
const LEFT = 24;

/**
 * A primeira vista: numa escala de leitura, com o passo 0 na borda esquerda e, na altura do meio, o primeiro "pegue agora" (sem ele, a
 * primeira linha da coluna 0). Uma árvore que cabe inteira nessa escala abre inteira (`fitAll`).
 */
export function firstCamera(nodes: readonly ExplodedNode[], columns: number, rows: number, size: Size, nowIds: readonly string[]): { x: number; y: number; scale: number } | { fitAll: true } {
  const width = Math.max(0, columns - 1) * COLUMN_WIDTH + CARD_WIDTH;
  const height = Math.max(0, rows - 1) * ROW_HEIGHT + CARD_HEIGHT;
  if (width * READ_SCALE + 2 * LEFT <= size.width && height * READ_SCALE + 2 * LEFT <= size.height) return { fitAll: true };
  const now = new Set(nowIds);
  const target = nodes.filter((node) => now.has(node.id)).sort(byPosition)[0] ?? nodes.filter((node) => node.column === 0).sort(byPosition)[0];
  const row = target?.row ?? 0;
  return { x: LEFT, y: size.height / 2 - (row * ROW_HEIGHT + CARD_HEIGHT / 2) * READ_SCALE, scale: READ_SCALE };
}

import type { TicketStatus, TicketSummary } from "../api/client.js";

/**
 * Paleta de situações (ADR 0051), numa fonte só. As cópias hexadecimais valem para o mapa, que trabalha com cores
 * resolvidas e não com `var()`; `theme.test.ts` garante que `theme.css` (tokens `--tp-*`) continua igual a elas.
 */
export const ACCENT_COLOR = "#a99bff";
export const SITUATION_COLORS = {
  blocked: "#ff5a4a",
  in_progress: "#3b8eff",
  in_review: "#ffd000",
  todo: "#70778a",
  done: "#2ee6b6",
} as const;
/** Cópia hexadecimal de `--tp-idea` (ADR 0042, tom da ADR 0051): a cor de todo nó dentro de uma ideia. */
export const IDEA_COLOR = "#f472d0";
export const BACKGROUND_COLOR = "#08090d";

/** Mistura em sRGB, canal a canal, o mesmo cálculo do `color-mix(in srgb, …)` da folha de estilo. */
export function blendHex(from: string, into: string, share: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  const part = (at: number) => Math.round(channel(from, at) * share + channel(into, at) * (1 - share));
  return `#${[1, 3, 5].map((at) => part(at).toString(16).padStart(2, "0")).join("")}`;
}
/** Cancelado: o cinza de "a fazer" a 50% do fundo, como a ideia descartada. */
export const CANCELLED_COLOR = blendHex(SITUATION_COLORS.todo, BACKGROUND_COLOR, 0.5);
/** A mesma cor de ideia, 50% misturada com o fundo: a ideia descartada, a raiz e tudo dentro dela. */
export const IDEA_DISCARDED_COLOR = blendHex(IDEA_COLOR, BACKGROUND_COLOR, 0.5);

/** Cor de cada situação gravada; "bloqueado" não é situação gravada e vem de `effectiveSituation`. */
export const STATUS_COLORS: Record<TicketStatus, string> = {
  todo: SITUATION_COLORS.todo,
  in_progress: SITUATION_COLORS.in_progress,
  in_review: SITUATION_COLORS.in_review,
  done: SITUATION_COLORS.done,
  cancelled: CANCELLED_COLOR,
};

/** Da situação mais preocupante à menos (ADR 0051). Cancelado e ideia não entram: não sobem. */
export const PRECEDENCE = ["blocked", "in_progress", "in_review", "todo", "done"] as const;
export type Situation = (typeof PRECEDENCE)[number];

/**
 * A situação que pinta o ticket: bloqueado quando o resumo traz `blocked` e o ticket não está concluído nem cancelado
 * (ADR 0051); senão, a situação gravada.
 */
export function effectiveSituation(ticket: Pick<TicketSummary, "status" | "blocked">): Situation | "cancelled" {
  if (ticket.blocked === true && ticket.status !== "done" && ticket.status !== "cancelled") return "blocked";
  return ticket.status === "cancelled" ? "cancelled" : ticket.status;
}

/** Posição de cada cor na precedência; o que não é situação (lilás, ideia, cancelado) vem depois, nessa ordem. */
const RANK_OF_COLOR = new Map<string, number>([
  ...PRECEDENCE.map((situation, at) => [SITUATION_COLORS[situation], at] as const),
  [ACCENT_COLOR, PRECEDENCE.length],
  [IDEA_COLOR, PRECEDENCE.length + 1],
  [CANCELLED_COLOR, PRECEDENCE.length + 2],
  [IDEA_DISCARDED_COLOR, PRECEDENCE.length + 3],
]);
const UNKNOWN_RANK = PRECEDENCE.length + 4;
/** Posição na precedência de uma cor de situação, ou `null` para o que não sobe (lilás, ideia, cancelado). */
export const situationRank = (color: string): number | null => {
  const rank = RANK_OF_COLOR.get(color);
  return rank !== undefined && rank < PRECEDENCE.length ? rank : null;
};

/** A cor mais preocupante entre as recebidas; nunca uma média, sempre uma das entradas. */
export function mostWorryingColor(colors: readonly string[]): string {
  const [first, ...rest] = colors;
  if (first === undefined) throw new Error("At least one color is required");
  let best = first;
  let bestRank = RANK_OF_COLOR.get(first) ?? UNKNOWN_RANK;
  for (const color of rest) {
    const rank = RANK_OF_COLOR.get(color) ?? UNKNOWN_RANK;
    if (rank < bestRank) [best, bestRank] = [color, rank];
  }
  return best;
}

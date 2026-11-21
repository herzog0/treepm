import type { CSSProperties } from "react";
import type { TicketStatus } from "../api/client.js";

export interface Progress {
  readonly done: number;
  readonly total: number;
  readonly excluded: number;
}

/** Quanto o quadrado se enche, por situação (também usado fora do React, nas menções da descrição). */
export const FILL: Record<TicketStatus, number> = { todo: 0, in_progress: 0.5, in_review: 0.75, done: 1, cancelled: 0 };

/** Proporção de folhas concluídas sobre a base, entre 0 e 1. */
export function progressFraction({ done, total }: Progress): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

export type StatusMarkProps = { readonly status: TicketStatus } | { readonly progress: Progress };

/**
 * Quadrado com borda que se enche de baixo para cima (ADR 0025). Decorativo: o texto da situação
 * ou do progresso sempre o acompanha onde há espaço, e o nome acessível do nó o descreve.
 */
export function StatusMark(props: StatusMarkProps) {
  const [state, fill] = "status" in props ? [props.status, FILL[props.status]] : (["progress", progressFraction(props.progress)] as const);
  const style = { "--fill": String(fill) } as CSSProperties;
  return <span className="status-mark" aria-hidden="true" data-state={state} data-fill={String(fill)} style={style} />;
}

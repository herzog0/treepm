import type { CSSProperties } from "react";
import type { TicketStatus, TicketSummary } from "../api/client.js";

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

/** Marcador de ideia (ADR 0042): cheio, na cor de ideia; `discarded` usa a cor apagada. */
export interface IdeaMark {
  readonly discarded: boolean;
}

export type StatusMarkProps =
  | { readonly status: TicketStatus; readonly blocked?: boolean; /** Lugar na fila (ADR 0069): num "a fazer", dá a cor. */ readonly place?: TicketSummary["place"] }
  | { readonly progress: Progress; readonly blocked?: boolean }
  | { readonly idea: IdeaMark };

/**
 * Quadrado com borda que se enche de baixo para cima (ADR 0025). Decorativo: o texto da situação
 * ou do progresso sempre o acompanha onde há espaço, e o nome acessível do nó o descreve.
 */
export function StatusMark(props: StatusMarkProps) {
  const [state, fill] =
    "status" in props
      ? [props.status, FILL[props.status]]
      : "idea" in props
        ? ([props.idea.discarded ? "idea-discarded" : "idea", 1] as const)
        : (["progress", progressFraction(props.progress)] as const);
  const style = { "--fill": String(fill) } as CSSProperties;
  // Bloqueado (ADR 0051): o marcador fica vermelho e mantém o enchimento da situação gravada.
  const blocked = !("idea" in props) && props.blocked === true;
  const place = "status" in props && props.status === "todo" ? (props.place ?? null) : null;
  return (
    <span
      className="status-mark"
      aria-hidden="true"
      data-state={state}
      data-fill={String(fill)}
      {...(place !== null ? { "data-place": place } : {})}
      {...(blocked ? { "data-blocked": "true" } : {})}
      style={style}
    />
  );
}

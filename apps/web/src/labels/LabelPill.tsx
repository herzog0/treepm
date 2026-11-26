import type { ReactNode } from "react";
import type { Label } from "../api/client.js";
import "./labels.css";

/**
 * Pastilha de etiqueta (ADR 0065): ponto na cor, nome cortado com reticências (inteiro no `title`) e, opcional, o botão de tirar
 * (`remove`). Reusada pela página do ticket, pela linha do tempo e pelas configurações; o CSS vem junto (`labels.css`).
 */
export function LabelPill({ label, remove }: { label: Pick<Label, "name" | "color">; remove?: ReactNode }) {
  return (
    <span className="label-pill" data-color={label.color} title={label.name}>
      <LabelDot color={label.color} />
      <span className="label-pill-name">{label.name}</span>
      {remove}
    </span>
  );
}

/** Só o ponto de cor (listas, seletor de cor). */
export function LabelDot({ color }: { color: Label["color"] }) {
  return <span className="label-dot" data-color={color} aria-hidden="true" />;
}

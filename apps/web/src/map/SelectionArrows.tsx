import { useId } from "react";
import type { Arrow } from "./arrows.js";

/**
 * As setas do ticket selecionado (ADR 0069, seção 5), numa camada sobre a cena que não pega o ponteiro. As linhas vêm prontas em
 * coordenadas do palco (`selectionArrows`), calculadas no mesmo render que a câmera: acompanham zoom e arrasto sem atraso. Uma cor para
 * o que ele espera, outra para o que ele libera; "para entregar" é tracejada; a dependência já terminada fica apagada. Decorativa: a
 * página do ticket lista as dependências por escrito.
 */
export function SelectionArrows({ arrows }: { arrows: readonly Arrow[] }) {
  // O id do React traz caracteres que `url(#…)` não aceita sem escape; a camada usa só letras, números e hífen.
  const id = `map-arrows-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  if (arrows.length === 0) return null;
  const marker = (kind: Arrow["kind"]) => `${id}-${kind}`;
  return (
    <svg className="map-arrows" aria-hidden="true" focusable="false">
      <defs>
        {(["waits", "unlocks"] as const).map((kind) => (
          <marker key={kind} id={marker(kind)} className={`map-arrow-head is-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        ))}
      </defs>
      {arrows.map((arrow) => (
        <line
          key={arrow.key}
          className="map-arrow"
          data-kind={arrow.kind}
          data-need={arrow.need}
          data-finished={String(arrow.finished)}
          x1={arrow.x1}
          y1={arrow.y1}
          x2={arrow.x2}
          y2={arrow.y2}
          markerEnd={`url(#${marker(arrow.kind)})`}
        />
      ))}
    </svg>
  );
}

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { PRECEDENCE, SITUATION_COLORS } from "./situation.js";

/**
 * Legenda das cores de situação (ADR 0051): as situações e os lugares na fila (ADR 0069), na ordem de precedência (da mais
 * preocupante à menos), a regra do ramo, os três números do pai e as setas da seleção. Começa fechada, para não cobrir o mapa.
 */
export function StatusLegend() {
  const { t } = useTranslation("map");
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="map-legend" data-open={open ? "true" : "false"}>
      <button type="button" className="map-legend-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {t("legend.title")}
      </button>
      {open && (
        <div id={id} className="map-legend-body">
          <ul>
            {PRECEDENCE.map((situation) => (
              <li key={situation}>
                <span data-swatch={situation} className="map-legend-swatch" style={{ background: SITUATION_COLORS[situation] }} aria-hidden="true" />
                {t(`status.${situation}`)}
              </li>
            ))}
          </ul>
          <p>{t("legend.hint")}</p>
          <p>{t("legend.parentCounts")}</p>
          {(["waitsFor", "unlocks", "deliver"] as const).map((kind) => (
            <p key={kind} className="map-legend-arrow" data-arrow={kind}>
              <svg aria-hidden="true" width="22" height="8" viewBox="0 0 22 8">
                <line x1="1" y1="4" x2="21" y2="4" />
              </svg>
              {t(`legend.${kind}`)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

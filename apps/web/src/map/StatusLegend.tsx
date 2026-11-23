import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { PRECEDENCE, SITUATION_COLORS } from "./situation.js";

/**
 * Legenda das cores de situação (ADR 0051): as cinco situações, na ordem de precedência (da mais preocupante à menos), e
 * a regra do ramo. Começa fechada, para não cobrir o mapa.
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
        </div>
      )}
    </div>
  );
}

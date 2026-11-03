// PROTÓTIPO DESCARTÁVEL: quatro modelos de zoom semântico e lista, alternáveis por ?variant=A/B/C/D na rota web existente.
import { useEffect } from "react";
import type { PrototypeData, PrototypeVariant } from "./shared.js";
import { PROTOTYPE_VARIANTS } from "./shared.js";
import { VariantA } from "./VariantA.js";
import { VariantB } from "./VariantB.js";
import { VariantC } from "./VariantC.js";
import { VariantD } from "./VariantD.js";
import "./prototype.css";

const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  A: "Zoom ancorado e atenção",
  B: "Foco explícito",
  C: "Dois controles",
  D: "Lista hierárquica",
};

export function PrototypeExperience({ variant, data, onVariantChange }: {
  variant: PrototypeVariant;
  data: PrototypeData;
  onVariantChange: (variant: PrototypeVariant) => void;
}) {
  return <section className="proto-experience" aria-label="Protótipo descartável de experiência TreePM">
    <div className="proto-topline">
      <div><span className="proto-kicker">PROTÓTIPO · SOMENTE LEITURA</span><strong>{VARIANT_NAMES[variant]}</strong></div>
      <span>Nenhuma interação altera os dados</span>
    </div>
    <div className="proto-stage">
      {variant === "A" && <VariantA {...data} />}
      {variant === "B" && <VariantB {...data} />}
      {variant === "C" && <VariantC {...data} />}
      {variant === "D" && <VariantD {...data} />}
    </div>
    <PrototypeSwitcher current={variant} onChange={onVariantChange} />
  </section>;
}

function PrototypeSwitcher({ current, onChange }: { current: PrototypeVariant; onChange: (variant: PrototypeVariant) => void }) {
  const move = (direction: -1 | 1) => {
    const index = PROTOTYPE_VARIANTS.indexOf(current);
    const next = PROTOTYPE_VARIANTS[(index + direction + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length] ?? "A";
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState({}, "", url);
    onChange(next);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return <nav className="proto-switcher" aria-label="Alternar variantes do protótipo">
    <button onClick={() => move(-1)} aria-label="Variante anterior">←</button>
    <div><span>PROTÓTIPO</span><strong>{current} — {VARIANT_NAMES[current]}</strong><small>Use ← → para comparar</small></div>
    <button onClick={() => move(1)} aria-label="Próxima variante">→</button>
  </nav>;
}

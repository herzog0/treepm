import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "./map.css";
import "@treepm/react/styles.css";
import { makePanelMe } from "../panel/testing.js";
import { dependencyProject, dependencyTicketId, dependencyTickets } from "../test/dependencyMap.js";
import { makeTreeClient } from "../test/fakes.js";
import { frame, toPage, wheel } from "../test/touch.js";
import { OrganizationMap } from "./OrganizationMap.js";

// ADR 0069, seção 5, em navegador real: as setas do ticket selecionado seguem zoom e arrasto no mesmo quadro e não pegam o ponteiro.
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const PAYMENT = dependencyTicketId("Pagamento");

function Host() {
  const [open, setOpen] = useState<string | null>(PAYMENT);
  const [api] = useState(() => makeTreeClient({ projects: [dependencyProject], tickets: { loja: dependencyTickets() }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

const lines = () => [...document.querySelectorAll<SVGLineElement>(".map-arrows line")];
/** O fim da seta que chega no selecionado, em coordenadas da janela, e a caixa do card dele: têm de concordar no mesmo quadro. */
function waitsEndAgainstCard(): number {
  const svg = document.querySelector(".map-arrows")!.getBoundingClientRect();
  const arrow = lines().find((line) => line.dataset.kind === "waits")!;
  const x = svg.left + Number(arrow.getAttribute("x2"));
  const y = svg.top + Number(arrow.getAttribute("y2"));
  const card = document.querySelector(`[data-spatial-id="${PAYMENT}"]`)!.getBoundingClientRect();
  // Distância do ponto à borda da caixa: 0 quando o ponto está sobre ela.
  const outside = Math.hypot(Math.max(card.left - x, 0, x - card.right), Math.max(card.top - y, 0, y - card.bottom));
  const inside = Math.min(x - card.left, card.right - x, y - card.top, card.bottom - y);
  return outside > 0 ? outside : Math.max(inside, 0);
}

describe("setas da seleção, em navegador real", () => {
  it("desenham as dependências do selecionado nos dois sentidos, tracejada a 'para entregar', sem pegar o ponteiro", async () => {
    await page.viewport(1440, 900);
    await render(<Host />);
    await settle();
    const drawn = lines();
    // Pagamento espera Carrinho; libera Resumo do pedido, Endereços e (para entregar) Acessibilidade do checkout.
    expect(drawn.map((line) => line.dataset.kind).sort()).toEqual(["unlocks", "unlocks", "unlocks", "waits"]);
    expect(drawn.filter((line) => line.dataset.need === "deliver")).toHaveLength(1);
    const dashed = drawn.find((line) => line.dataset.need === "deliver")!;
    expect(getComputedStyle(dashed).strokeDasharray).not.toBe("none");
    expect(getComputedStyle(drawn.find((line) => line.dataset.kind === "waits")!).stroke).not.toBe(getComputedStyle(drawn.find((line) => line.dataset.kind === "unlocks")!).stroke);
    expect(getComputedStyle(document.querySelector(".map-arrows")!).pointerEvents).toBe("none");
    expect(waitsEndAgainstCard()).toBeLessThan(1.5);
  });

  it("seguem o zoom e o arrasto quadro a quadro, e somem quando a seleção sai", async () => {
    await page.viewport(1440, 900);
    await render(<Host />);
    await settle();
    const stage = document.querySelector<HTMLElement>(".spatial-stage")!.getBoundingClientRect();
    const center = { x: stage.left + stage.width * 0.3, y: stage.top + stage.height * 0.5 };
    const worst: number[] = [];
    for (let step = 0; step < 6; step += 1) {
      await wheel(center, step < 3 ? -120 : 120);
      for (let sample = 0; sample < 4; sample += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        if (lines().some((line) => line.dataset.kind === "waits")) worst.push(waitsEndAgainstCard());
      }
    }
    const from = toPage(center.x, center.y);
    await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      const to = toPage(center.x + step * 25, center.y + step * 12);
      await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      if (lines().some((line) => line.dataset.kind === "waits")) worst.push(waitsEndAgainstCard());
    }
    const end = toPage(center.x + 150, center.y + 72);
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1 });
    await frame();
    expect(worst.length).toBeGreaterThan(10);
    expect(Math.max(...worst)).toBeLessThan(1.5);

    document.querySelector<HTMLElement>(".spatial-stage")!.focus();
    document.querySelector<HTMLElement>(".spatial-stage")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frame();
    expect(lines()).toHaveLength(0);
  });
});

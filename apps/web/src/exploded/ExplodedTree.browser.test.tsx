import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../map/map.css";
import "@treepm/react/styles.css";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe } from "../panel/testing.js";
import { makeTreeClient } from "../test/fakes.js";
import { generatedProject, generatedTickets } from "../test/generatedProject.js";
import { toPage, wheel } from "../test/touch.js";

// ADR 0070, seção 7, em navegador real e com 500 tickets: a roda aproxima no cursor, arrastar move a tela, os cards ficam parados no mundo,
// o mapa embaixo não se mexe, e só o que está na tela vai para o DOM.
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

function Host() {
  const [open, setOpen] = useState<string | null>(null);
  const [api] = useState(() => makeTreeClient({ projects: [generatedProject], tickets: { gen: generatedTickets(500, 24) }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>(".exploded-card")];
const center = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width };
};
const mapScene = () => document.querySelector<HTMLElement>(".spatial-scene")!.style.transform;
/** O centro do card mais perto do meio do palco: aproximar ali sempre chega a cards (a grade tem espaços vazios). */
function nearMiddle(): { x: number; y: number } {
  const stage = document.querySelector(".exploded-stage")!.getBoundingClientRect();
  const middle = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 };
  const best = cards().map(center).sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y))[0]!;
  return { x: best.x, y: best.y };
}
async function zoomIn(at: { x: number; y: number }, steps: number) {
  for (let step = 0; step < steps; step += 1) {
    await wheel(at, -240);
    await settle(60);
  }
  await settle();
}

describe("árvore explodida em navegador real", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("a roda aproxima no ponto do cursor; o mapa embaixo não se mexe; com zoom, só os cards da tela estão no DOM", async () => {
    window.history.replaceState(null, "", "/?layout=tree");
    await page.viewport(1440, 900);
    await render(<Host />);
    await settle(1200);
    const before = mapScene();
    const anchor = nearMiddle();
    // A primeira vista já é de perto (escala 1): dois passos bastam, e ainda sobra zoom até o máximo.
    await zoomIn(anchor, 2);
    const shown = cards();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(120);
    expect(shown.every((card) => card.dataset.level === "card")).toBe(true);
    expect(mapScene()).toBe(before);

    // Um card perto do cursor continua perto do cursor depois de mais zoom no mesmo ponto.
    const near = shown.map((card) => ({ card, ...center(card) })).sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y))[0]!;
    const offset = { x: near.x - anchor.x, y: near.y - anchor.y };
    await zoomIn(anchor, 2);
    const after = center(near.card);
    const growth = after.width / near.width;
    expect(growth).toBeGreaterThan(1.2);
    expect(Math.abs(after.x - (anchor.x + offset.x * growth))).toBeLessThan(3);
    expect(Math.abs(after.y - (anchor.y + offset.y * growth))).toBeLessThan(3);
  });

  it("arrastar move a tela inteira junto, sem rearrumar os cards, e o mapa embaixo fica parado", async () => {
    window.history.replaceState(null, "", "/?layout=tree");
    await page.viewport(1440, 900);
    await render(<Host />);
    await settle(1200);
    const stage = document.querySelector(".exploded-stage")!.getBoundingClientRect();
    await zoomIn(nearMiddle(), 8);
    const before = mapScene();
    const [first, second] = cards();
    const a = center(first!);
    const b = center(second!);
    const from = { x: stage.left + 30, y: stage.bottom - 30 };
    const press = toPage(from.x, from.y);
    await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", x: press.x, y: press.y, button: "left", clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      const at = toPage(from.x + step * 20, from.y - step * 10);
      await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "left", buttons: 1 });
      await settle(30);
    }
    const end = toPage(from.x + 120, from.y - 60);
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1 });
    await settle(300);
    const a2 = center(first!);
    const b2 = center(second!);
    expect(a2.x - a.x).toBeCloseTo(120, 0);
    expect(a2.y - a.y).toBeCloseTo(-60, 0);
    expect(b2.x - a2.x).toBeCloseTo(b.x - a.x, 1);
    expect(b2.y - a2.y).toBeCloseTo(b.y - a.y, 1);
    expect(mapScene()).toBe(before);
    expect(document.querySelector("[aria-label='Página do ticket']")).toBeNull();
  });
});

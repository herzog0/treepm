import { useState } from "react";
import { afterEach, describe, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "./map.css";
import "./agent-work.css";
import "@treepm/react/styles.css";
import { makePanelMe } from "../panel/testing.js";
import { dependencyProject, dependencyTicketId, dependencyTickets } from "../test/dependencyMap.js";
import { makeTreeClient } from "../test/fakes.js";
import { toPage, wheel } from "../test/touch.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Capturas da conferência visual da ADR 0069: só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em `screenshots/` na raiz do
// worktree (fora do Git). O app só tem o tema escuro; cada vista sai com "Cores" desligado (o padrão do mapa) e ligado.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const DIR = "../../../../screenshots";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}.png`, save: true });
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

function Host({ open = null, focus = null }: { open?: string | null; focus?: string | null }) {
  const [opened, setOpened] = useState<string | null>(open);
  const [focusId, setFocusId] = useState<string | null>(focus);
  const [api] = useState(() => makeTreeClient({ projects: [dependencyProject], tickets: { loja: dependencyTickets() }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={opened} onOpenTicketChange={setOpened} focusTicketId={focusId} onFocusHandled={() => setFocusId(null)} />
    </main>
  );
}

const toggleColors = () => document.querySelector<HTMLButtonElement>(".spatial-color-toggle")!.click();
const openLegend = () => document.querySelector<HTMLButtonElement>(".map-legend-toggle")!.click();
async function both(name: string) {
  await shot(`${name}-cores-desligado`);
  toggleColors();
  await settle(400);
  await shot(`${name}-cores-ligado`);
  toggleColors();
}

describe.skipIf(!ON)("capturas da ADR 0069", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await page.viewport(1280, 720);
  });

  /** Wheel em passos no centro do card pedido (zoom para dentro com `delta` negativo). */
  async function zoomAt(id: string, steps: number, delta = -120) {
    for (let step = 0; step < steps; step += 1) {
      const card = document.querySelector(`[data-spatial-id="${id}"]`)!.getBoundingClientRect();
      await wheel({ x: card.left + card.width / 2, y: card.top + card.height / 2 }, delta);
      await settle(150);
    }
    await settle();
  }

  /** Arrasta o mapa até o card pedido ficar com o canto de cima à esquerda em (`x`, `y`). */
  async function dragCardTo(id: string, x: number, y: number) {
    const card = document.querySelector(`[data-spatial-id="${id}"]`)!.getBoundingClientRect();
    const stage = document.querySelector(".spatial-stage")!.getBoundingClientRect();
    const from = { x: stage.left + stage.width / 2, y: stage.top + stage.height * 0.85 };
    const to = { x: from.x + (x - card.left), y: from.y + (y - card.top) };
    const press = toPage(from.x, from.y);
    await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", x: press.x, y: press.y, button: "left", clickCount: 1 });
    for (let step = 1; step <= 10; step += 1) {
      const at = toPage(from.x + ((to.x - from.x) * step) / 10, from.y + ((to.y - from.y) * step) / 10);
      await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "left", buttons: 1 });
      await settle(30);
    }
    const release = toPage(to.x, to.y);
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", x: release.x, y: release.y, button: "left", clickCount: 1 });
    await settle();
  }

  it("o projeto de longe e um pai aberto", async () => {
    await page.viewport(1440, 900);
    await render(<Host />);
    await settle();
    await zoomAt(dependencyProject.id, Number(import.meta.env["VITE_FAR_STEPS"] ?? 7));
    openLegend();
    await settle(300);
    await both("1-projeto-de-longe");
    openLegend();
    await zoomAt(dependencyTicketId("Carrinho"), Number(import.meta.env["VITE_PARENT_STEPS"] ?? 8));
    await dragCardTo(dependencyTicketId("Checkout"), 40, 60);
    await both("2-pai-aberto");
  });

  it("um ticket selecionado: as setas nos dois sentidos, uma tracejada", async () => {
    await page.viewport(1440, 900);
    await render(<Host open={dependencyTicketId("Pagamento")} />);
    await settle(1500);
    await zoomAt(dependencyTicketId("Pagamento"), Number(import.meta.env["VITE_SELECTED_STEPS"] ?? 3), 120);
    await both("3-ticket-selecionado");
  });
});

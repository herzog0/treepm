import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "./map.css";
import "./agent-work.css";
import "@treepm/react/styles.css";
import { makePanelMe } from "../panel/testing.js";
import { wheel } from "../test/touch.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";
import { SITUATION_COLORS } from "./situation.js";

// ADR 0051: a cor de cada card, desenhada de verdade. Um bloqueado três níveis abaixo pinta todos os ancestrais; o ramo todo concluído é verde.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(", ")})`;

const progress = (done: number, total: number) => ({ done, total, excluded: 0 });
function Harness() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [client] = useState(() =>
    makeTreeClient({
      projects: [project],
      tickets: {
        p1: [
          makeTicket("a1", "p1", 1, "Plataforma", { key: "ALFA-1", status: "in_progress", progress: progress(1, 4) }),
          makeTicket("a2", "p1", 2, "Servidor", { key: "ALFA-2", status: "in_progress", parentId: "a1", progress: progress(0, 2) }),
          makeTicket("a3", "p1", 3, "Interface", { key: "ALFA-3", status: "todo", parentId: "a2", progress: progress(0, 1) }),
          makeTicket("a4", "p1", 4, "Login travado", { key: "ALFA-4", status: "todo", parentId: "a3", blocked: true }),
          makeTicket("a5", "p1", 5, "Em andamento", { key: "ALFA-5", status: "in_progress", parentId: "a2" }),
          makeTicket("a6", "p1", 6, "Pronto", { key: "ALFA-6", status: "done", parentId: "a1" }),
          makeTicket("b1", "p1", 7, "Documentação", { key: "ALFA-7", status: "in_progress", progress: progress(2, 2) }),
          makeTicket("b2", "p1", 8, "Guia", { key: "ALFA-8", status: "done", parentId: "b1" }),
          makeTicket("b3", "p1", 9, "Exemplos", { key: "ALFA-9", status: "done", parentId: "b1" }),
        ],
      },
      people: [],
    }),
  );
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={openId} onOpenTicketChange={setOpenId} />
    </main>
  );
}
const visual = (id: string) => document.querySelector<HTMLElement>(`.spatial-node[data-spatial-id="${id}"] .spatial-card-visual`);
/** O nó existe e tem o nível de card (compacto, chip ou completo), não o de ponto: só o card tem a linha superior. */
const isCard = (id: string) => visual(id) !== null && !visual(id)!.closest(".spatial-node")!.classList.contains("spatial-lod-dot");
const topLine = (id: string) => getComputedStyle(visual(id)!).borderTopColor;

let restore: (() => Promise<void>) | null = null;
afterEach(async () => {
  await restore?.();
  restore = null;
});

describe("cores por situação no mapa (ADR 0051)", () => {
  it("a linha superior do card de cada ancestral de um bloqueado é vermelha, e o ramo todo concluído é verde", async () => {
    await page.viewport(1440, 900);
    restore = async () => page.viewport(1280, 720);
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
    await screen.getByRole("button", { name: "Explorar ramo" }).click();
    await settle();
    expect(topLine("a1")).toBe(rgb(SITUATION_COLORS.blocked));
    for (const id of ["b1"]) expect(topLine(id), id).toBe(rgb(SITUATION_COLORS.done));
    // Desce pelo ramo bloqueado com o zoom, um nível por vez: cada ancestral aparece como card e é vermelho.
    for (const [from, next] of [["a1", "a2"], ["a2", "a3"], ["a3", "a4"]] as const) {
      for (let step = 0; step < 10 && !isCard(next); step += 1) {
        const box = visual(from)!.getBoundingClientRect();
        await wheel({ x: box.left + box.width / 2, y: box.top + box.height / 2 }, -400);
        await settle(250);
      }
      expect(topLine(next), next).toBe(rgb(SITUATION_COLORS.blocked));
      expect(topLine(from), from).toBe(rgb(SITUATION_COLORS.blocked));
    }
  });

  it("a legenda abre, lista as cinco situações e os três lugares na fila (ADR 0069) e cabe na janela", async () => {
    await page.viewport(390, 844);
    restore = async () => page.viewport(1280, 720);
    const screen = await render(<Harness />);
    await settle(300);
    await screen.getByRole("button", { name: "Situações" }).click();
    const body = document.querySelector<HTMLElement>(".map-legend-body")!;
    expect(body.querySelectorAll("li")).toHaveLength(8);
    const box = body.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(390);
    // Nada cobre a legenda aberta, nem o botão que a abre (a barra de pedidos e a folha de seleção ficam por baixo).
    const at = (element: Element) => { const r = element.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
    expect(body.contains(at(body))).toBe(true);
    const toggle = document.querySelector<HTMLElement>(".map-legend-toggle")!;
    expect(toggle.contains(at(toggle))).toBe(true);
  });
});

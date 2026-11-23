import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
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
import { makePanelMe, makePerson } from "../panel/testing.js";
import { randomTickets } from "../test/randomTree.js";
import { makeProject, makeTreeClient } from "../test/fakes.js";
import { toPage, wheel } from "../test/touch.js";
import { OrganizationMap } from "./OrganizationMap.js";
import type * as Content from "./nodeContent.js";
import type * as Zoom from "./zoom.js";

// Quadros do mapa (TREEPM-247). Uma sequência fixa de gestos numa árvore gerada com semente; o DOM da cena depois de cada quadro tem de ser
// o mesmo de antes das correções de custo (`FRAME_DIGESTS`, gravado com o código anterior). Os contadores abaixo medem trabalho por quadro, não relógio.
const counts = vi.hoisted(() => ({ maxScale: 0, nodeContent: 0 }));
vi.mock("./zoom.js", async (importOriginal) => {
  const zoom = await importOriginal<typeof Zoom>();
  return { ...zoom, computeMapMaxScale: (items: Parameters<typeof zoom.computeMapMaxScale>[0]) => { counts.maxScale += 1; return zoom.computeMapMaxScale(items); } };
});
vi.mock("./nodeContent.js", async (importOriginal) => {
  const content = await importOriginal<typeof Content>();
  return { ...content, renderNodeContent: ((...args: Parameters<typeof content.renderNodeContent>) => { counts.nodeContent += 1; return content.renderNodeContent(...args); }) as typeof content.renderNodeContent };
});

const frames = (count = 3) => new Promise<void>((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** FNV-1a de 32 bits do HTML da cena: igual ao de antes ⇔ mesmos nós, mesmos estilos, mesmas posições. */
function digest(): string {
  const html = document.querySelector(".spatial-scene")?.outerHTML ?? "";
  let hash = 0x811c9dc5;
  for (let at = 0; at < html.length; at += 1) hash = Math.imul(hash ^ html.charCodeAt(at), 0x01000193) >>> 0;
  return `${html.length}:${hash.toString(16)}`;
}
function anchor(): { x: number; y: number } {
  let best: { x: number; y: number; d: number } | null = null;
  for (const element of document.querySelectorAll<HTMLElement>(".spatial-card-button")) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight) continue;
    const x = Math.min(innerWidth - 5, Math.max(5, rect.left + rect.width / 2));
    const y = Math.min(innerHeight - 5, Math.max(5, rect.top + rect.height / 2));
    const d = Math.hypot(x - innerWidth / 2, y - innerHeight / 2);
    if (best === null || d < best.d) best = { x, y, d };
  }
  return best ? { x: best.x, y: best.y } : { x: innerWidth / 2, y: innerHeight / 2 };
}
async function dragBy(from: { x: number; y: number }, moves: number, onMove?: () => void) {
  const start = toPage(from.x, from.y);
  const send = (type: string, x: number, y: number) => cdp().send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } as never);
  await send("mousePressed", start.x, start.y);
  for (let step = 1; step <= moves; step += 1) {
    await send("mouseMoved", start.x + step * 6, start.y + step * 4);
    await frames(2);
    onMove?.();
  }
  await send("mouseReleased", start.x + moves * 6, start.y + moves * 4);
  await frames(2);
}

// Gravado com o código de antes das correções (`746c882`); para regravar, esvazie a lista e copie a linha `FRAME_DIGESTS=` que o teste imprime.
const FRAME_DIGESTS: string[] = [
  "9003:313ee322",
  "9008:397ed2e6",
  "36003:f1b59dc9",
  "19579:dc6e7d3b",
  "11894:c3362420",
  "5869:c8b9872e",
  "2629:ed0071a1",
  "1330:3cd21adf",
  "1326:1d69b7ea",
  "1330:97b36e72",
  "1328:8a8d5fe5",
  "1330:80338cf7",
  "1329:4ed32412",
  "1326:3fbc61c7",
  "1326:168ebe3c",
  "1326:f8677dde",
  "1326:ef3bf709",
  "1326:11bbb3f1",
  "1326:78043c21",
  "1326:80f047c0",
  "1326:f68cedc1",
  "1329:8e1a9ff4",
  "1330:34534fd7",
  "1328:47d77588",
  "1330:d65a1109",
  "1325:73a3b78b",
  "1330:4c271ebc",
  "2629:bf5ab0ce",
  "5869:1da13086",
  "11893:e19ee93e",
  "19579:dbd4a307",
  "36003:2d96178f",
  "9009:d79c5dea",
  "9003:8e122efa",
];

describe("quadros do mapa em árvore gerada", () => {
  it("o DOM da cena depois de cada quadro é o de antes das correções, e o quadro de arraste não refaz nem o conteúdo dos nós nem a escala máxima", async () => {
    await page.viewport(1440, 900);
    // Sem movimento suave o zoom da roda salta direto ao destino: a sequência não depende do relógio.
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const project = makeProject("p1", "ALFA", "Projeto Alfa");
    const tickets = randomTickets(400, 11, "p1").map((ticket, at) => ({ ...ticket, key: `ALFA-${at + 1}`, descriptionExcerpt: at % 3 === 0 ? `Trecho da descrição ${at}. `.repeat(1 + (at % 5)) : "" }));
    const client = makeTreeClient({ projects: [project], tickets: { p1: tickets }, people: [makePerson("person-1", "Ana")] });
    let commits = 0;
    const screen = await render(
      <Profiler id="map" onRender={() => { commits += 1; }}>
        <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
          <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={null} onOpenTicketChange={() => undefined} />
        </main>
      </Profiler>,
    );
    await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
    await screen.getByRole("button", { name: "Explorar ramo" }).click();
    await document.fonts.ready;
    await sleep(800);
    const seen: string[] = [digest()];
    for (let step = 0; step < 14; step += 1) {
      await wheel(anchor(), -240);
      await frames(4);
      await sleep(60);
      seen.push(digest());
    }
    // Arraste: nenhum conteúdo de nó é refeito (a câmera é a única coisa que muda) e a escala máxima não é recalculada por quadro.
    await frames(3);
    const before = { content: counts.nodeContent, maxScale: counts.maxScale, commits };
    let moved = 0;
    await dragBy(anchor(), 20, () => { moved += 1; if (moved % 4 === 0) seen.push(digest()); });
    const drag = { content: counts.nodeContent - before.content, maxScale: counts.maxScale - before.maxScale, commits: commits - before.commits };
    for (let step = 0; step < 14; step += 1) {
      await wheel({ x: 720, y: 450 }, 240);
      await frames(4);
      await sleep(60);
      seen.push(digest());
    }
    await screen.unmount();
    if (FRAME_DIGESTS.length === 0) console.log(`FRAME_DIGESTS=${JSON.stringify(seen)}`);
    expect(seen).toEqual(FRAME_DIGESTS);
    expect(drag.content).toBe(0);
    expect(drag.maxScale).toBe(0);
    expect(drag.commits).toBeLessThanOrEqual(25);
  }, 120_000);
});

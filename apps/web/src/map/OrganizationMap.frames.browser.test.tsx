import { Profiler } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
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
// o gravado em `FRAME_DIGESTS` (as correções de custo não mudam a cena; desde a ADR 0067 os resumos são os do layout novo). Os contadores abaixo medem trabalho por quadro, não relógio.
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

// Regravado com o layout da ADR 0067 (filhos no próprio tamanho, região mais larga); a gravação original era de antes das correções de custo (`746c882`).
// Para regravar, esvazie a lista e copie a linha `FRAME_DIGESTS=` que o teste imprime.
const FRAME_DIGESTS: string[] = [
  "9003:fd663391",
  "34310:2c3960fb",
  "32333:7b4342fd",
  "39991:375c16da",
  "20329:ab785798",
  "8544:20b0af1d",
  "5886:53e48314",
  "1330:7a31e617",
  "1326:c0c926e5",
  "1330:58a8d9ba",
  "1330:f420cb49",
  "1329:20bed551",
  "1326:5a95b7fa",
  "1326:c90247e8",
  "1326:3d1babf4",
  "1326:4fdc490a",
  "1326:e1b4fc5e",
  "1326:f8c4a92",
  "1326:9aff25db",
  "1326:17738692",
  "1326:31185554",
  "1328:85556557",
  "1329:636adac8",
  "1330:637de102",
  "1330:adeed8d0",
  "1325:ac4c18cb",
  "1330:f814229a",
  "5886:cd967346",
  "8544:17feac3d",
  "23098:38fe3a20",
  "39991:c7a96a24",
  "32332:996c4a8a",
  "34310:25f13cc2",
  "9003:ae7098b6",
];

describe("quadros do mapa em árvore gerada", () => {
  // A emulação vale para o navegador inteiro (no Chromium compartilhado, também para os outros arquivos): devolve ao padrão.
  afterAll(async () => {
    await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  });
  it("o DOM da cena depois de cada quadro é o gravado, e o quadro de arraste não refaz nem o conteúdo dos nós nem a escala máxima", async () => {
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

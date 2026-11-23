/**
 * Medição do mapa com projeto grande em navegador real, sem janela (TREEPM-191):
 *   pnpm --filter @treepm/web measure:big-project:browser   (depois de `measure:big-project` da API, que grava os dados)
 * Por N: tempo até o mapa aparecer, nós no DOM em cada nível de zoom e custo por quadro de zoom (roda do mouse) e de arraste.
 * Custo por quadro = intervalo entre `requestAnimationFrame` durante o gesto (16,7 ms é o quadro de uma tela de 60 Hz).
 */
import { cdp, commands, page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "../map/map.css";
import "../map/agent-work.css";
import "@treepm/react/styles.css";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient } from "../test/fakes.js";
import { toPage, wheel } from "../test/touch.js";
import type { Person, Project, TicketSummary } from "../api/client.js";

declare const __MEASURE_DIR__: string;
declare const __MEASURE_SIZES__: string;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function recordFrames() {
  const stamps: number[] = [];
  let on = true;
  const loop = (time: number) => {
    if (!on) return;
    stamps.push(time);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return {
    stop() {
      on = false;
      const gaps = stamps.slice(1).map((value, index) => value - (stamps[index] as number)).sort((a, b) => a - b);
      const at = (p: number) => Math.round((gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0) * 10) / 10;
      return { gaps, frames: gaps.length, medianMs: at(0.5), p95Ms: at(0.95), worstMs: at(1), over33ms: gaps.filter((gap) => gap > 33.4).length, over100ms: gaps.filter((gap) => gap > 100).length };
    },
  };
}

const domCounts = () => ({
  cards: document.querySelectorAll(".spatial-node").length,
  indicators: document.querySelectorAll(".spatial-indicator-group, [data-indicator-group]").length,
  allInScene: document.querySelector(".spatial-scene")?.getElementsByTagName("*").length ?? 0,
  allInPage: document.getElementsByTagName("*").length,
});

/** O botão de card mais perto do centro da tela: o ponto onde o zoom entra mais fundo. */
function anchorPoint(): { x: number; y: number } | null {
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  let best: { x: number; y: number; d: number } | null = null;
  for (const element of document.querySelectorAll<HTMLElement>(".spatial-card-button")) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) continue;
    const x = Math.min(window.innerWidth - 5, Math.max(5, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 5, Math.max(5, rect.top + rect.height / 2));
    const d = Math.hypot(x - centerX, y - centerY);
    if (best === null || d < best.d) best = { x, y, d };
  }
  return best ? { x: best.x, y: best.y } : { x: centerX, y: centerY };
}

async function drag(from: { x: number; y: number }, steps: number) {
  const start = toPage(from.x, from.y);
  const send = (type: string, x: number, y: number) => cdp().send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 } as never);
  await send("mousePressed", start.x, start.y);
  for (let step = 1; step <= steps; step += 1) {
    await send("mouseMoved", start.x + step * 6, start.y + step * 4);
    await nextFrame();
  }
  await send("mouseReleased", start.x + steps * 6, start.y + steps * 4);
}

describe("mapa com projeto grande, em navegador real", () => {
  for (const n of __MEASURE_SIZES__.split(",").map(Number)) {
    it(`N = ${n}`, async () => {
      let tickets: TicketSummary[];
      let projects: Project[];
      let people: Person[];
      try {
        tickets = JSON.parse(await commands.readFile(`${__MEASURE_DIR__}${n}/tickets.json`)) as TicketSummary[];
        projects = JSON.parse(await commands.readFile(`${__MEASURE_DIR__}${n}/projects.json`)) as Project[];
        people = JSON.parse(await commands.readFile(`${__MEASURE_DIR__}${n}/people.json`)) as Person[];
      } catch {
        console.warn(`sem dados para N = ${n}; rode antes pnpm --filter @treepm/api measure:big-project`);
        return;
      }
      const project = projects[0] as Project;
      const result: Record<string, unknown> = { n, viewport: "1440×900" };
      await page.viewport(1440, 900);
      const client = makeClient({ projects, tickets: { [project.id]: tickets }, people });
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longTasks.push(entry.duration)));
      try {
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        // longtask indisponível: só o tempo medido à mão vale.
      }

      // 1. Tempo até o mapa aparecer: do início da montagem até haver um card visível.
      const started = performance.now();
      const screen = await render(
        <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
          <OrganizationMap client={client} me={makePanelMe("admin")} />
        </main>,
      );
      const rendered = performance.now() - started;
      while (document.querySelector(".spatial-card-button") === null) {
        if (performance.now() - started > 120_000) throw new Error("o mapa não apareceu em 120 s");
        await nextFrame();
      }
      const visible = performance.now() - started;
      await sleep(1500);
      result["renderResolvedMs"] = Math.round(rendered);
      result["firstCardMs"] = Math.round(visible);
      result["longTasksUntilFirstCard"] = { count: longTasks.length, totalMs: Math.round(longTasks.reduce((sum, d) => sum + d, 0)), worstMs: Math.round(Math.max(0, ...longTasks)) };
      const levels: Record<string, unknown>[] = [{ level: "inicial (organização)", ...domCounts() }];

      // 2. Entra no projeto e explora o ramo; depois aproxima por roda do mouse, nível a nível, até onde der.
      await screen.getByRole("button", { name: new RegExp(`${project.key} · `) }).click();
      await screen.getByRole("button", { name: "Explorar ramo" }).click();
      await sleep(1500);
      levels.push({ level: "projeto explorado", ...domCounts() });
      const zoomFrames: Record<string, unknown>[] = [];
      const allGaps: number[] = [];
      let lastCards = -1;
      let sameCount = 0;
      // Passos de 3 ticks de roda (fator ~1,8 cada): passa por todos os níveis de detalhe até o zoom máximo (a escala máxima é enorme).
      for (let step = 1; step <= 30 && sameCount < 2; step += 1) {
        const anchor = anchorPoint() as { x: number; y: number };
        const recorder = recordFrames();
        for (let tick = 0; tick < 3; tick += 1) {
          await wheel(anchor, -120);
          await nextFrame();
        }
        await sleep(250);
        const { gaps, ...frames } = recorder.stop();
        allGaps.push(...gaps);
        const counts = domCounts();
        levels.push({ level: `zoom ${step} (3 ticks de roda)`, ...counts });
        zoomFrames.push({ step, ...frames });
        sameCount = counts.cards === lastCards && counts.cards <= 2 ? sameCount + 1 : 0;
        lastCards = counts.cards;
      }
      allGaps.sort((a, b) => a - b);
      const pick = (p: number) => Math.round((allGaps[Math.min(allGaps.length - 1, Math.floor(allGaps.length * p))] ?? 0) * 10) / 10;
      result["zoomFramesAll"] = { frames: allGaps.length, medianMs: pick(0.5), p95Ms: pick(0.95), worstMs: pick(1), over33ms: allGaps.filter((gap) => gap > 33.4).length, over100ms: allGaps.filter((gap) => gap > 100).length };
      result["levels"] = levels;
      result["zoomFrames"] = zoomFrames;

      // 3. Arraste: no nível mais fundo alcançado e depois afastando até um nível médio.
      const dragFrames: Record<string, unknown>[] = [];
      const measureDrag = async (label: string) => {
        const anchor = anchorPoint() as { x: number; y: number };
        const recorder = recordFrames();
        await drag(anchor, 40);
        await sleep(200);
        const frames = { ...recorder.stop(), gaps: undefined };
        dragFrames.push({ label, ...frames, ...domCounts() });
      };
      await measureDrag("arraste no nível mais fundo");
      for (let tick = 0; tick < 25; tick += 1) {
        await wheel({ x: 720, y: 450 }, 140);
        await nextFrame();
      }
      await sleep(500);
      await measureDrag("arraste, afastado 25 ticks");
      for (let tick = 0; tick < 40; tick += 1) {
        await wheel({ x: 720, y: 450 }, 140);
        await nextFrame();
      }
      await sleep(500);
      await measureDrag("arraste, visão geral");
      result["dragFrames"] = dragFrames;
      result["longTasksTotal"] = { count: longTasks.length, totalMs: Math.round(longTasks.reduce((sum, d) => sum + d, 0)), worstMs: Math.round(Math.max(0, ...longTasks)) };
      observer.disconnect();
      await commands.writeFile(`${__MEASURE_DIR__}web-browser-${n}.json`, JSON.stringify(result, null, 2));
      expect(result["firstCardMs"]).toBeGreaterThan(0);
      await screen.unmount();
    });
  }
});

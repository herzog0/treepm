/**
 * Onde vai o tempo de um quadro de zoom e de arraste do mapa (TREEPM-247), em Chrome sem janela:
 *   pnpm --filter @treepm/web measure:map-frame   (depois de `measure:big-project` da API, que grava os dados)
 *   MEASURE_SIZES=20000 MEASURE_PASSES=react,trace pnpm --filter @treepm/web measure:map-frame
 * Passes (cada um refaz a mesma sequência de gestos do `bigProject.measure.browser.tsx`, em montagem nova):
 *   frames  intervalo entre `requestAnimationFrame` (sem nenhuma instrumentação: a referência);
 *   react   `<Profiler>` em volta do mapa (commits e tempo de render por quadro) + MutationObserver (nós do DOM que mudam);
 *   trace   Tracing do CDP: tempo de script, estilo, layout, pintura e GC por nível de zoom;
 *   cpu     amostragem de CPU do CDP (Profiler): tempo próprio por função.
 * Saída: `<MEASURE_DIR>map-frame-N.json`. Fora das suítes permanentes (`*.measure.browser.tsx`).
 */
import { Profiler } from "react";
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
declare const __MEASURE_PASSES__: string;
declare const __MEASURE_REACT__: string;
declare const __MEASURE_STYLE__: string;
declare const __MEASURE_LABEL__: string;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

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
      return stamps.slice(1).map((value, index) => value - (stamps[index] as number));
    },
  };
}

const domCounts = () => ({
  cards: document.querySelectorAll(".spatial-node").length,
  groups: document.querySelectorAll("[data-spatial-group-id]").length,
  inScene: document.querySelector(".spatial-scene")?.getElementsByTagName("*").length ?? 0,
});

function anchorPoint(): { x: number; y: number } {
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

// ---- instrumentos ----

interface CommitSample { phase: string; actual: number; base: number }
const commits: CommitSample[] = [];
const onRender = (_id: string, phase: string, actual: number, base: number) => void commits.push({ phase, actual, base });

/** Quantos nós do DOM da cena mudaram (atributo, texto, filhos) durante o gesto. */
function watchMutations() {
  const touched = new Set<Node>();
  let records = 0;
  let childList = 0;
  const observer = new MutationObserver((list) => {
    for (const record of list) {
      records += 1;
      if (record.type === "childList") childList += record.addedNodes.length + record.removedNodes.length;
      touched.add(record.target);
    }
  });
  const scene = document.querySelector(".spatial-scene") as Element;
  observer.observe(scene, { subtree: true, attributes: true, childList: true, characterData: true });
  return () => {
    for (const record of observer.takeRecords()) { records += 1; touched.add(record.target); }
    observer.disconnect();
    return { records, distinctNodes: touched.size, nodesAddedOrRemoved: childList };
  };
}

const TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute", "blink.user_timing"];
interface TraceEvent { name: string; ph: string; dur?: number; ts: number; tid: number; args?: Record<string, unknown> }
async function traceSteps<T>(body: () => Promise<T>): Promise<{ result: T; events: TraceEvent[] }> {
  const events: TraceEvent[] = [];
  const client = cdp();
  const collect = (event: { value: TraceEvent[] }) => void events.push(...event.value);
  client.on("Tracing.dataCollected", collect as never);
  const complete = new Promise<void>((resolve) => client.on("Tracing.tracingComplete", (() => resolve()) as never));
  await client.send("Tracing.start", { traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: TRACE_CATEGORIES }, transferMode: "ReportEvents" } as never);
  const result = await body();
  await client.send("Tracing.end");
  await complete;
  client.off("Tracing.dataCollected", collect as never);
  return { result, events };
}
/** Soma de duração por categoria de trabalho do navegador (só eventos completos; os aninhados não são somados duas vezes). */
function summarizeTrace(events: TraceEvent[], frames: number) {
  const sum = (names: string[]) => events.filter((event) => event.ph === "X" && names.includes(event.name)).reduce((total, event) => total + (event.dur ?? 0), 0) / 1000;
  const style = events.filter((event) => event.ph === "X" && event.name === "UpdateLayoutTree");
  const layout = events.filter((event) => event.ph === "X" && event.name === "Layout");
  // Script de página: FunctionCall/EvaluateScript contados só no nível de cima (os aninhados ficam dentro de outro FunctionCall).
  const calls = events.filter((event) => event.ph === "X" && (event.name === "FunctionCall" || event.name === "FireAnimationFrame" || event.name === "EventDispatch")).sort((a, b) => a.ts - b.ts);
  let script = 0;
  let until = -1;
  for (const call of calls) {
    if (call.ts < until) continue;
    script += call.dur ?? 0;
    until = call.ts + (call.dur ?? 0);
  }
  const raf = sum(["FireAnimationFrame"]);
  return {
    frames, taskMs: round(sum(["RunTask"])), taskPerFrameMs: frames > 0 ? round(sum(["RunTask"]) / frames) : null,
    scriptMs: round(script / 1000), rafCallbackMs: round(raf),
    styleRecalcMs: round(sum(["UpdateLayoutTree"])), styleRecalcCount: style.length, styleElements: style.reduce((total, event) => total + Number((event.args as { elementCount?: number } | undefined)?.elementCount ?? 0), 0),
    layoutMs: round(sum(["Layout"])), layoutCount: layout.length,
    prePaintMs: round(sum(["PrePaint"])), paintMs: round(sum(["Paint"])), layerizeMs: round(sum(["Layerize"])), commitMs: round(sum(["Commit"])),
    gcMs: round(sum(["MinorGC", "MajorGC", "V8.GCScavenger", "V8.GCIncrementalMarking", "V8.GCFinalizeMC", "BlinkGC.AtomicPhase"])),
    perFrame: frames > 0 ? { scriptMs: round(script / 1000 / frames), styleRecalcMs: round(sum(["UpdateLayoutTree"]) / frames), layoutMs: round(sum(["Layout"]) / frames), paintMs: round((sum(["PrePaint"]) + sum(["Paint"]) + sum(["Layerize"]) + sum(["Commit"])) / frames) } : null,
  };
}

interface CpuNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
interface CpuProfile { nodes: CpuNode[]; samples: number[]; timeDeltas: number[] }
const functionKey = (frame: CpuNode["callFrame"]) => `${frame.functionName || "(anônima)"}  ${frame.url.split("/").slice(-2).join("/").replace(/\?.*$/, "")}:${frame.lineNumber}`;
/** Tempo próprio (só a função) e inclusivo (a função e o que ela chama; cada amostra conta uma vez por função) por função, em ms. */
function addCpuProfile(profile: CpuProfile, own: Map<string, number>, inclusive: Map<string, number>) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
  profile.samples.forEach((id, index) => {
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    const key = functionKey((byId.get(id) as CpuNode).callFrame);
    own.set(key, (own.get(key) ?? 0) + ms);
    const seen = new Set<string>();
    for (let current: number | undefined = id; current !== undefined; current = parentOf.get(current)) {
      const name = functionKey((byId.get(current) as CpuNode).callFrame);
      if (seen.has(name)) continue;
      seen.add(name);
      inclusive.set(name, (inclusive.get(name) ?? 0) + ms);
    }
  });
}

// ---- cenário ----

type Pass = "frames" | "react" | "trace" | "cpu";

async function runScenario(pass: Pass, project: Project, projects: Project[], tickets: TicketSummary[], people: Person[]) {
  await page.viewport(1440, 900);
  commits.length = 0;
  const client = makeClient({ projects, tickets: { [project.id]: tickets }, people });
  // Experimento: CSS extra (MEASURE_STYLE) para estimar o que uma mudança de estilo pouparia; nunca vale como medida do produto.
  if (__MEASURE_STYLE__ !== "") {
    const extra = document.createElement("style");
    extra.setAttribute("data-measure-style", "");
    extra.textContent = __MEASURE_STYLE__;
    document.head.append(extra);
  }
  const screen = await render(
    <Profiler id="map" onRender={onRender}>
      <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
        <OrganizationMap client={client} me={makePanelMe("admin")} />
      </main>
    </Profiler>,
  );
  const started = performance.now();
  while (document.querySelector(".spatial-card-button") === null) {
    if (performance.now() - started > 120_000) throw new Error("o mapa não apareceu em 120 s");
    await nextFrame();
  }
  await sleep(1500);
  await screen.getByRole("button", { name: new RegExp(`${project.key} · `) }).click();
  await screen.getByRole("button", { name: "Explorar ramo" }).click();
  await sleep(1500);

  const steps: Record<string, unknown>[] = [];
  const gapsByKind: Record<"zoom" | "drag", number[]> = { zoom: [], drag: [] };
  const cpuOwn = new Map<string, number>();
  const cpuInclusive = new Map<string, number>();
  const gesture = async (label: string, run: () => Promise<void>) => {
    const counts = domCounts();
    const recorder = recordFrames();
    const commitStart = commits.length;
    const stopMutations = pass === "react" ? watchMutations() : null;
    let traced: TraceEvent[] = [];
    let cpuProfile: CpuProfile | null = null;
    if (pass === "trace") {
      const { events } = await traceSteps(async () => { await run(); await sleep(200); });
      traced = events;
    } else if (pass === "cpu") {
      await cdp().send("Profiler.enable");
      await cdp().send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp().send("Profiler.start");
      await run();
      await sleep(200);
      cpuProfile = ((await cdp().send("Profiler.stop")) as unknown as { profile: CpuProfile }).profile;
    } else {
      await run();
      await sleep(200);
    }
    const gaps = recorder.stop();
    gapsByKind[label.startsWith("zoom") ? "zoom" : "drag"].push(...gaps);
    const sorted = [...gaps].sort((a, b) => a - b);
    const entry: Record<string, unknown> = { label, ...counts, frames: gaps.length, medianMs: round(pct(sorted, 0.5)), p95Ms: round(pct(sorted, 0.95)), worstMs: round(pct(sorted, 1)) };
    if (pass === "react") {
      const mine = commits.slice(commitStart);
      const actual = mine.reduce((total, commit) => total + commit.actual, 0);
      entry["react"] = { commits: mine.length, commitsPerFrame: round(mine.length / Math.max(1, gaps.length), 2), actualMsTotal: round(actual), actualMsPerFrame: round(actual / Math.max(1, gaps.length), 2), baseMsPerCommit: round(mine.reduce((t, c) => t + c.base, 0) / Math.max(1, mine.length)), dom: stopMutations?.() };
    }
    if (pass === "trace") entry["trace"] = summarizeTrace(traced, gaps.length);
    if (pass === "cpu" && cpuProfile) addCpuProfile(cpuProfile, cpuOwn, cpuInclusive);
    steps.push(entry);
  };

  let lastCards = -1;
  let sameCount = 0;
  for (let step = 1; step <= 30 && sameCount < 2; step += 1) {
    const anchor = anchorPoint();
    await gesture(`zoom ${step}`, async () => {
      for (let tick = 0; tick < 3; tick += 1) {
        await wheel(anchor, -120);
        await nextFrame();
      }
    });
    const cards = (steps[steps.length - 1] as { cards: number }).cards;
    sameCount = cards === lastCards && cards <= 2 ? sameCount + 1 : 0;
    lastCards = cards;
  }
  await gesture("arraste no nível mais fundo", () => drag(anchorPoint(), 40));
  for (let tick = 0; tick < 25; tick += 1) {
    await wheel({ x: 720, y: 450 }, 140);
    await nextFrame();
  }
  await sleep(500);
  await gesture("arraste, afastado 25 ticks", () => drag(anchorPoint(), 40));
  for (let tick = 0; tick < 40; tick += 1) {
    await wheel({ x: 720, y: 450 }, 140);
    await nextFrame();
  }
  await sleep(500);
  await gesture("arraste, visão geral", () => drag(anchorPoint(), 40));
  await screen.unmount();
  document.querySelector("[data-measure-style]")?.remove();
  const top = (map: Map<string, number>, key: string) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45).map(([fn, ms]) => ({ fn, [key]: round(ms) }));
  const overall = (list: number[]) => { const sorted = [...list].sort((a, b) => a - b); return { frames: sorted.length, medianMs: round(pct(sorted, 0.5)), p95Ms: round(pct(sorted, 0.95)), worstMs: round(pct(sorted, 1)), over33ms: sorted.filter((gap) => gap > 33.4).length, over100ms: sorted.filter((gap) => gap > 100).length }; };
  return { zoomOverall: overall(gapsByKind.zoom), dragOverall: overall(gapsByKind.drag), steps, cpuTop: top(cpuOwn, "selfMs"), cpuInclusiveTop: top(cpuInclusive, "inclusiveMs") };
}

describe("onde vai o tempo de um quadro do mapa", () => {
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
      const result: Record<string, unknown> = { n, viewport: "1440×900", at: new Date().toISOString(), reactBuild: __MEASURE_REACT__, extraStyle: __MEASURE_STYLE__ };
      for (const pass of __MEASURE_PASSES__.split(",") as Pass[]) result[pass] = await runScenario(pass, project, projects, tickets, people);
      await commands.writeFile(`${__MEASURE_DIR__}map-frame${__MEASURE_LABEL__ === "" ? "" : `-${__MEASURE_LABEL__}`}-${n}.json`, JSON.stringify(result, null, 2));
      expect(Object.keys(result).length).toBeGreaterThan(4);
    });
  }
});

/**
 * Medição da web com projeto grande, só funções puras, em Node (TREEPM-191):
 *   pnpm --filter @treepm/web measure:big-project        (depois de `measure:big-project` da API, que grava os dados)
 * Mede, por N: o que o cliente faz com a resposta (JSON + validação), `buildMapItems` (e, por diferença, `paintBranches`, que
 * não é exportada), o layout e o índice da engine, `computeMapMaxScale` (que refaz o layout), `buildSpatialScene` em várias
 * escalas (a CPU de um quadro de zoom ou arraste, sem React nem DOM), a busca local da barra e o `mergeMapData` do refresh de 30 s.
 */
import { buildSpatialLayout, buildSpatialScene, buildTreeIndex } from "@treepm/engine";
import type { SpatialCamera } from "@treepm/engine";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { searchTickets } from "../command/search.js";
import { buildMapItems, paintBranches } from "../map/items.js";
import type { MapNode } from "../map/items.js";
import { mergeMapData } from "../map/mapData.js";
import type { MapData } from "../map/mapData.js";
import { computeMapMaxScale } from "../map/zoom.js";
import { makeMe } from "../test/fakes.js";
import { hasData, loadData, loadNow, machine, MEASURE_DIR, SIZES, stats } from "./bigProjectData.js";

const REPS = Number(process.env["MEASURE_REPS"] ?? 5);
interface Row { n: number; group: string; op: string; medianMs: number; worstMs: number; minMs: number; note?: string }

function time<T>(fn: () => T): { ms: number; value: T } {
  const started = performance.now();
  const value = fn();
  return { ms: performance.now() - started, value };
}

/** Aquecimento descartado + REPS repetições. */
function bench<T>(fn: () => T): { s: ReturnType<typeof stats>; value: T } {
  let value = fn();
  const times: number[] = [];
  for (let i = 0; i < REPS; i += 1) {
    const r = time(fn);
    times.push(r.ms);
    value = r.value;
  }
  return { s: stats(times), value };
}

describe("web com projeto grande, em Node", () => {
  for (const n of SIZES) {
    it.skipIf(!hasData(n))(`N = ${n}`, async () => {
      const rows: Row[] = [];
      const loadStart = loadNow();
      const push = (group: string, op: string, s: ReturnType<typeof stats>, note?: string) => {
        rows.push({ n, group, op, ...s, ...(note ? { note } : {}) });
        console.log(`  ${op.padEnd(58)} mediana ${String(s.medianMs).padStart(9)} ms  pior ${String(s.worstMs).padStart(9)} ms${note ? `  (${note})` : ""}`);
      };
      console.log(`\n=== web, N = ${n} (carga média: ${loadStart}) ===`);
      const data = await loadData(n);
      const me = makeMe();
      const ticketsByProject = { [data.projects[0]!.id]: data.tickets };
      const sizeMb = (data.ticketsBody.length / 2 ** 20).toFixed(1);

      // O que o cliente faz com a resposta da lista.
      push("cliente", `JSON.parse da lista (${sizeMb} MB)`, bench(() => JSON.parse(data.ticketsBody)).s);
      push("cliente", "listTickets completo (fetch falso + JSON + validação zod)", await (async () => {
        const times: number[] = [];
        for (let i = 0; i <= REPS; i += 1) {
          const started = performance.now();
          await loadData(n);
          if (i > 0) times.push(performance.now() - started);
        }
        return stats(times);
      })(), "inclui também as listas de projetos e pessoas");

      // Dados do mapa.
      const items = bench(() => buildMapItems(me.organization, data.projects, ticketsByProject));
      push("mapa", "buildMapItems (inclui paintBranches)", items.s);
      const noProgress = Object.fromEntries(Object.entries(ticketsByProject).map(([id, list]) => [id, list.map((t) => ({ ...t, progress: null }))]));
      const light = bench(() => buildMapItems(me.organization, data.projects, noProgress));
      push("mapa", "buildMapItems sem progresso (paintBranches quase vazia)", light.s);
      push("mapa", "paintBranches, por diferença", stats([Math.max(0, items.s.medianMs - light.s.medianMs)]), "mediana menos mediana");
      const byTicketId = new Map(data.tickets.map((ticket) => [ticket.id, ticket]));
      const unpainted = (light.value as readonly MapNode[]).map((node) => (node.ticket ? { ...node, ticket: byTicketId.get(node.id)! } : node));
      push("mapa", "paintBranches, direto", bench(() => paintBranches(unpainted)).s);
      const nodes = items.value as readonly MapNode[];

      // Engine.
      const index = bench(() => buildTreeIndex(nodes));
      push("engine", "buildTreeIndex", index.s);
      const layout = bench(() => buildSpatialLayout(index.value));
      push("engine", "buildSpatialLayout", layout.s);
      push("engine", "computeMapMaxScale (itens novos: monta índice + layout uma vez)", bench(() => computeMapMaxScale([...nodes])).s);
      push("engine", "computeMapMaxScale (mesmos itens: reaproveita)", bench(() => computeMapMaxScale(nodes)).s);
      const maxScale = computeMapMaxScale(nodes);
      const { bounds } = layout.value;
      const worldW = bounds.maxX - bounds.minX;
      const worldH = bounds.maxY - bounds.minY;
      const viewport = { width: 1440, height: 900 };
      const fit = Math.min(viewport.width / worldW, viewport.height / worldH);
      console.log(`  mundo ${Math.round(worldW)}×${Math.round(worldH)}, escala que cabe a tela: ${fit.toExponential(2)}, escala máxima: ${maxScale.toFixed(1)}`);

      // Uma cena por escala: a câmera olha para o centro de um ticket fundo (a folha do meio do layout) a cada nível de zoom.
      const target = layout.value.nodes.filter((entry) => entry.depth >= 5)[Math.floor(layout.value.nodes.filter((entry) => entry.depth >= 5).length / 2)] ?? layout.value.nodes[0]!;
      const cx = target.x + target.width / 2;
      const cy = target.y + target.height / 2;
      const scenes: { label: string; nodes: number; groups: number; regions: number }[] = [];
      // Sete níveis de zoom, em progressão geométrica da tela inteira ao zoom máximo (a escala máxima do mapa é astronômica,
      // porque o menor nó é minúsculo: só uma progressão geométrica passa por todas as profundidades).
      const levels = Array.from({ length: 7 }, (_, k) => ({ label: k === 0 ? "nível 0 (tela inteira)" : k === 6 ? "nível 6 (zoom máximo)" : `nível ${k}`, factor: (maxScale / fit) ** (k / 6) }));
      for (const { label, factor } of levels) {
        const scale = Math.min(fit * factor, maxScale);
        const camera: SpatialCamera = { x: viewport.width / 2 - cx * scale, y: viewport.height / 2 - cy * scale, scale };
        const scene = bench(() => buildSpatialScene(layout.value, index.value, { x: 0, y: 0, scale: camera.scale }, { ...viewport, x: -camera.x, y: -camera.y }));
        push("cena", `buildSpatialScene, ${label}`, scene.s, `${scene.value.nodes.length} nós, ${scene.value.groups.length} grupos, ${scene.value.regions.length} regiões`);
        scenes.push({ label, nodes: scene.value.nodes.length, groups: scene.value.groups.length, regions: scene.value.regions.length });
      }

      // Busca local da barra (sobre os tickets já carregados).
      const sample = data.tickets[Math.floor(data.tickets.length / 2)]!;
      for (const [label, text] of [["chave (BG-123)", "BG-123"], ["só o número (4711)", "4711"], ["uma palavra comum (relatórios)", "relatórios"], ["três palavras", "implementar fila de notificações"], ["sem resultado", "zzzxqj"], ["título de um ticket", sample.title]] as const) {
        push("busca", `searchTickets, ${label}`, bench(() => searchTickets(text, ticketsByProject)).s);
      }

      // Refresh de 30 s: a metade do cliente (a comparação por JSON.stringify).
      const current: MapData = { projects: data.projects, people: data.people, ticketsByProject };
      const same: MapData = { projects: structuredClone(data.projects), people: structuredClone(data.people), ticketsByProject: { [data.projects[0]!.id]: structuredClone(data.tickets) } };
      push("refresh", "mergeMapData, nada mudou (cópia profunda, como uma resposta nova)", bench(() => mergeMapData(current, same)).s);
      const changed: MapData = { ...same, ticketsByProject: { [data.projects[0]!.id]: same.ticketsByProject[data.projects[0]!.id]!.map((t, i) => (i === 7 ? { ...t, title: `${t.title}!` } : t)) } };
      push("refresh", "mergeMapData, um título mudou", bench(() => mergeMapData(current, changed)).s);

      const loadEnd = loadNow();
      console.log(`  carga média no fim: ${loadEnd}`);
      mkdirSync(MEASURE_DIR, { recursive: true });
      writeFileSync(`${MEASURE_DIR}web-node-${n}.json`, JSON.stringify({ n, machine: machine(), loadAvgStart: loadStart, loadAvgEnd: loadEnd, nodes: nodes.length, world: { width: Math.round(worldW), height: Math.round(worldH), fit, maxScale }, scenes, rows }, null, 2));
    });
  }
});

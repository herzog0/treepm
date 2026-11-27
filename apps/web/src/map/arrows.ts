import type { SpatialIndicatorGroup, SpatialSceneNode } from "@treepm/engine";
import type { DependencyNeed } from "../api/client.js";

/** O que a conta das setas lê de cada nó da cena: a caixa apresentada (`x` é o centro, `y` o topo, em coordenadas da cena). */
export type ArrowSceneNode = Pick<SpatialSceneNode, "id" | "x" | "y" | "width" | "height" | "opacity" | "aggregate" | "representation">;
export type ArrowSceneGroup = Pick<SpatialIndicatorGroup, "childIds" | "x" | "y" | "width" | "height" | "scale" | "opacity">;

/** Uma dependência do ticket selecionado: a outra ponta, o tipo, e se ela já terminou (concluída ou cancelada). */
export interface ArrowLink {
  readonly id: string;
  readonly need: DependencyNeed;
  readonly finished: boolean;
}

export interface ArrowInput {
  readonly selectedId: string;
  /** Os tickets de que o selecionado depende: a seta sai deles e chega nele. */
  readonly waitsFor: readonly ArrowLink[];
  /** Os tickets que dependem do selecionado: a seta sai dele e chega neles. */
  readonly unlocks: readonly ArrowLink[];
  readonly parentOf: (id: string) => string | null;
  readonly scene: { readonly nodes: readonly ArrowSceneNode[]; readonly groups: readonly ArrowSceneGroup[] };
  /** O centro do ticket no layout, em coordenadas da cena, para a direção de quem está fora da tela; `null` se não há. */
  readonly layoutPoint: (id: string) => Point | null;
  readonly camera: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Uma seta no palco: sai de (x1, y1) e chega em (x2, y2). `waits`: o que o selecionado espera; `unlocks`: o que ele libera. */
export interface Arrow {
  readonly key: string;
  readonly kind: "waits" | "unlocks";
  readonly need: DependencyNeed;
  readonly finished: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

interface Box {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
/** Onde uma ponta está: numa caixa visível, ou num ponto fora da tela (só a direção conta). */
type End = { readonly box: Box } | { readonly point: Point };

/** Distância da borda do palco onde a seta de quem está fora da tela termina. */
const EDGE_INSET = 12;

const centerOf = (box: Box): Point => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
const pointOf = (end: End): Point => ("box" in end ? centerOf(end.box) : end.point);

/** Onde o segmento que sai do centro de `box` rumo a `toward` cruza a borda da caixa. */
function exitPoint(box: Box, toward: Point): Point {
  const from = centerOf(box);
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const halfWidth = (box.right - box.left) / 2;
  const halfHeight = (box.bottom - box.top) / 2;
  const tx = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const ty = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const t = Math.min(tx, ty, 1);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** Corta o segmento ao retângulo (Liang–Barsky); `null` quando ele passa inteiro por fora. */
function clip(a: Point, b: Point, rect: { left: number; top: number; right: number; bottom: number }): [Point, Point] | null {
  let enter = 0;
  let leave = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sides: [number, number][] = [
    [-dx, a.x - rect.left],
    [dx, rect.right - a.x],
    [-dy, a.y - rect.top],
    [dy, rect.bottom - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) enter = Math.max(enter, r);
    else leave = Math.min(leave, r);
    if (enter > leave) return null;
  }
  return [
    { x: a.x + dx * enter, y: a.y + dy * enter },
    { x: a.x + dx * leave, y: a.y + dy * leave },
  ];
}

/**
 * As setas do ticket selecionado (ADR 0069, seção 5), em coordenadas do palco. Cada ponta vai ao card onde ele está; se o ticket está
 * dentro de um pai fechado ou de um grupo, ao que está visível (o pai, o quadradinho do grupo); se está fora da tela, até a borda do
 * palco, na direção dele. Um pai aberto que aparece na tela não serve de ponta: se o ticket dentro dele não aparece, ele está fora da
 * tela. Nada é desenhado quando as duas pontas caem no mesmo lugar ou o segmento passa inteiro fora da tela.
 */
export function selectionArrows(input: ArrowInput): Arrow[] {
  const { camera } = input;
  const nodes = new Map(input.scene.nodes.map((node) => [node.id, node] as const));
  const groups = new Map<string, ArrowSceneGroup>();
  for (const group of input.scene.groups) for (const id of group.childIds) groups.set(id, group);
  const nodeBox = (node: ArrowSceneNode): Box => ({
    key: `node:${node.id}`,
    left: node.x - node.width / 2 + camera.x,
    top: node.y + camera.y,
    right: node.x + node.width / 2 + camera.x,
    bottom: node.y + node.height + camera.y,
  });
  const groupBox = (group: ArrowSceneGroup): Box => {
    const width = group.width * group.scale;
    const height = group.height * group.scale;
    return { key: `group:${group.childIds.join(",")}`, left: group.x - width / 2 + camera.x, top: group.y + camera.y, right: group.x + width / 2 + camera.x, bottom: group.y + height + camera.y };
  };
  const resolve = (id: string): End | null => {
    const seen = new Set<string>();
    for (let at: string | null = id; at !== null && !seen.has(at); at = input.parentOf(at)) {
      seen.add(at);
      const node = nodes.get(at);
      if (node !== undefined && node.opacity > 0) {
        if (at === id || node.aggregate || node.representation === "indicator") return { box: nodeBox(node) };
        break; // um ancestral aberto na tela: o ticket está fora da tela, dentro dele
      }
      const group = groups.get(at);
      if (group !== undefined && group.opacity > 0) return { box: groupBox(group) };
    }
    const point = input.layoutPoint(id);
    return point === null ? null : { point: { x: point.x + camera.x, y: point.y + camera.y } };
  };
  const stage = { left: EDGE_INSET, top: EDGE_INSET, right: input.viewport.width - EDGE_INSET, bottom: input.viewport.height - EDGE_INSET };
  const draw = (from: End, to: End): [Point, Point] | null => {
    if ("box" in from && "box" in to && from.box.key === to.box.key) return null;
    const start = "box" in from ? exitPoint(from.box, pointOf(to)) : from.point;
    const end = "box" in to ? exitPoint(to.box, pointOf(from)) : to.point;
    if ("box" in from && "box" in to) return [start, end];
    return clip(start, end, stage);
  };

  const selected = resolve(input.selectedId);
  if (selected === null) return [];
  const arrows: Arrow[] = [];
  const add = (kind: Arrow["kind"], link: ArrowLink) => {
    const other = resolve(link.id);
    if (other === null) return;
    const segment = kind === "waits" ? draw(other, selected) : draw(selected, other);
    if (segment === null) return;
    const [a, b] = segment;
    arrows.push({ key: `${kind}:${link.id}`, kind, need: link.need, finished: link.finished, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  };
  for (const link of input.waitsFor) add("waits", link);
  for (const link of input.unlocks) add("unlocks", link);
  return arrows;
}

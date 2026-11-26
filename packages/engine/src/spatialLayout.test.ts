import { describe, expect, it } from "vitest";
import { buildSpatialLayout, TARGET_CHILD_REGION_ASPECT } from "./spatialLayout.js";
import type { SpatialBounds, SpatialLayout, SpatialLayoutNode } from "./spatialLayout.js";
import { buildTreeIndex } from "./spatialIndex.js";

interface Item { readonly id: string; readonly parentId: string | null }

const layoutOf = (items: readonly Item[]) => buildSpatialLayout(buildTreeIndex(items));
const childrenOf = (layout: SpatialLayout<Item>, id: string) => layout.nodes.filter((node) => node.item.parentId === id && node.item.id !== id);
const boxOf = (node: SpatialLayoutNode<Item>): SpatialBounds => node.subtreeBounds;
const regionOf = (boxes: readonly SpatialBounds[]): SpatialBounds => ({
  minX: Math.min(...boxes.map((box) => box.minX)),
  maxX: Math.max(...boxes.map((box) => box.maxX)),
  minY: Math.min(...boxes.map((box) => box.minY)),
  maxY: Math.max(...boxes.map((box) => box.maxY)),
});
const widthOf = (box: SpatialBounds) => box.maxX - box.minX;
const heightOf = (box: SpatialBounds) => box.maxY - box.minY;
const EPS = 1e-6;
const overlaps = (a: SpatialBounds, b: SpatialBounds) => a.minX < b.maxX - EPS && b.minX < a.maxX - EPS && a.minY < b.maxY - EPS && b.minY < a.maxY - EPS;

function leaves(count: number): Item[] {
  return [{ id: "p", parentId: null }, ...Array.from({ length: count }, (_, index) => ({ id: `c${index}`, parentId: "p" }))];
}

/** Linhas de filhos, agrupadas pelo topo da caixa de cada um (os filhos de uma linha se alinham pelo topo). */
function rowsOf(children: readonly SpatialLayoutNode<Item>[]) {
  const rows: SpatialLayoutNode<Item>[][] = [];
  for (const child of children) {
    const row = rows.find((entry) => Math.abs(entry[0]!.slotBounds.minY - child.slotBounds.minY) < EPS);
    if (row) row.push(child);
    else rows.push([child]);
  }
  return rows;
}

function randomTree(seed: number, maxDepth: number): Item[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const items: Item[] = [];
  let next = 0;
  const grow = (parentId: string | null, depth: number) => {
    const id = `n${next}`;
    next += 1;
    items.push({ id, parentId });
    if (depth >= maxDepth) return;
    const count = random() < 0.35 ? 0 : Math.floor(random() * (depth === 0 ? 10 : 7));
    for (let child = 0; child < count; child += 1) grow(id, depth + 1);
  };
  const roots = 1 + Math.floor(random() * 3);
  for (let root = 0; root < roots; root += 1) grow(null, 0);
  return items;
}

describe("layout dos filhos: áreas ajustadas e árvore mais larga (ADR 0067)", () => {
  it("expõe a proporção alvo como constante única, começando em 3", () => {
    expect(TARGET_CHILD_REGION_ASPECT).toBe(3);
  });

  it("um irmão com subárvore alta não aumenta a altura da linha dos outros", () => {
    const items: Item[] = [{ id: "p", parentId: null }];
    for (let child = 0; child < 8; child += 1) items.push({ id: `c${child}`, parentId: "p" });
    for (let grand = 0; grand < 12; grand += 1) items.push({ id: `g${grand}`, parentId: "c3" });
    const layout = layoutOf(items);
    const children = childrenOf(layout, "p");
    const region = regionOf(children.map(boxOf));
    const parent = layout.nodeById.get("p")!;
    const gap = region.minY - (parent.y + parent.height);
    // O algoritmo antigo: ceil(√8) = 3 colunas, 3 linhas, toda casa com a altura do irmão mais alto.
    const tallest = Math.max(...children.map((child) => heightOf(boxOf(child))));
    const oldHeight = 3 * tallest + 2 * gap;
    expect(heightOf(region)).toBeLessThan(oldHeight * 0.6);
    // Cada linha tem a altura do filho mais alto dela: as linhas sem o irmão alto têm a altura de um card.
    for (const row of rowsOf(children)) {
      const rowHeight = heightOf(row[0]!.slotBounds);
      expect(rowHeight).toBeCloseTo(Math.max(...row.map((child) => heightOf(boxOf(child)))), 6);
      for (const child of row) expect(widthOf(child.slotBounds)).toBeCloseTo(widthOf(boxOf(child)), 6);
    }
  });

  it.each([2, 3])("%i filhos folha ficam numa linha só", (count) => {
    const layout = layoutOf(leaves(count));
    expect(rowsOf(childrenOf(layout, "p"))).toHaveLength(1);
  });

  it("12 filhos folha ficam com mais colunas do que linhas", () => {
    const rows = rowsOf(childrenOf(layoutOf(leaves(12)), "p"));
    expect(Math.max(...rows.map((row) => row.length))).toBeGreaterThan(rows.length);
  });

  it.each([2, 3, 4, 5, 6, 8, 12, 20, 50, 200])("a região de %i filhos folha é mais larga do que alta", (count) => {
    const region = regionOf(childrenOf(layoutOf(leaves(count)), "p").map(boxOf));
    expect(widthOf(region)).toBeGreaterThan(heightOf(region));
  });

  it.each([5, 6, 7, 10, 12, 13, 26])("%i filhos folha: linhas equilibradas, sem linha órfã (no máximo um filho de diferença)", (count) => {
    const rows = rowsOf(childrenOf(layoutOf(leaves(count)), "p"));
    const sizes = rows.map((row) => row.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("busca exata: acha a melhor quebra mesmo quando ela vem depois de uma pior e mais alta", () => {
    // Seis filhos de largura 12, dois deles altos no meio: 2 linhas é pior do que 1, e 3 linhas é melhor do que as duas.
    const heights: Record<string, number> = { p: 1, c0: 1, c1: 1, c2: 10, c3: 10, c4: 1, c5: 1 };
    const layout = buildSpatialLayout(buildTreeIndex(leaves(6)), {
      dimensions: (node) => ({ width: 12, height: heights[node.id]! }),
      childGap: 0,
      normalization: false,
    });
    expect(rowsOf(childrenOf(layout as SpatialLayout<Item>, "p"))).toHaveLength(3);
  });

  it("preserva a ordem: da esquerda para a direita e de cima para baixo", () => {
    const children = childrenOf(layoutOf(leaves(17)), "p");
    const rows = rowsOf(children);
    const reading = rows
      .sort((a, b) => a[0]!.slotBounds.minY - b[0]!.slotBounds.minY)
      .flatMap((row) => [...row].sort((a, b) => a.x - b.x))
      .map((node) => node.item.id);
    expect(reading).toEqual(children.map((node) => node.item.id));
  });

  it("linhas centralizadas sob o pai e filhos alinhados pelo topo da linha", () => {
    const items: Item[] = [...leaves(7), { id: "g0", parentId: "c1" }, { id: "g1", parentId: "c1" }, { id: "g2", parentId: "c1" }];
    const layout = layoutOf(items);
    const parent = layout.nodeById.get("p")!;
    for (const row of rowsOf(childrenOf(layout, "p"))) {
      const left = Math.min(...row.map((child) => child.slotBounds.minX));
      const right = Math.max(...row.map((child) => child.slotBounds.maxX));
      expect((left + right) / 2).toBeCloseTo(parent.x, 6);
      for (const child of row) expect(boxOf(child).minY).toBeCloseTo(row[0]!.slotBounds.minY, 6);
    }
  });

  it("propriedade: árvores aleatórias sem sobreposição, pai centralizado e caixas coerentes", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const items = randomTree(seed, 1 + (seed % 5));
      const layout = layoutOf(items);
      expect(layout.nodes).toHaveLength(items.length);
      for (const parent of layout.nodes) {
        const children = layout.nodes.filter((node) => node.item.parentId === parent.item.id);
        const card = { minX: parent.x - parent.width / 2, maxX: parent.x + parent.width / 2, minY: parent.y, maxY: parent.y + parent.height };
        for (let a = 0; a < children.length; a += 1) {
          expect(overlaps(boxOf(children[a]!), card), `semente ${seed}: filho cruza o card do pai`).toBe(false);
          for (let b = a + 1; b < children.length; b += 1) {
            expect(overlaps(boxOf(children[a]!), boxOf(children[b]!)), `semente ${seed}: irmãos se cruzam`).toBe(false);
            expect(overlaps(children[a]!.slotBounds, children[b]!.slotBounds), `semente ${seed}: casas se cruzam`).toBe(false);
          }
          // A caixa do filho cabe na casa dele.
          const slot = children[a]!.slotBounds;
          const box = boxOf(children[a]!);
          expect(box.minX).toBeGreaterThanOrEqual(slot.minX - EPS);
          expect(box.maxX).toBeLessThanOrEqual(slot.maxX + EPS);
          expect(box.minY).toBeGreaterThanOrEqual(slot.minY - EPS);
          expect(box.maxY).toBeLessThanOrEqual(slot.maxY + EPS);
        }
        if (children.length) {
          const region = regionOf(children.map((child) => child.slotBounds));
          expect((region.minX + region.maxX) / 2, `semente ${seed}: pai fora do centro`).toBeCloseTo(parent.x, 6);
        }
        // A caixa da subárvore contém o próprio card e todos os descendentes.
        const descendants = [...children];
        for (let cursor = 0; cursor < descendants.length; cursor += 1) {
          descendants.push(...layout.nodes.filter((node) => node.item.parentId === descendants[cursor]!.item.id));
        }
        const box = parent.subtreeBounds;
        for (const node of [parent, ...descendants]) {
          expect(node.x - node.width / 2).toBeGreaterThanOrEqual(box.minX - EPS);
          expect(node.x + node.width / 2).toBeLessThanOrEqual(box.maxX + EPS);
          expect(node.y).toBeGreaterThanOrEqual(box.minY - EPS);
          expect(node.y + node.height).toBeLessThanOrEqual(box.maxY + EPS);
        }
      }
      const all = regionOf(layout.nodes.map((node) => ({ minX: node.x - node.width / 2, maxX: node.x + node.width / 2, minY: node.y, maxY: node.y + node.height })));
      expect(layout.bounds.minX).toBeCloseTo(all.minX, 6);
      expect(layout.bounds.maxX).toBeCloseTo(all.maxX, 6);
      expect(layout.bounds.minY).toBeCloseTo(all.minY, 6);
      expect(layout.bounds.maxY).toBeCloseTo(all.maxY, 6);
    }
  });

  it("é determinístico: a mesma entrada dá a mesma saída", () => {
    const items = randomTree(42, 5);
    const first = layoutOf(items);
    const second = layoutOf(items);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.bounds).toEqual(first.bounds);
  });

  it("nó sem filhos: a caixa e a casa são o próprio card", () => {
    const layout = layoutOf([{ id: "a", parentId: null }]);
    const node = layout.nodeById.get("a")!;
    expect(node.subtreeBounds).toEqual({ minX: node.x - node.width / 2, maxX: node.x + node.width / 2, minY: 0, maxY: node.height });
    expect(node.subtreeRadius).toBeCloseTo(Math.hypot(node.width / 2, node.height / 2), 6);
  });

  it("ciclo: o nó repetido vira folha e o layout termina", () => {
    const index = buildTreeIndex<Item>([{ id: "a", parentId: null }, { id: "b", parentId: "a" }]);
    // Ciclo forçado no índice: b passa a ser filho de si mesmo e pai de a.
    (index.childrenByParentId as Map<string | null, Item[]>).set("b", [{ id: "a", parentId: "b" }]);
    const layout = buildSpatialLayout(index);
    expect(layout.nodes.length).toBeGreaterThanOrEqual(2);
    for (const node of layout.nodes) expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
  });

  it("a proporção alvo pode ser trocada nas opções", () => {
    const tall = buildSpatialLayout(buildTreeIndex(leaves(12)), { childRegionAspect: 0.5 });
    const rows = rowsOf(childrenOf(tall as SpatialLayout<Item>, "p"));
    expect(Math.max(...rows.map((row) => row.length))).toBeLessThan(rows.length);
    expect(() => buildSpatialLayout(buildTreeIndex(leaves(2)), { childRegionAspect: 0 })).toThrow(RangeError);
  });
});

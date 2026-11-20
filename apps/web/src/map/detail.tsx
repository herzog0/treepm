import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Person, TicketStatus } from "../api/client.js";
import type { MapNode } from "./items.js";

/** Largura na tela, em px, a partir da qual o card passa ao nível "detalhe" (ADR 0027; o quadro aprovado usa 300). */
export const DETAIL_MIN_WIDTH = 300;

interface WidthSource {
  readonly nodeById: ReadonlyMap<string, { readonly width: number }>;
}

export interface MapScaleStore {
  /** Guarda escala e largura dos nós sem avisar ninguém; seguro durante o render, para que nós recém-montados já leiam o valor novo. */
  set(scale: number, layout: WidthSource): void;
  /** Avisa os assinantes; cada um só redesenha se o seu próprio "é detalhe?" mudou. */
  notify(): void;
  update(scale: number, layout: WidthSource): void;
  subscribe(listener: () => void): () => void;
  isDetail(id: string): boolean;
}

/**
 * Fonte externa da escala da câmera. O pacote só entrega os quatro níveis ao conteúdo do nó e o memoiza, então
 * a web decide o quinto por conta própria: largura do nó no layout × escala ≥ 300. Cada card assina só o booleano
 * dele, de modo que zoom e pan dentro do mesmo nível não redesenham nada.
 */
export function createMapScaleStore(): MapScaleStore {
  let scale = 0;
  let layout: WidthSource | null = null;
  const listeners = new Set<() => void>();
  const store: MapScaleStore = {
    set(nextScale, nextLayout) {
      scale = nextScale;
      layout = nextLayout;
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
    update(nextScale, nextLayout) {
      store.set(nextScale, nextLayout);
      store.notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    isDetail(id) {
      const width = layout?.nodeById.get(id)?.width;
      return width !== undefined && width * scale >= DETAIL_MIN_WIDTH;
    },
  };
  return store;
}

export type LeafStatusCounts = Readonly<Partial<Record<Exclude<TicketStatus, "done" | "cancelled">, number>>>;

export interface MapDetailData {
  readonly people: ReadonlyMap<string, Person>;
  /** Folhas por situação sob cada agrupador (sem as concluídas e as canceladas, que o progresso já conta). */
  readonly leaves: ReadonlyMap<string, LeafStatusCounts>;
}

export function buildDetailData(items: readonly MapNode[], people: readonly Person[]): MapDetailData {
  const childrenOf = new Map<string, MapNode[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = childrenOf.get(item.parentId);
    if (siblings) siblings.push(item);
    else childrenOf.set(item.parentId, [item]);
  }
  // Folhas são os tickets sob o agrupador; agrupador (vazio ou não) nunca conta como folha.
  const leavesUnder = (node: MapNode): MapNode[] =>
    node.ticket?.kind === "group" ? (childrenOf.get(node.id) ?? []).flatMap(leavesUnder) : [node];
  const leaves = new Map<string, LeafStatusCounts>();
  for (const item of items) {
    if (item.ticket?.kind !== "group") continue;
    const counts: Partial<Record<"todo" | "in_progress" | "in_review", number>> = {};
    for (const leaf of leavesUnder(item)) {
      const status = leaf.ticket?.status;
      if (status === "todo" || status === "in_progress" || status === "in_review") counts[status] = (counts[status] ?? 0) + 1;
    }
    leaves.set(item.id, counts);
  }
  return { people: new Map(people.map((person) => [person.id, person])), leaves };
}

interface MapDetailContextValue {
  readonly store: MapScaleStore;
  readonly data: MapDetailData;
}
// Sem provedor (demo, testes de conteúdo): escala zero, nenhum card chega ao detalhe.
const MapDetailContext = createContext<MapDetailContextValue>({
  store: createMapScaleStore(),
  data: { people: new Map(), leaves: new Map() },
});

export function MapDetailProvider({ store, data, children }: { store: MapScaleStore; data: MapDetailData; children: ReactNode }) {
  // Valor estável: o mapa redesenha a cada quadro da câmera e isso não pode acordar o conteúdo dos cards.
  const value = useMemo(() => ({ store, data }), [store, data]);
  return <MapDetailContext.Provider value={value}>{children}</MapDetailContext.Provider>;
}

export const useMapDetailData = () => useContext(MapDetailContext).data;

/** Verdadeiro quando o nó está em "detalhe". Só redesenha o componente quando o valor muda. */
export function useIsDetail(id: string): boolean {
  const { store } = useContext(MapDetailContext);
  return useSyncExternalStore(store.subscribe, () => store.isDetail(id), () => false);
}

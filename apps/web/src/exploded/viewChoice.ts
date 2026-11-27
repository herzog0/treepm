import { useCallback, useEffect, useState } from "react";

/** As duas visões de um projeto (ADR 0070): o mapa (a inicial) e a árvore explodida. */
export type MapLayout = "map" | "tree";

/** Onde o navegador lembra a última escolha. */
export const LAYOUT_STORAGE_KEY = "treepm.mapLayout";
const PARAM = "layout";

const asLayout = (value: string | null): MapLayout | null => (value === "tree" || value === "map" ? value : null);

/** A visão a mostrar: a do endereço; sem ela, a última escolha da pessoa; sem nada, o mapa. */
export function readLayout(search: string, remembered: string | null): MapLayout {
  return asLayout(new URLSearchParams(search).get(PARAM)) ?? asLayout(remembered) ?? "map";
}

/** O endereço com a visão; o mapa, a visão inicial, dispensa o parâmetro. Os outros parâmetros e o hash ficam. */
export function layoutHref(layout: MapLayout, href: string = window.location.href): string {
  const url = new URL(href);
  if (layout === "map") url.searchParams.delete(PARAM);
  else url.searchParams.set(PARAM, layout);
  return `${url.pathname}${url.search}${url.hash}`;
}

function remembered(): string | null {
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `[visão, trocar]`: trocar grava no endereço (uma entrada no histórico) e no navegador; voltar no histórico volta a visão. */
export function useMapLayout(): [MapLayout, (layout: MapLayout) => void] {
  const [layout, setLayout] = useState<MapLayout>(() => readLayout(window.location.search, remembered()));
  useEffect(() => {
    const onPopState = () => setLayout(readLayout(window.location.search, remembered()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const choose = useCallback((next: MapLayout) => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // Sem armazenamento (janela privada, bloqueio): a escolha vale só no endereço.
    }
    const href = layoutHref(next);
    if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.pushState(window.history.state, "", href);
    setLayout(next);
  }, []);
  return [layout, choose];
}

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { viewHref } from "../nav/navigation.js";
import { LAYOUT_STORAGE_KEY, layoutHref, readLayout, useMapLayout } from "./viewChoice.js";

// ADR 0070, seção 1: o mapa é a visão inicial; o endereço guarda a visão e o navegador lembra a última escolha.
afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("readLayout", () => {
  it("o endereço vence; sem ele, a última escolha; sem nada, o mapa", () => {
    expect(readLayout("?layout=tree", null)).toBe("tree");
    expect(readLayout("?layout=map", "tree")).toBe("map");
    expect(readLayout("", "tree")).toBe("tree");
    expect(readLayout("", null)).toBe("map");
    expect(readLayout("?layout=outra", "nada")).toBe("map");
  });
});

describe("layoutHref", () => {
  it("guarda a visão no endereço sem perder o ticket aberto; o mapa não precisa do parâmetro", () => {
    expect(layoutHref("tree", "https://x.test/?ticket=t1#a")).toBe("/?ticket=t1&layout=tree#a");
    expect(layoutHref("map", "https://x.test/?ticket=t1&layout=tree")).toBe("/?ticket=t1");
  });

  it("sair do mapa para outra seção não leva a visão junto", () => {
    expect(viewHref("ideas", "https://x.test/?layout=tree")).toBe("/?view=ideas");
  });
});

describe("useMapLayout", () => {
  it("trocar grava no endereço (com histórico) e no navegador; voltar no histórico volta a visão", () => {
    const { result } = renderHook(() => useMapLayout());
    expect(result.current[0]).toBe("map");
    act(() => result.current[1]("tree"));
    expect(result.current[0]).toBe("tree");
    expect(window.location.search).toBe("?layout=tree");
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe("tree");
    act(() => {
      window.history.pushState(null, "", "/?layout=map");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("map");
  });

  it("começa na última escolha quando o endereço não diz", () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, "tree");
    const { result } = renderHook(() => useMapLayout());
    expect(result.current[0]).toBe("tree");
  });
});

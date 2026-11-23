import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentWorkClock } from "./agentWork.js";

afterEach(() => vi.useRealTimers());

describe("useAgentWorkClock (TREEPM-247)", () => {
  it("não relê os prazos a cada render: só quando a lista muda ou o relógio avança", () => {
    vi.useFakeTimers({ now: new Date("2026-11-22T12:00:00Z") });
    const untils = Array.from({ length: 500 }, (_, at) => new Date(Date.parse("2026-11-22T12:00:00Z") + (at + 1) * 60_000).toISOString());
    const parse = vi.spyOn(Date, "parse");
    const { rerender, result } = renderHook(({ list }) => useAgentWorkClock(list), { initialProps: { list: untils } });
    const first = parse.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(untils.length);
    // Quadros da câmera: o mapa renderiza de novo com a mesma lista.
    for (let frame = 0; frame < 20; frame += 1) rerender({ list: untils });
    expect(parse.mock.calls.length).toBe(first);
    // Uma lista nova é relida; o prazo mais próximo vencendo move o relógio (mesmo resultado de antes).
    rerender({ list: [...untils] });
    expect(parse.mock.calls.length).toBeGreaterThan(first);
    const start = result.current;
    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current).toBeGreaterThan(start);
  });
});

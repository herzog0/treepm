import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePlace, placeTarget, useRestoreCameraPlace } from "./cameraPlace.js";

describe("capturePlace / placeTarget", () => {
  it("stores the world point at the middle of the stage, the scale and the visible area", () => {
    expect(capturePlace({ x: -200, y: -100, scale: 2 }, { width: 1000, height: 600 })).toEqual({ x: 350, y: 200, scale: 2, width: 500, height: 300 });
  });

  it("restores through bounds centred on that point, asking for the stored scale", () => {
    const place = capturePlace({ x: -200, y: -100, scale: 2 }, { width: 1000, height: 600 });
    expect(placeTarget(place)).toEqual({ bounds: { minX: 100, maxX: 600, minY: 50, maxY: 350 }, requiredScale: 2 });
  });
});

const camera = (x: number, scale = 1) => ({ camera: { x, y: 0, scale }, size: { width: 1000, height: 600 } });

describe("useRestoreCameraPlace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const frames = () => act(() => void vi.advanceTimersByTime(100));
  function setup(initial: { pageOpen: boolean; mode?: "restore" | "stay" }) {
    const getView = vi.fn(() => camera(-100, 3));
    const restore = vi.fn();
    const hook = renderHook((props: { pageOpen: boolean; mode: "restore" | "stay" }) => useRestoreCameraPlace({ ...props, getView, restore }), {
      initialProps: { pageOpen: initial.pageOpen, mode: initial.mode ?? "restore" },
    });
    return { getView, restore, set: (props: Partial<{ pageOpen: boolean; mode: "restore" | "stay" }>) => hook.rerender({ pageOpen: initial.pageOpen, mode: "restore", ...props }) };
  }

  it("captures once when the page goes from closed to open and restores after the stage is back, two frames later", () => {
    const { getView, restore, set } = setup({ pageOpen: false });
    set({ pageOpen: true });
    expect(getView).toHaveBeenCalledTimes(1);
    set({ pageOpen: false });
    expect(restore).not.toHaveBeenCalled();
    frames();
    expect(restore).toHaveBeenCalledTimes(1);
    const target = restore.mock.calls[0]![0];
    expect(target.requiredScale).toBe(3);
    expect(target.bounds.minX).toBeCloseTo(100 / 3);
    expect(target.bounds.maxX).toBeCloseTo(1100 / 3);
    expect(target.bounds.minY).toBeCloseTo(0);
    expect(target.bounds.maxY).toBeCloseTo(200);
  });

  it("does not capture again when the page stays open (another ticket)", () => {
    const { getView, set } = setup({ pageOpen: false });
    set({ pageOpen: true });
    set({ pageOpen: true });
    set({ pageOpen: true });
    expect(getView).toHaveBeenCalledTimes(1);
  });

  it("does not restore with the 'stay' preference", () => {
    const { restore, set } = setup({ pageOpen: false, mode: "stay" });
    set({ pageOpen: true, mode: "stay" });
    set({ pageOpen: false, mode: "stay" });
    frames();
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not restore a page that was already open when the map appeared (opened by the address)", () => {
    const { restore, set } = setup({ pageOpen: true });
    set({ pageOpen: false });
    frames();
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores only once per opening", () => {
    const { restore, set } = setup({ pageOpen: false });
    set({ pageOpen: true });
    set({ pageOpen: false });
    frames();
    set({ pageOpen: false });
    frames();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending restore when the page reopens first", () => {
    const { restore, set } = setup({ pageOpen: false });
    set({ pageOpen: true });
    set({ pageOpen: false });
    set({ pageOpen: true });
    frames();
    expect(restore).not.toHaveBeenCalled();
  });
});

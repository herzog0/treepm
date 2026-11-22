import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reveal, REVEAL_MAX_MS, REVEAL_STEP_MS } from "./Reveal.js";

const words = (count: number) => Array.from({ length: count }, (_, index) => `p${index + 1}`).join(" ");

function show(text: string, onDone: () => void = () => undefined, active = true) {
  return render(
    <Reveal text={text} active={active} onDone={onDone}>
      {(shown, revealing) => <p data-testid="out" aria-hidden={revealing ? true : undefined}>{shown}</p>}
    </Reveal>,
  );
}
const out = () => screen.getByTestId("out");
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const reducedMotion = (reduce: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("prefers-reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null }));

describe("Reveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts empty and reveals one word per step", () => {
    show("um dois três quatro");
    expect(out()).toHaveTextContent("");
    advance(REVEAL_STEP_MS);
    expect(out().textContent).toBe("um ");
    advance(REVEAL_STEP_MS);
    expect(out().textContent).toBe("um dois ");
  });

  it("runs with a step between 20 and 40 ms", () => {
    expect(REVEAL_STEP_MS).toBeGreaterThanOrEqual(20);
    expect(REVEAL_STEP_MS).toBeLessThanOrEqual(40);
  });

  it("shows the whole text at the end, calls onDone once and stops hiding it from the screen reader", () => {
    const onDone = vi.fn();
    show("um dois três", onDone);
    expect(out()).toHaveAttribute("aria-hidden", "true");
    advance(REVEAL_STEP_MS * 10);
    expect(out().textContent).toBe("um dois três");
    expect(out()).not.toHaveAttribute("aria-hidden");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("never takes longer than 1.5 s, however long the text", () => {
    const onDone = vi.fn();
    show(words(400), onDone);
    advance(REVEAL_MAX_MS - REVEAL_STEP_MS);
    expect(onDone).not.toHaveBeenCalled();
    advance(REVEAL_STEP_MS);
    expect(out().textContent).toBe(words(400));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps the line breaks and the spaces of the text", () => {
    show("linha um\n\nlinha dois");
    advance(REVEAL_STEP_MS * 10);
    expect(out().textContent).toBe("linha um\n\nlinha dois");
  });

  it("shows the rest at once on a key press", () => {
    const onDone = vi.fn();
    show(words(40), onDone);
    advance(REVEAL_STEP_MS * 2);
    expect(out().textContent).not.toBe(words(40));
    fireEvent.keyDown(document.body, { key: "a" });
    expect(out().textContent).toBe(words(40));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("shows the rest at once on a click", () => {
    show(words(40));
    advance(REVEAL_STEP_MS);
    fireEvent.pointerDown(document.body);
    expect(out().textContent).toBe(words(40));
  });

  it("with reduced motion the text appears whole, with no waiting", () => {
    reducedMotion(true);
    const onDone = vi.fn();
    show(words(40), onDone);
    expect(out().textContent).toBe(words(40));
    expect(out()).not.toHaveAttribute("aria-hidden");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("inactive, it shows the whole text and never calls onDone", () => {
    const onDone = vi.fn();
    show(words(40), onDone, false);
    expect(out().textContent).toBe(words(40));
    advance(REVEAL_MAX_MS * 2);
    expect(onDone).not.toHaveBeenCalled();
  });
});

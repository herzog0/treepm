import { describe, expect, it } from "vitest";
import { TICKET_FOCUS_WIDTH, ticketFocus } from "./focus.js";

const node = (width: number, subtree: { minX: number; maxX: number; minY: number; maxY: number }) => ({ width, subtreeBounds: subtree });

describe("ticketFocus", () => {
  it("takes the ticket to 440 px when the whole subtree fits in the visible area", () => {
    const leaf = node(2, { minX: -1, maxX: 1, minY: 0, maxY: 1.5 });
    const { requiredScale, bounds } = ticketFocus(leaf, { width: 660, height: 700 });
    expect(TICKET_FOCUS_WIDTH).toBe(440);
    expect(requiredScale).toBeCloseTo(220);
    expect(bounds).toEqual(leaf.subtreeBounds);
  });

  it("shrinks to what fits when the children below would leave the area", () => {
    // Subárvore larga e alta: 440/10 = 44, mas só cabe 0,9 * min(660/100, 700/400).
    const parent = node(10, { minX: -50, maxX: 50, minY: 0, maxY: 400 });
    const { requiredScale } = ticketFocus(parent, { width: 660, height: 700 });
    expect(requiredScale).toBeCloseTo(0.9 * Math.min(660 / 100, 700 / 400));
  });

  it("uses the area given, not a fixed viewport", () => {
    const leaf = node(100, { minX: -50, maxX: 50, minY: 0, maxY: 75 });
    const narrow = ticketFocus(leaf, { width: 300, height: 700 }).requiredScale;
    const wide = ticketFocus(leaf, { width: 900, height: 700 }).requiredScale;
    expect(narrow).toBeLessThan(wide);
  });
});

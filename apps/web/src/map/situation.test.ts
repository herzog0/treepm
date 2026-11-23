import { describe, expect, it } from "vitest";
import { ACCENT_COLOR, CANCELLED_COLOR, IDEA_COLOR, IDEA_DISCARDED_COLOR, PRECEDENCE, SITUATION_COLORS, STATUS_COLORS, effectiveSituation, mostWorryingColor } from "./situation.js";

const SITUATIONS = ["blocked", "in_progress", "in_review", "todo", "done"] as const;
const BACKGROUND = "#08090d";
const CARD = "#12151d";
const ON_COLOR = "#121019";

const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
const toLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const luminance = (linear: readonly number[]) => 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(rgb(a).map(toLinear)), luminance(rgb(b).map(toLinear))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

// Machado, Oliveira e Fernandes (2009), severidade 1,0, aplicadas em RGB linear.
const SIMULATIONS: Record<string, number[][]> = {
  none: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
function lab(hex: string, matrix: number[][]): [number, number, number] {
  const linear = rgb(hex).map(toLinear);
  const seen = matrix.map((row) => Math.min(1, Math.max(0, row[0]! * linear[0]! + row[1]! * linear[1]! + row[2]! * linear[2]!)));
  const [x, y, z] = [
    0.4124564 * seen[0]! + 0.3575761 * seen[1]! + 0.1804375 * seen[2]!,
    0.2126729 * seen[0]! + 0.7151522 * seen[1]! + 0.072175 * seen[2]!,
    0.0193339 * seen[0]! + 0.119192 * seen[1]! + 0.9503041 * seen[2]!,
  ];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x / 0.95047), f(y), f(z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const distance = (a: string, b: string, matrix: number[][]) => Math.hypot(...lab(a, matrix).map((value, at) => value - lab(b, matrix)[at]!) as [number, number, number]);

describe("the status palette (ADR 0051)", () => {
  it("has the six agreed colors in one place", () => {
    expect(SITUATION_COLORS).toEqual({ blocked: "#ff5a4a", in_progress: "#3b8eff", in_review: "#ffd000", todo: "#70778a", done: "#2ee6b6" });
    expect(IDEA_COLOR).toBe("#f472d0");
    expect(ACCENT_COLOR).toBe("#a99bff");
  });

  it("draws cancelled as the muted grey of 'todo' and the status table agrees with the palette", () => {
    expect(CANCELLED_COLOR).not.toBe(SITUATION_COLORS.todo);
    expect(STATUS_COLORS).toEqual({ todo: SITUATION_COLORS.todo, in_progress: SITUATION_COLORS.in_progress, in_review: SITUATION_COLORS.in_review, done: SITUATION_COLORS.done, cancelled: CANCELLED_COLOR });
    expect(IDEA_DISCARDED_COLOR).not.toBe(IDEA_COLOR);
  });

  it("lists the precedence from the most worrying to the least", () => {
    expect(PRECEDENCE).toEqual(["blocked", "in_progress", "in_review", "todo", "done"]);
  });

  for (const [name, matrix] of Object.entries(SIMULATIONS)) {
    it(`keeps every pair of the five situations at least 30 apart in CIELAB (${name})`, () => {
      const pairs: [string, number][] = [];
      for (const [i, a] of SITUATIONS.entries()) for (const b of SITUATIONS.slice(i + 1)) pairs.push([`${a}/${b}`, distance(SITUATION_COLORS[a], SITUATION_COLORS[b], matrix)]);
      for (const [pair, value] of pairs) expect(value, pair).toBeGreaterThanOrEqual(30);
    });
  }

  it.each(SITUATIONS)("%s reads against the map background and the card (3:1 for a mark)", (situation) => {
    expect(contrast(SITUATION_COLORS[situation], BACKGROUND)).toBeGreaterThanOrEqual(3);
    expect(contrast(SITUATION_COLORS[situation], CARD)).toBeGreaterThanOrEqual(3);
  });

  it.each(SITUATIONS)("the dark card text is readable on %s (4:1 or better)", (situation) => {
    expect(contrast(ON_COLOR, SITUATION_COLORS[situation])).toBeGreaterThanOrEqual(4);
  });
});

describe("effectiveSituation", () => {
  it("is blocked when the summary says so and the ticket is still open", () => {
    expect(effectiveSituation({ status: "todo", blocked: true })).toBe("blocked");
    expect(effectiveSituation({ status: "in_progress", blocked: true })).toBe("blocked");
    expect(effectiveSituation({ status: "in_review", blocked: true })).toBe("blocked");
  });
  it("never is for a concluded or cancelled ticket", () => {
    expect(effectiveSituation({ status: "done", blocked: true })).toBe("done");
    expect(effectiveSituation({ status: "cancelled", blocked: true })).toBe("cancelled");
  });
  it("is the recorded status when not blocked, or when the summary does not say", () => {
    expect(effectiveSituation({ status: "in_progress", blocked: false })).toBe("in_progress");
    expect(effectiveSituation({ status: "in_review" })).toBe("in_review");
  });
});

describe("mostWorryingColor", () => {
  const c = SITUATION_COLORS;
  it("takes the first color of the precedence, whatever the order and the repetition", () => {
    expect(mostWorryingColor([c.done, c.todo, c.in_review, c.in_progress, c.blocked])).toBe(c.blocked);
    expect(mostWorryingColor([c.done, c.in_review, c.in_progress, c.done])).toBe(c.in_progress);
    expect(mostWorryingColor([c.done, c.todo, c.in_review])).toBe(c.in_review);
    expect(mostWorryingColor([c.done, c.todo, c.done])).toBe(c.todo);
    expect(mostWorryingColor([c.done, c.done])).toBe(c.done);
  });
  it("lets the situations win over the accent, the idea and the cancelled, which never rise", () => {
    expect(mostWorryingColor([ACCENT_COLOR, c.done])).toBe(c.done);
    expect(mostWorryingColor([IDEA_COLOR, CANCELLED_COLOR, c.todo])).toBe(c.todo);
    expect(mostWorryingColor([CANCELLED_COLOR, IDEA_DISCARDED_COLOR])).toBe(CANCELLED_COLOR);
  });
  it("returns a single color unchanged, even one outside the palette", () => {
    expect(mostWorryingColor(["#123456"])).toBe("#123456");
  });
  it("refuses an empty list", () => {
    expect(() => mostWorryingColor([])).toThrow();
  });
});

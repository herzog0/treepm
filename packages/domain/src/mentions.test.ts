import { describe, expect, it } from "vitest";
import { mentionCases } from "./mention-cases.js";
import { mentionedKeys, scanTicketKeys } from "./mentions.js";

describe("scanTicketKeys", () => {
  it("returns every key with its position", () => {
    expect(scanTicketKeys("Veja TREEPM-47 e AB2-3.")).toEqual([
      { key: "TREEPM-47", start: 5, end: 14 },
      { key: "AB2-3", start: 17, end: 22 },
    ]);
  });

  it("returns repeated keys, one per occurrence", () => {
    expect(scanTicketKeys("TREEPM-1 TREEPM-1").map((m) => [m.start, m.end])).toEqual([[0, 8], [9, 17]]);
  });

  it("does not match inside a longer word, number, or hyphenated or underscored name", () => {
    expect(scanTicketKeys("aTREEPM-47 TREEPM-470x TREEPM-47-b a-TREEPM-47 _TREEPM-47 TREEPM-47_")).toEqual([]);
  });

  it("does not match a lowercase key or a key without a number", () => {
    expect(scanTicketKeys("treepm-47 TREEPM- TREEPM")).toEqual([]);
  });

  it("matches before punctuation and at the edges", () => {
    expect(scanTicketKeys("(TREEPM-4), TREEPM-5").map((m) => m.key)).toEqual(["TREEPM-4", "TREEPM-5"]);
  });

  it("is repeatable (no state is kept between calls)", () => {
    expect(scanTicketKeys("TREEPM-1")).toEqual(scanTicketKeys("TREEPM-1"));
  });
});

describe("mentionedKeys", () => {
  it.each(mentionCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(mentionedKeys(c.markdown)).toEqual(c.keys);
  });

  it("is empty for an empty description", () => {
    expect(mentionedKeys("")).toEqual([]);
  });

  it("keeps the order of first appearance", () => {
    expect(mentionedKeys("B-2 A-1 B-2 C-3")).toEqual(["B-2", "A-1", "C-3"]);
  });

  it("handles a fence indented inside a list item and a longer closing fence", () => {
    expect(mentionedKeys("- item\n  ```\n  X-1\n  ```\n- Y-2\n\n````\nX-3\n```\nX-4\n````\nZ-5")).toEqual(["Y-2", "Z-5"]);
  });
});

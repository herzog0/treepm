import { describe, expect, it } from "vitest";
import { TITLE_MAX, splitIdeaText } from "./ideaText.js";

describe("splitIdeaText", () => {
  it("uses the whole text as the title when it fits, trimmed", () => {
    expect(splitIdeaText("  exportar csv  ")).toEqual({ title: "exportar csv" });
    expect(splitIdeaText("a".repeat(TITLE_MAX))).toEqual({ title: "a".repeat(TITLE_MAX) });
  });

  it("moves what passes the limit to the description", () => {
    expect(splitIdeaText(`${"a".repeat(TITLE_MAX)}bcd`)).toEqual({ title: "a".repeat(TITLE_MAX), description: "bcd" });
  });

  it("counts characters, not UTF-16 units, and never splits an emoji", () => {
    const text = `${"💡".repeat(TITLE_MAX)}fim`;
    const { title, description } = splitIdeaText(text);
    expect(Array.from(title)).toHaveLength(TITLE_MAX);
    expect(description).toBe("fim");
  });

  it("drops a description that would be only blanks", () => {
    expect(splitIdeaText(`${"a".repeat(TITLE_MAX)}   `)).toEqual({ title: "a".repeat(TITLE_MAX) });
  });
});

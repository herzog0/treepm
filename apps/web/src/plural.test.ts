import { describe, expect, it } from "vitest";
import { plural } from "./plural.js";

describe("plural", () => {
  it.each([
    [0, "0 itens"],
    [1, "1 item"],
    [2, "2 itens"],
  ])("formats %i", (count, text) => {
    expect(plural(count, "item", "itens")).toBe(text);
  });
});

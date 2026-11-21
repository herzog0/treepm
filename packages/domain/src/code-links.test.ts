import { describe, expect, it } from "vitest";
import { ticketNumbersIn } from "./code-links.js";

describe("ticketNumbersIn", () => {
  it.each([
    ["feat/treepm-12-mapa", [12]],
    ["TREEPM-12 e TREEPM-7", [7, 12]],
    ["XTREEPM-12", []],
    ["TREEPM-012", [12]],
    ["TREEPM-0", []],
    ["TREEPM-", []],
    ["TREEPM-123456789012345", []],
    ["TREEPM-2147483647", [2147483647]],
    ["TREEPM-2147483648", []],
    ["TREEPM-12TREEPM-12", [12]],
    ["TREEPM-12x", [12]],
    ["TREEPM-12-13", [12]],
    ["fix(TREEPM-5): ajuste", [5]],
    ["TREEPM-12 TREEPM-12", [12]],
    ["1TREEPM-4", []],
    ["_TREEPM-4", [4]],
    ["TREEPM-12_3", [12]],
    ["sem número", []],
    ["", []],
  ] as const)("%j com a chave TREEPM → %j", (text, expected) => {
    expect(ticketNumbersIn(text, "TREEPM")).toEqual(expected);
  });

  it("ignora maiúsculas na chave", () => {
    expect(ticketNumbersIn("Treepm-3 e treePM-1", "TREEPM")).toEqual([1, 3]);
    expect(ticketNumbersIn("TREEPM-3", "treepm")).toEqual([3]);
  });

  it("uma chave de outro projeto não liga", () => {
    expect(ticketNumbersIn("OUTRO-4 TREEPM-9", "OUTRO")).toEqual([4]);
    expect(ticketNumbersIn("OUTRO-4", "TREEPM")).toEqual([]);
  });

  it("trata a chave literalmente, sem interpretá-la como expressão regular", () => {
    expect(ticketNumbersIn("A.B-4 AXB-5", "A.B")).toEqual([4]);
  });

  it("repete o limite de palavra depois de vírgula, barra e outros separadores", () => {
    expect(ticketNumbersIn("a/TREEPM-1,TREEPM-2;TREEPM-3.", "TREEPM")).toEqual([1, 2, 3]);
  });
});

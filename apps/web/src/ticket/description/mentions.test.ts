import { describe, expect, it } from "vitest";
import { makeTicket } from "../../test/fakes.js";
import { findMentions } from "./mentions.js";

const tickets = [
  makeTicket("t47", "p1", 47, "Adicionar opção", { key: "TREEPM-47" }),
  makeTicket("t4", "p1", 4, "Outro", { key: "TREEPM-4" }),
  makeTicket("x9", "p2", 9, "De outro projeto", { key: "OUTRO-9" }),
];
const find = (text: string) => findMentions(text, tickets, "p1");

describe("findMentions", () => {
  it("finds a key of an existing ticket in the same project", () => {
    expect(find("Veja TREEPM-47 depois")).toEqual([{ start: 5, end: 14, ticket: tickets[0] }]);
  });

  it("ignores a key that does not exist", () => {
    expect(find("Veja TREEPM-99")).toEqual([]);
  });

  it("ignores a key from another project", () => {
    expect(find("Veja OUTRO-9")).toEqual([]);
  });

  it("does not match inside a longer word or number", () => {
    expect(find("XTREEPM-47 e TREEPM-470 e TREEPM-47x e TREEPM-47-b")).toEqual([]);
  });

  it("matches before punctuation", () => {
    expect(find("(TREEPM-47), TREEPM-4.").map((m) => m.ticket.key)).toEqual(["TREEPM-47", "TREEPM-4"]);
  });

  it("finds every occurrence of a repeated key", () => {
    const found = find("TREEPM-47 e de novo TREEPM-47");
    expect(found.map((m) => [m.start, m.end])).toEqual([[0, 9], [20, 29]]);
  });

  it("matches at the start and end of the text", () => {
    expect(find("TREEPM-4").map((m) => [m.start, m.end])).toEqual([[0, 8]]);
  });
});

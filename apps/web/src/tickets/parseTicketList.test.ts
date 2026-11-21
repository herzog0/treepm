import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { parseTicketList, ticketListIssueText } from "./parseTicketList.js";

function items(text: string) {
  const result = parseTicketList(text);
  if (!result.ok) throw new Error(`esperava ok, veio ${JSON.stringify(result.errors)}`);
  return result.items;
}
function errors(text: string) {
  const result = parseTicketList(text);
  if (result.ok) throw new Error("esperava erro");
  return result.errors;
}

describe("parseTicketList: itens e marcadores", () => {
  it("reads flat items marked with - and *", () => {
    expect(items("- Um\n* Dois")).toEqual([{ title: "Um" }, { title: "Dois" }]);
  });

  it.each([
    ["[ ]", undefined],
    ["[/]", "in_progress"],
    ["[r]", "in_review"],
    ["[x]", "done"],
    ["[X]", "done"],
    ["[-]", "cancelled"],
  ])("maps the marker %s", (marker, status) => {
    const [item] = items(`- ${marker} Tarefa`);
    expect(item).toEqual(status === undefined ? { title: "Tarefa" } : { title: "Tarefa", status });
  });

  it("treats an item without marker as to do (no status sent)", () => {
    expect(items("- Sem marcador")[0]).not.toHaveProperty("status");
  });

  it("does not take an unknown bracket as a marker", () => {
    expect(items("- [?] Dúvida")).toEqual([{ title: "[?] Dúvida" }]);
  });

  it("trims the title", () => {
    expect(items("-   [x]    Espaçado   ")).toEqual([{ title: "Espaçado", status: "done" }]);
  });

  it("accepts CRLF line endings", () => {
    expect(items("- A\r\n  - B\r\n")).toEqual([{ title: "A", children: [{ title: "B" }] }]);
  });
});

describe("parseTicketList: árvore", () => {
  it("nests by indentation and keeps sibling order", () => {
    expect(items("- A\n  - A1\n  - A2\n    - A2a\n- B")).toEqual([
      { title: "A", children: [{ title: "A1" }, { title: "A2", children: [{ title: "A2a" }] }] },
      { title: "B" },
    ]);
  });

  it("makes items without a parent roots, several allowed", () => {
    expect(items("- A\n- B\n- C").map((item) => item.title)).toEqual(["A", "B", "C"]);
  });

  it("takes the nearest previous item with smaller indentation as parent, whatever the jump", () => {
    expect(items("- A\n      - fundo\n  - meio")).toEqual([
      { title: "A", children: [{ title: "fundo" }, { title: "meio" }] },
    ]);
  });

  it("counts a tab as two spaces", () => {
    expect(items("- A\n\t- B\n  - C")).toEqual([{ title: "A", children: [{ title: "B" }, { title: "C" }] }]);
  });

  it("accepts an indented first item as a root", () => {
    expect(items("  - A\n  - B")).toEqual([{ title: "A" }, { title: "B" }]);
  });

  it("lets a shallower item close deeper ones", () => {
    expect(items("  - A\n    - B\n- C").map((item) => item.title)).toEqual(["A", "C"]);
  });
});

describe("parseTicketList: descrição", () => {
  it("turns more indented non-item lines into the item description, joined by newline", () => {
    expect(items("- A\n  Linha um.\n  Linha dois.")).toEqual([{ title: "A", description: "Linha um.\nLinha dois." }]);
  });

  it("removes only the common indentation", () => {
    expect(items("- A\n    base\n      recuo")).toEqual([{ title: "A", description: "base\n  recuo" }]);
  });

  it("keeps blank lines between description lines", () => {
    expect(items("- A\n  um\n\n  dois")).toEqual([{ title: "A", description: "um\n\ndois" }]);
  });

  it("ignores blank lines elsewhere", () => {
    expect(items("\n- A\n\n\n  - B\n\n")).toEqual([{ title: "A", children: [{ title: "B" }] }]);
  });

  it("attaches a description to the item right above it, even between children", () => {
    expect(items("- A\n  - B\n    nota de B\n  - C")).toEqual([
      { title: "A", children: [{ title: "B", description: "nota de B" }, { title: "C" }] },
    ]);
  });

  it("omits description when empty", () => {
    expect(items("- A")[0]).not.toHaveProperty("description");
  });
});

describe("parseTicketList: avisos", () => {
  it("warns about a marker on an item with children, keeping the status", () => {
    const result = parseTicketList("- [x] Pai\n  - Filho\n- [x] Folha");
    expect(result).toEqual({
      ok: true,
      items: [{ title: "Pai", status: "done", children: [{ title: "Filho" }] }, { title: "Folha", status: "done" }],
      warnings: [{ line: 1, code: "marker_on_parent" }],
    });
  });

  it("does not warn without marker", () => {
    const result = parseTicketList("- Pai\n  - [x] Filho");
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });
});

describe("parseTicketList: erros", () => {
  it("rejects text before the first item", () => {
    expect(errors("Introdução\n- A")).toEqual([{ line: 1, code: "text_before_first_item" }]);
  });

  it("rejects a loose line with indentation equal to or lower than the previous item", () => {
    expect(errors("- A\nsolta\n  - B\n  solta2")).toEqual([
      { line: 2, code: "stray_line" },
      { line: 4, code: "stray_line" },
    ]);
  });

  it("reports line numbers from 1, counting blank lines", () => {
    expect(errors("\n\n- A\n\nfora")).toEqual([{ line: 5, code: "stray_line" }]);
  });

  it("rejects an empty title", () => {
    expect(errors("- A\n- [x]\n-")).toEqual([
      { line: 2, code: "empty_title" },
      { line: 3, code: "empty_title" },
    ]);
  });

  it("rejects a title above 200 characters, accepts exactly 200", () => {
    expect(items(`- ${"a".repeat(200)}`)).toHaveLength(1);
    expect(errors(`- ok\n- ${"a".repeat(201)}`)).toEqual([{ line: 2, code: "title_too_long" }]);
  });

  it("rejects a description above 20000 characters", () => {
    expect(errors(`- A\n  ${"a".repeat(20001)}`)).toEqual([{ line: 1, code: "description_too_long" }]);
  });

  it("rejects more than 500 items at the line of the 501st", () => {
    const lines = Array.from({ length: 501 }, (_, index) => `- item ${index}`);
    expect(items(lines.slice(0, 500).join("\n"))).toHaveLength(500);
    expect(errors(lines.join("\n"))).toEqual([{ line: 501, code: "too_many_items" }]);
  });

  it("rejects depth above 20, accepts exactly 20", () => {
    const chain = (depth: number) => Array.from({ length: depth }, (_, level) => `${"  ".repeat(level)}- n${level}`).join("\n");
    expect(items(chain(20))).toHaveLength(1);
    expect(errors(chain(21))).toEqual([{ line: 21, code: "depth_too_deep" }]);
  });

  it("rejects an empty list", () => {
    expect(errors("")).toEqual([{ line: 1, code: "empty_list" }]);
    expect(errors("\n  \n")).toEqual([{ line: 1, code: "empty_list" }]);
  });

  it("does not take lines like -x or --- as items", () => {
    expect(errors("-x")).toEqual([{ line: 1, code: "text_before_first_item" }]);
  });
});

describe("ticketListIssueText in Portuguese", () => {
  const describeIssue = (issue: { line: number; code: string }) => ticketListIssueText(i18n.getFixedT("pt-BR", "tickets"), "pt-BR", issue);
  it.each([
    "text_before_first_item",
    "stray_line",
    "empty_title",
    "title_too_long",
    "description_too_long",
    "too_many_items",
    "depth_too_deep",
    "empty_list",
    "marker_on_parent",
  ])("describes %s in Portuguese with the line number", (code) => {
    const message = describeIssue({ line: 7, code });
    expect(message).toMatch(/^Linha 7: /);
    expect(message.length).toBeGreaterThan(15);
    expect(message).not.toContain(code);
  });

  it("falls back for an unknown code", () => {
    expect(describeIssue({ line: 2, code: "xyz" })).toMatch(/^Linha 2: /);
  });
});

describe("docs/roadmap-tickets.md", () => {
  it("parses as the real list, with its root lines and every item line", () => {
    const text = readFileSync(resolve(import.meta.dirname, "../../../../docs/roadmap-tickets.md"), "utf8");
    const itemLines = text.split("\n").filter((line) => /^\s*[-*] /.test(line)).length;
    const rootLines = text.split("\n").filter((line) => /^[-*] /.test(line)).length;
    const result = parseTicketList(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const count = (list: typeof result.items): number => list.reduce((sum, item) => sum + 1 + count(item.children ?? []), 0);
    expect(result.items).toHaveLength(rootLines);
    expect(count(result.items)).toBe(itemLines);
  });
});

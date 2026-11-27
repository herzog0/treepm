import { describe, expect, it } from "vitest";
import type { Actor } from "./index.js";
import {
  canAssignTicket,
  canCreateTicket,
  canEditTicket,
  canImportTickets,
  canRemoveTicket,
  canViewTickets,
  deriveParentStatuses,
  descriptionExcerpt,
  isFinished,
  isStatusDerived,
  parentStatusFrom,
  parentWouldCreateCycle,
  ticketProgress,
} from "./tickets.js";
import type { TicketNode } from "./tickets.js";

const privateProject = { id: "internal", visibility: "private" } as const;
const organizationProject = { id: "roadmap", visibility: "organization" } as const;

const member: Actor = { clerkRole: "member", teamRoles: new Map([["design", "member"]]), projectRoles: new Map() };
const orgAdmin: Actor = { ...member, clerkRole: "admin" };
const teamAdmin: Actor = { ...member, teamRoles: new Map([["design", "admin"]]) };
const manager: Actor = { ...member, projectRoles: new Map([[privateProject.id, "manager"]]) };
const contributor: Actor = { ...member, projectRoles: new Map([[privateProject.id, "contributor"]]) };
const reader: Actor = { ...member, projectRoles: new Map([[privateProject.id, "reader"]]) };

const roles = [
  ["organization admin", orgAdmin],
  ["team admin", teamAdmin],
  ["project manager", manager],
  ["contributor", contributor],
  ["reader", reader],
  ["member without project role", member],
] as const;

describe.each([
  { action: "view tickets of a private project", check: (a: Actor) => canViewTickets(a, privateProject), allowed: [true, false, true, true, true, false] },
  { action: "view tickets of an organization project", check: (a: Actor) => canViewTickets(a, organizationProject), allowed: [true, true, true, true, true, true] },
  { action: "create a ticket", check: (a: Actor) => canCreateTicket(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "edit a ticket", check: (a: Actor) => canEditTicket(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "assign people", check: (a: Actor) => canAssignTicket(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "import a list", check: (a: Actor) => canImportTickets(a, privateProject.id), allowed: [true, false, true, true, false, false] },
  { action: "remove a ticket", check: (a: Actor) => canRemoveTicket(a, privateProject.id), allowed: [true, false, true, false, false, false] },
])("$action", ({ check, allowed }) => {
  it.each(roles.map(([name, actor], index) => [name, actor, allowed[index]] as const))("%s", (_name, actor, expected) => {
    expect(check(actor)).toBe(expected);
  });
});

it("ties the project role to the target project", () => {
  expect(canEditTicket(contributor, organizationProject.id)).toBe(false);
  expect(canRemoveTicket(manager, organizationProject.id)).toBe(false);
  expect(canEditTicket(orgAdmin, organizationProject.id)).toBe(true);
});

const node = (id: string, parentId: string | null, status: TicketNode["status"] = "todo"): TicketNode => ({
  id,
  parentId,
  status,
});

describe("isFinished", () => {
  it("done and cancelled are finished; the other three are open", () => {
    expect(isFinished("done")).toBe(true);
    expect(isFinished("cancelled")).toBe(true);
    expect(isFinished("todo")).toBe(false);
    expect(isFinished("in_progress")).toBe(false);
    expect(isFinished("in_review")).toBe(false);
  });
});

describe("ticketProgress", () => {
  it("has no entry for a ticket without children, and none for an empty list", () => {
    expect(ticketProgress([]).size).toBe(0);
    expect(ticketProgress([node("a", null, "done")]).get("a")).toBeUndefined();
  });

  it("has an entry for every ticket that has children, and only for those", () => {
    const progress = ticketProgress([node("p", null), node("c", "p"), node("alone", null, "done")]);
    expect(progress.has("p")).toBe(true);
    expect(progress.has("c")).toBe(false);
    expect(progress.has("alone")).toBe(false);
  });

  it("counts direct children: done, total without cancelled, and excluded", () => {
    const tickets = [
      node("root", null),
      node("a", "root", "done"),
      node("b", "root", "in_progress"),
      node("c", "root", "cancelled"),
      node("d", "root", "in_review"),
      node("e", "root", "todo"),
    ];
    expect(ticketProgress(tickets).get("root")).toEqual({ done: 1, total: 4, excluded: 1, ideas: 0 });
  });

  it("counts every descendant, at any level, and a descendant that is a parent counts as one item by its own status", () => {
    // pai (qualquer situação própria) > filho que também é pai > neto; cancelados em cada nível.
    const tickets = [
      node("pai", null, "done"),
      node("filho", "pai", "in_progress"),
      node("neto-feito", "filho", "done"),
      node("neto-aberto", "filho", "todo"),
      node("neto-cancelado", "filho", "cancelled"),
      node("filho-feito", "pai", "done"),
      node("filho-cancelado", "pai", "cancelled"),
      node("neto-do-cancelado", "filho-cancelado", "todo"),
    ];
    const progress = ticketProgress(tickets);
    // Do pai: filho (aberto), neto-feito, neto-aberto, filho-feito, neto-do-cancelado contam; neto-cancelado e filho-cancelado são excluídos.
    expect(progress.get("pai")).toEqual({ done: 2, total: 5, excluded: 2, ideas: 0 });
    expect(progress.get("filho")).toEqual({ done: 1, total: 2, excluded: 1, ideas: 0 });
    expect(progress.get("filho-cancelado")).toEqual({ done: 0, total: 1, excluded: 0, ideas: 0 });
    expect(progress.has("neto-feito")).toBe(false);
  });

  it("does not depend on the input order", () => {
    const tickets = [node("leaf", "root", "done"), node("root", null)];
    expect(ticketProgress(tickets).get("root")).toEqual({ done: 1, total: 1, excluded: 0, ideas: 0 });
  });

  it("handles all children cancelled", () => {
    const tickets = [node("root", null), node("a", "root", "cancelled")];
    expect(ticketProgress(tickets).get("root")).toEqual({ done: 0, total: 0, excluded: 1, ideas: 0 });
  });
});

describe("parentWouldCreateCycle", () => {
  const parents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
    ["x", null],
  ]);

  it("rejects the ticket itself as parent", () => {
    expect(parentWouldCreateCycle(parents, "a", "a")).toBe(true);
  });

  it("rejects a descendant as parent", () => {
    expect(parentWouldCreateCycle(parents, "a", "b")).toBe(true);
    expect(parentWouldCreateCycle(parents, "a", "c")).toBe(true);
  });

  it("accepts siblings, ancestors, other trees and root", () => {
    expect(parentWouldCreateCycle(parents, "c", "a")).toBe(false);
    expect(parentWouldCreateCycle(parents, "b", "x")).toBe(false);
    expect(parentWouldCreateCycle(parents, "c", null)).toBe(false);
    expect(parentWouldCreateCycle(parents, "x", "a")).toBe(false);
  });
});

describe("descriptionExcerpt", () => {
  it("devolve vazio para descrição vazia e o texto inteiro até 600 caracteres", () => {
    expect(descriptionExcerpt("")).toBe("");
    expect(descriptionExcerpt("curta")).toBe("curta");
    expect(descriptionExcerpt("a".repeat(600))).toBe("a".repeat(600));
  });

  it("corta em 600 e acrescenta reticências depois deles", () => {
    expect(descriptionExcerpt("a".repeat(601))).toBe(`${"a".repeat(600)}…`);
  });

  it("conta por ponto de código, sem partir par substituto", () => {
    const emoji = "😀";
    expect(descriptionExcerpt(emoji.repeat(600))).toBe(emoji.repeat(600));
    expect(descriptionExcerpt(emoji.repeat(601))).toBe(`${emoji.repeat(600)}…`);
    expect(descriptionExcerpt(`${"a".repeat(599)}${emoji}b`)).toBe(`${"a".repeat(599)}${emoji}…`);
  });

  // A regra antiga (`Array.from` da descrição inteira): o resultado novo tem de ser idêntico, em qualquer texto.
  const antigo = (description: string): string => {
    if (description.length <= 600) return description;
    const points = Array.from(description);
    if (points.length <= 600) return description;
    return `${points.slice(0, 600).join("")}…`;
  };

  it("é idêntico à regra antiga nos casos de borda e em textos aleatórios (pares, substitutos soltos, compostos, quebras)", () => {
    const pieces = ["a", "é", "e\u0301", "😀", "👨‍👩‍👧‍👦", "日", "\r\n", "\n", " ", "\ud83d", "\ude00", "…", "𝒳"];
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const cases: string[] = [
      "", "a".repeat(599), "a".repeat(600), "a".repeat(601), "😀".repeat(299), "😀".repeat(300), "😀".repeat(301), "😀".repeat(600), "😀".repeat(601),
      `${"a".repeat(599)}😀`, `${"a".repeat(598)}😀😀`, `${"a".repeat(599)}😀😀😀`, "e\u0301".repeat(400), "\ud83d".repeat(700), "\ude00".repeat(650), `${"a".repeat(599)}\ud83d`,
      `${"a".repeat(599)}\ud83dx`, `${"b".repeat(600)}\ud83d`, `${"b".repeat(600)}\ude00`, "👨‍👩‍👧‍👦".repeat(100), "x\r\n".repeat(300),
    ];
    for (let i = 0; i < 400; i += 1) {
      const length = Math.floor(next() * 900);
      let text = "";
      while (text.length < length) text += pieces[Math.floor(next() * pieces.length)];
      cases.push(text);
    }
    for (const text of cases) expect(descriptionExcerpt(text)).toBe(antigo(text));
  });

  it("não percorre o texto inteiro: uma descrição enorme sai no mesmo instante", () => {
    const enorme = "😀a".repeat(5_000_000);
    const started = performance.now();
    expect(descriptionExcerpt(enorme)).toBe(`${"😀a".repeat(300)}…`);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("parentStatusFrom (ADR 0068, seção 2: a situação do pai sai dos filhos)", () => {
  it("sem filho (sem contar ideias): não há situação calculada", () => {
    expect(parentStatusFrom([])).toBeNull();
  });

  it("todos cancelados: cancelado", () => {
    expect(parentStatusFrom(["cancelled"])).toBe("cancelled");
    expect(parentStatusFrom(["cancelled", "cancelled"])).toBe("cancelled");
  });

  it("todos concluídos ou cancelados, com pelo menos um concluído: concluído", () => {
    expect(parentStatusFrom(["done"])).toBe("done");
    expect(parentStatusFrom(["done", "cancelled", "done"])).toBe("done");
  });

  it("algum em andamento, em revisão ou concluído, e ainda há filho aberto: em andamento", () => {
    expect(parentStatusFrom(["in_progress"])).toBe("in_progress");
    expect(parentStatusFrom(["in_review"])).toBe("in_progress");
    expect(parentStatusFrom(["done", "todo"])).toBe("in_progress");
    expect(parentStatusFrom(["todo", "in_review", "cancelled"])).toBe("in_progress");
  });

  it("os demais casos: a fazer", () => {
    expect(parentStatusFrom(["todo"])).toBe("todo");
    expect(parentStatusFrom(["todo", "cancelled"])).toBe("todo");
  });
});

describe("deriveParentStatuses", () => {
  const n = (id: string, parentId: string | null, status: TicketNode["status"] = "todo", ideaStage: TicketNode["ideaStage"] = null): TicketNode => ({ id, parentId, status, ideaStage });

  it("refaz de baixo para cima, cada pai com a situação já refeita dos filhos", () => {
    const tree = [n("a", null, "todo"), n("b", "a", "todo"), n("c", "b", "done"), n("d", "a", "done")];
    expect(deriveParentStatuses(tree, ["b", "a"])).toEqual(new Map([["b", "done"], ["a", "done"]]));
  });

  it("só devolve quem tem a situação calculada: sem filho fica de fora", () => {
    const tree = [n("a", null, "in_review"), n("x", null, "done"), n("y", "x", "todo")];
    expect(deriveParentStatuses(tree, ["a", "x"])).toEqual(new Map([["x", "todo"]]));
  });

  it("ideias não contam: filho raiz de ideia fica fora da conta; só ideias = sem situação calculada", () => {
    const tree = [n("p", null, "done"), n("i", "p", "todo", "new"), n("k", "p", "done")];
    expect(deriveParentStatuses(tree, ["p"])).toEqual(new Map([["p", "done"]]));
    const onlyIdeas = [n("q", null, "in_review"), n("j", "q", "todo", "refining")];
    expect(deriveParentStatuses(onlyIdeas, ["q"])).toEqual(new Map());
  });

  it("dentro de uma ideia (a raiz incluída) nada é calculado: a situação fica parada até o aceite", () => {
    const tree = [n("r", null, "todo", "new"), n("s", "r", "todo"), n("t", "s", "cancelled")];
    expect(deriveParentStatuses(tree, ["s", "r"])).toEqual(new Map());
  });

  it("ordem dada fora de ordem: o resultado é o mesmo (de baixo para cima pela árvore)", () => {
    const tree = [n("a", null), n("b", "a"), n("c", "b", "cancelled")];
    expect(deriveParentStatuses(tree, ["a", "b"])).toEqual(new Map([["b", "cancelled"], ["a", "cancelled"]]));
  });
});

describe("isStatusDerived (pela leitura do progresso)", () => {
  it("sem filhos, ou só ideias embaixo: marcada à mão", () => {
    expect(isStatusDerived(null)).toBe(false);
    expect(isStatusDerived({ done: 0, total: 0, excluded: 0, ideas: 2 })).toBe(false);
  });

  it("algum filho que não é ideia, mesmo cancelado: calculada", () => {
    expect(isStatusDerived({ done: 0, total: 1, excluded: 0, ideas: 0 })).toBe(true);
    expect(isStatusDerived({ done: 0, total: 0, excluded: 1, ideas: 0 })).toBe(true);
  });
});

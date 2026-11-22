import { describe, expect, it } from "vitest";
import type { Actor } from "./index.js";
import {
  canBecomeIdea,
  canChangeIdeaStage,
  canMoveIntoIdea,
  canRefineIdea,
  canRegisterIdea,
  canTriageIdea,
  ideaRootOf,
  ideaRootsOf,
  isTurn,
  openChildCount,
  statusChangeAllowed,
  ticketProgress,
  ticketsOfTheTurn,
  ticketsToReopen,
} from "./tickets.js";
import type { IdeaStage, TicketNode, TicketStatus } from "./tickets.js";

const n = (id: string, parentId: string | null, status: TicketStatus = "todo", ideaStage: IdeaStage | null = null): TicketNode => ({
  id,
  parentId,
  status,
  ideaStage,
});
const maps = (nodes: TicketNode[]) => ({
  parents: new Map(nodes.map((t) => [t.id, t.parentId])),
  stages: new Map(nodes.map((t) => [t.id, t.ideaStage ?? null])),
  statuses: new Map(nodes.map((t) => [t.id, t.status])),
});

describe("ideaRootOf / ideaRootsOf", () => {
  // a (comum) > i1 (ideia) > x > i2 (ideia) > y ; b (comum) > c
  const tree = [n("a", null), n("i1", "a", "todo", "new"), n("x", "i1"), n("i2", "x", "todo", "refining"), n("y", "i2"), n("b", null), n("c", "b")];
  const { parents, stages } = maps(tree);

  it("a raiz é ela mesma; o que está dentro aponta para a raiz mais próxima acima", () => {
    expect(ideaRootOf(parents, stages, "i1")).toBe("i1");
    expect(ideaRootOf(parents, stages, "x")).toBe("i1");
    expect(ideaRootOf(parents, stages, "i2")).toBe("i2");
    expect(ideaRootOf(parents, stages, "y")).toBe("i2");
  });

  it("ticket comum fora de ideia: nenhuma", () => {
    expect(ideaRootOf(parents, stages, "a")).toBeNull();
    expect(ideaRootOf(parents, stages, "c")).toBeNull();
    expect(ideaRootOf(parents, stages, null)).toBeNull();
  });

  it("mover para dentro e para fora muda a resposta", () => {
    const into = maps([...tree.filter((t) => t.id !== "c"), n("c", "x")]);
    expect(ideaRootOf(into.parents, into.stages, "c")).toBe("i1");
    const out = maps([...tree.filter((t) => t.id !== "x"), n("x", "b")]);
    expect(ideaRootOf(out.parents, out.stages, "x")).toBeNull();
    expect(ideaRootOf(out.parents, out.stages, "y")).toBe("i2");
  });

  it("ideia descartada também é raiz; aceitar (sem estágio) devolve ao processo", () => {
    const d = maps([n("r", null, "todo", "discarded"), n("k", "r")]);
    expect(ideaRootOf(d.parents, d.stages, "k")).toBe("r");
    const accepted = maps([n("r", null), n("k", "r")]);
    expect(ideaRootOf(accepted.parents, accepted.stages, "k")).toBeNull();
  });

  it("ideaRootsOf devolve só quem está dentro de ideia", () => {
    const roots = ideaRootsOf(tree);
    expect([...roots.entries()].sort()).toEqual([["i1", "i1"], ["i2", "i2"], ["x", "i1"], ["y", "i2"]]);
  });

  it("ciclo nos dados não trava", () => {
    const cyc = maps([n("p", "q"), n("q", "p")]);
    expect(ideaRootOf(cyc.parents, cyc.stages, "p")).toBeNull();
  });
});

describe("regra 1: não reabre o pai concluído", () => {
  const { parents, statuses } = maps([n("p", null, "done")]);
  it("fora do processo: nada a reabrir", () => {
    expect(ticketsToReopen(parents, statuses, "p", true)).toEqual([]);
  });
  it("comum: reabre como antes", () => {
    expect(ticketsToReopen(parents, statuses, "p", false)).toEqual(["p"]);
    expect(ticketsToReopen(parents, statuses, "p")).toEqual(["p"]);
  });
});

describe("regra 2: não conta como filho aberto", () => {
  it("filho que é raiz de ideia não conta; filho comum aberto conta", () => {
    const tree = [n("p", null), n("i", "p", "todo", "new"), n("k", "p")];
    expect(openChildCount(tree, "p")).toBe(1);
    expect(openChildCount([n("p", null), n("i", "p", "todo", "ready")], "p")).toBe(0);
  });
  it("sem estágio nenhum nos nós, é a regra de sempre", () => {
    expect(openChildCount([{ id: "p", parentId: null, status: "todo" }, { id: "k", parentId: "p", status: "todo" }], "p")).toBe(1);
  });
});

describe("regra 3: fora do progresso, com `ideas`", () => {
  it("a ideia não entra em total, done nem excluded; ideas conta as raízes", () => {
    const tree = [n("p", null), n("i", "p", "todo", "new"), n("x", "i"), n("x2", "x"), n("k", "p", "done")];
    expect(ticketProgress(tree).get("p")).toEqual({ done: 1, total: 1, excluded: 0, ideas: 1 });
  });
  it("conta raízes, não os tickets dentro delas; ideia dentro de ideia também é raiz", () => {
    const tree = [n("p", null), n("i1", "p", "todo", "new"), n("a", "i1"), n("i2", "a", "todo", "refining"), n("b", "i2"), n("i3", "p", "todo", "discarded")];
    expect(ticketProgress(tree).get("p")).toEqual({ done: 0, total: 0, excluded: 0, ideas: 3 });
  });
  it("progresso da raiz e de quem está dentro: tudo zero, ideas só das de dentro", () => {
    const tree = [n("i1", null, "todo", "new"), n("a", "i1"), n("b", "a", "cancelled"), n("i2", "a", "todo", "ready"), n("c", "i2")];
    const progress = ticketProgress(tree);
    expect(progress.get("i1")).toEqual({ done: 0, total: 0, excluded: 0, ideas: 1 });
    expect(progress.get("a")).toEqual({ done: 0, total: 0, excluded: 0, ideas: 1 });
    expect(progress.get("i2")).toEqual({ done: 0, total: 0, excluded: 0, ideas: 0 });
  });
  it("sem ideia nenhuma, ideas é 0 e o resto não muda", () => {
    expect(ticketProgress([n("p", null), n("a", "p", "done"), n("b", "p", "cancelled")]).get("p")).toEqual({ done: 1, total: 1, excluded: 1, ideas: 0 });
  });
});

describe("regra 4: nunca é o ticket da vez", () => {
  it("ideia e o que está dentro não são da vez; o pai com só ideia aberta dentro é", () => {
    const tree = [n("p", null), n("i", "p", "todo", "new"), n("x", "i")];
    expect([...ticketsOfTheTurn(tree)]).toEqual(["p"]);
  });
  it("o filho aberto comum ainda segura o pai", () => {
    const tree = [n("p", null), n("i", "p", "todo", "new"), n("k", "p")];
    expect([...ticketsOfTheTurn(tree)]).toEqual(["k"]);
  });
  it("isTurn recusa quem está dentro de ideia", () => {
    expect(isTurn("todo", null, true)).toBe(false);
    expect(isTurn("todo", null, false)).toBe(true);
    expect(isTurn("todo", null)).toBe(true);
    expect(isTurn("todo", { done: 0, total: 0, excluded: 0, ideas: 1 })).toBe(true);
  });
});

describe("regra 5: a situação não muda", () => {
  it("dentro de ideia só a mesma situação é aceita; fora, qualquer uma", () => {
    expect(statusChangeAllowed(true, "todo", "in_progress")).toBe(false);
    expect(statusChangeAllowed(true, "todo", "done")).toBe(false);
    expect(statusChangeAllowed(true, "cancelled", "todo")).toBe(false);
    expect(statusChangeAllowed(true, "todo", "todo")).toBe(true);
    expect(statusChangeAllowed(false, "todo", "done")).toBe(true);
  });
});

describe("transições de estágio", () => {
  it("entre new, refining e ready vale qualquer uma; discarded só volta para refining", () => {
    for (const a of ["new", "refining", "ready"] as const) for (const b of ["new", "refining", "ready"] as const) expect(canChangeIdeaStage(a, b)).toBe(true);
    expect(canChangeIdeaStage("discarded", "refining")).toBe(true);
    expect(canChangeIdeaStage("discarded", "new")).toBe(false);
    expect(canChangeIdeaStage("discarded", "ready")).toBe(false);
    expect(canChangeIdeaStage("new", "discarded")).toBe(false);
  });
});

describe("transformar em ideia e mover para dentro", () => {
  it("o ticket tem de estar todo e nenhum descendente em andamento, em revisão ou concluído", () => {
    expect(canBecomeIdea("todo", ["todo", "cancelled"])).toBe(true);
    expect(canBecomeIdea("todo", [])).toBe(true);
    expect(canBecomeIdea("in_progress", [])).toBe(false);
    expect(canBecomeIdea("done", [])).toBe(false);
    expect(canBecomeIdea("cancelled", [])).toBe(false);
    for (const bad of ["in_progress", "in_review", "done"] as const) expect(canBecomeIdea("todo", ["todo", bad])).toBe(false);
  });
  it("mover para dentro: ele e os descendentes todo ou cancelled", () => {
    expect(canMoveIntoIdea("todo", ["todo", "cancelled"])).toBe(true);
    expect(canMoveIntoIdea("cancelled", [])).toBe(true);
    expect(canMoveIntoIdea("in_progress", [])).toBe(false);
    expect(canMoveIntoIdea("todo", ["done"])).toBe(false);
    expect(canMoveIntoIdea("todo", ["in_review"])).toBe(false);
  });
});

describe("permissões de ideia", () => {
  const base: Actor = { clerkRole: "member", teamRoles: new Map(), projectRoles: new Map() };
  const with_ = (role: "manager" | "contributor" | "reader"): Actor => ({ ...base, projectRoles: new Map([["p", role]]) });
  const admin: Actor = { ...base, clerkRole: "admin" };
  it.each([
    ["admin", admin, true, true],
    ["manager", with_("manager"), true, true],
    ["contributor", with_("contributor"), true, false],
    ["reader", with_("reader"), false, false],
    ["sem papel", base, false, false],
  ])("%s", (_name, actor, writes, triages) => {
    expect(canRegisterIdea(actor, "p")).toBe(writes);
    expect(canRefineIdea(actor, "p")).toBe(writes);
    expect(canTriageIdea(actor, "p")).toBe(triages);
  });
  it("o papel vale só para o projeto dele", () => {
    expect(canTriageIdea(with_("manager"), "outro")).toBe(false);
  });
});

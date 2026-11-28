import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { buildMapItems } from "./items.js";
import type { MapNode } from "./items.js";
import { SITUATION_COLORS } from "./situation.js";

// ADR 0069: o mapa usa as dependências da lista do projeto (cores de fila, ordem dos irmãos, habilitador, os três números).
const org = { orgId: "org", name: "Org", slug: "org" };
const project: Project = { id: "p", name: "Projeto", key: "P", visibility: "organization", archivedAt: null, members: [], teamIds: [] };
let number = 0;
const ticket = (id: string, extra: Partial<TicketSummary> = {}): TicketSummary => ({
  id,
  projectId: "p",
  number: ++number,
  key: `P-${number}`,
  parentId: null,
  title: id,
  status: "todo",
  progress: null,
  assigneeIds: [],
  descriptionExcerpt: "",
  idea: null,
  agentWork: null,
  ...extra,
});
const build = (tickets: TicketSummary[]): MapNode[] => [...buildMapItems(org, [project], { p: tickets })];
const node = (items: MapNode[], id: string): MapNode => items.find((item) => item.id === id)!;

describe("cores de fila (ADR 0069, seção 3)", () => {
  it("um 'a fazer' sem filhos usa a cor do lugar na fila; as outras situações e o bloqueado ficam como estão", () => {
    const items = build([
      ticket("a", { place: "free" }),
      ticket("b", { place: "next" }),
      ticket("c", { place: "waiting" }),
      ticket("d", { status: "in_progress", place: "free" }),
      ticket("e", { place: "free", blocked: true }),
    ]);
    expect(["a", "b", "c", "d", "e"].map((id) => node(items, id).color)).toEqual([
      SITUATION_COLORS.free,
      SITUATION_COLORS.next,
      SITUATION_COLORS.waiting,
      SITUATION_COLORS.in_progress,
      SITUATION_COLORS.blocked,
    ]);
  });

  it("o pai sobe a mais preocupante: em revisão › livre › próximo › esperando › concluído", () => {
    const progress = { done: 1, total: 4, excluded: 0 };
    const items = build([
      ticket("p1", { progress }),
      ticket("a", { parentId: "p1", place: "waiting" }),
      ticket("b", { parentId: "p1", place: "next" }),
      ticket("c", { parentId: "p1", place: "free" }),
      ticket("d", { parentId: "p1", status: "done" }),
      ticket("p2", { progress }),
      ticket("e", { parentId: "p2", place: "free" }),
      ticket("f", { parentId: "p2", status: "in_review" }),
      ticket("p3", { progress }),
      ticket("g", { parentId: "p3", place: "waiting" }),
      ticket("h", { parentId: "p3", status: "done" }),
    ]);
    expect(node(items, "p1").color).toBe(SITUATION_COLORS.free);
    expect(node(items, "p2").color).toBe(SITUATION_COLORS.in_review);
    expect(node(items, "p3").color).toBe(SITUATION_COLORS.waiting);
  });
});

const start = (id: string) => ({ id, need: "start" as const });
const deliver = (id: string) => ({ id, need: "deliver" as const });
const childrenOf = (items: MapNode[], parentId: string) => items.filter((item) => item.parentId === parentId).map((item) => item.id);

describe("ordem dos irmãos e habilitador (ADR 0069, seção 2)", () => {
  it("dá ao motor os irmãos por passo, depois prioridade efetiva, depois número", () => {
    const items = build([
      ticket("pai", { progress: { done: 0, total: 5, excluded: 0 } }),
      ticket("depois", { parentId: "pai", dependencies: [start("meio")] }),
      ticket("meio", { parentId: "pai", dependencies: [start("casca")] }),
      ticket("casca", { parentId: "pai" }),
      ticket("solto", { parentId: "pai" }),
      ticket("urgente", { parentId: "pai", priority: 5, dependencies: [deliver("depois")] }),
    ]);
    expect(childrenOf(items, "pai")).toEqual(["urgente", "casca", "solto", "meio", "depois"]);
  });

  it("marca o habilitador, e só ele", () => {
    const items = build([
      ticket("pai", { progress: { done: 0, total: 3, excluded: 0 } }),
      ticket("a", { parentId: "pai", dependencies: [start("casca")] }),
      ticket("b", { parentId: "pai", dependencies: [start("casca")] }),
      ticket("casca", { parentId: "pai" }),
    ]);
    expect(items.filter((item) => item.enabler === true).map((item) => item.id)).toEqual(["casca"]);
  });

  it("sem dependências, a ordem continua a de número", () => {
    const items = build([ticket("x"), ticket("y"), ticket("z")]);
    expect(childrenOf(items, "p")).toEqual(["x", "y", "z"]);
  });
});

describe("os três números do pai (ADR 0069, seção 4)", () => {
  it("conta a subárvore inteira: tickets e prontos do progresso, livres = 'a fazer' livres e sem impedimento, em qualquer nível", () => {
    const items = build([
      ticket("raiz", { progress: { done: 2, total: 7, excluded: 1, ideas: 1 } }),
      ticket("a", { parentId: "raiz", status: "done", place: null }),
      ticket("b", { parentId: "raiz", place: "free" }),
      ticket("c", { parentId: "raiz", place: "free", blocked: true }),
      ticket("d", { parentId: "raiz", status: "in_progress", place: "free" }),
      ticket("e", { parentId: "raiz", status: "cancelled", place: null }),
      ticket("sub", { parentId: "raiz", progress: { done: 1, total: 3, excluded: 0 } }),
      ticket("f", { parentId: "sub", place: "free" }),
      ticket("g", { parentId: "sub", place: "waiting" }),
      ticket("h", { parentId: "sub", status: "done", place: null }),
      ticket("ideia", { parentId: "raiz", idea: { root: true, stage: "new" }, place: null }),
    ]);
    expect(node(items, "raiz").counts).toEqual({ tickets: 7, done: 2, free: 2 });
    expect(node(items, "sub").counts).toEqual({ tickets: 3, done: 1, free: 1 });
    expect(node(items, "b").counts).toBeUndefined();
  });

  it("pai sem ticket que conte (só ideias ou cancelados) não tem números", () => {
    const items = build([ticket("raiz", { progress: { done: 0, total: 0, excluded: 1 } }), ticket("x", { parentId: "raiz", status: "cancelled", place: null })]);
    expect(node(items, "raiz").counts).toBeUndefined();
  });
});

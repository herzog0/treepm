import { describe, expect, it } from "vitest";
import { explodedTree } from "./exploded-tree.js";
import type { DependencyEdge } from "./queue-place.js";
import type { OrderNode } from "./sibling-order.js";

// ADR 0070: a árvore explodida. Colunas de passo, cada ticket pendura no último ticket de que depende para começar, as linhas saem dessa
// árvore, e a dependência que aponta para fora do foco vira um card apagado.
let counter = 0;
const t = (id: string, parentId: string | null = null, extra: Partial<OrderNode> = {}): OrderNode => ({ id, parentId, number: ++counter, priority: 0, status: "todo", ...extra });
const start = (from: string, to: string): DependencyEdge => ({ from, to, need: "start" });
const deliver = (from: string, to: string): DependencyEdge => ({ from, to, need: "deliver" });
const layout = (tickets: OrderNode[], edges: DependencyEdge[], focusId: string | null = null) =>
  Object.fromEntries(explodedTree(tickets, edges, focusId).nodes.map((node) => [node.id, [node.column, node.row, node.hangOn, node.outside]]));

describe("explodedTree", () => {
  it("põe cada ticket na coluna do passo e pendura no ticket de que depende: uma corrente fica numa linha", () => {
    expect(layout([t("a"), t("b"), t("c")], [start("b", "a"), start("c", "b")])).toEqual({
      a: [0, 0, null, false],
      b: [1, 0, "a", false],
      c: [2, 0, "b", false],
    });
  });

  it("as folhas da árvore ocupam linhas seguidas e o pai fica no meio delas", () => {
    expect(layout([t("a"), t("b"), t("c"), t("d")], [start("b", "a"), start("c", "a"), start("d", "a")])).toEqual({
      a: [0, 1, null, false],
      b: [1, 0, "a", false],
      c: [1, 1, "a", false],
      d: [1, 2, "a", false],
    });
  });

  it("pendura no alvo de maior passo; no empate, no de menor número", () => {
    const tickets = [t("x"), t("y"), t("z"), t("w"), t("v")];
    const tree = layout(tickets, [start("y", "x"), start("z", "y"), start("z", "x"), start("v", "w"), start("v", "x")]);
    expect(tree["z"]![2]).toBe("y");
    expect(tree["v"]![2]).toBe("x");
  });

  it("raízes sem dependência ficam cada uma na sua linha, por coluna e número", () => {
    const tree = layout([t("a"), t("b")], []);
    expect(tree).toEqual({ a: [0, 0, null, false], b: [0, 1, null, false] });
  });

  it("'para entregar' não pendura nem muda a coluna", () => {
    expect(layout([t("a"), t("b")], [deliver("b", "a")])).toEqual({ a: [0, 0, null, false], b: [0, 1, null, false] });
  });

  it("entram só as folhas dentro do foco, sem ideias; o alvo de fora vira card apagado na coluna do passo dele, sem as dependências próprias", () => {
    const tickets = [
      t("antes"),
      t("fora"),
      t("pai"),
      t("f1", "pai"),
      t("f2", "pai"),
      t("ideia", "pai", { ideaStage: "new" }),
      t("dentro-da-ideia", "ideia"),
      t("entrega-fora"),
    ];
    const edges = [start("fora", "antes"), start("f1", "fora"), start("f2", "f1"), deliver("f2", "entrega-fora")];
    // A coluna 0 é o menor passo do que aparece: aqui o alvo de "para entregar", no passo 0.
    expect(layout(tickets, edges, "pai")).toEqual({
      "entrega-fora": [0, 0, null, true],
      fora: [1, 1, null, true],
      f1: [2, 1, "fora", false],
      f2: [3, 1, "f1", false],
    });
  });

  it("um pai que entra numa dependência é um nó: os de dentro ficam dobrados nele, e as dependências deles sobem para ele", () => {
    const tickets = [t("casca"), t("historia"), t("sub1", "historia"), t("sub2", "historia"), t("neto", "sub2"), t("solto")];
    const tree = explodedTree(tickets, [start("solto", "historia"), start("sub1", "casca"), start("neto", "sub1")], null);
    const of = Object.fromEntries(tree.nodes.map((node) => [node.id, node]));
    expect(Object.keys(of).sort()).toEqual(["casca", "historia", "solto"]);
    expect(of["historia"]).toMatchObject({ column: 1, hangOn: "casca", outside: false, inside: 3 });
    expect(of["solto"]).toMatchObject({ column: 2, hangOn: "historia", inside: 0 });
  });

  it("um pai sem dependência é só uma caixa: não é desenhado, e os de dentro dele entram", () => {
    const tickets = [t("fase"), t("a", "fase"), t("grupo", "fase"), t("b", "grupo")];
    const tree = layout(tickets, [start("b", "a")]);
    expect(tree).toEqual({ a: [0, 0, null, false], b: [1, 0, "a", false] });
  });

  it("o alvo de fora do foco sobe para o nó dele no projeto", () => {
    const tickets = [t("foco"), t("x", "foco"), t("outra"), t("o1", "outra"), t("o2", "outra")];
    const tree = layout(tickets, [start("x", "o1"), start("o2", "o1")], "foco");
    expect(tree).toEqual({ o1: [0, 0, null, true], x: [1, 0, "o1", false] });
  });

  it("o lugar na fila de cada nó sai do grafo de nós: livre, próximo, esperando; finalizado não tem", () => {
    const tickets = [t("pronto", null, { status: "done" }), t("a"), t("b"), t("c"), t("historia"), t("sub", "historia")];
    const edges = [start("a", "pronto"), start("b", "a"), start("c", "b"), start("historia", "pronto")];
    const places = Object.fromEntries(explodedTree(tickets, edges, null).nodes.map((node) => [node.id, node.place]));
    expect(places).toEqual({ pronto: null, a: "free", b: "next", c: "waiting", historia: "free" });
  });

  it("diz o tamanho da grade: colunas e linhas", () => {
    const tree = explodedTree([t("a"), t("b"), t("c")], [start("b", "a"), start("c", "a")], null);
    expect([tree.columns, tree.rows]).toEqual([2, 2]);
  });

  it("foco sem folhas: vazio", () => {
    expect(explodedTree([t("a")], [], "nada")).toEqual({ nodes: [], columns: 0, rows: 0 });
  });
});

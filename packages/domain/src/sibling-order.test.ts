import { describe, expect, it } from "vitest";
import { dependencySteps, enablers, inSiblingOrder } from "./sibling-order.js";
import type { OrderNode } from "./sibling-order.js";
import type { DependencyEdge } from "./queue-place.js";

// ADR 0069, seção 2: o passo de cada ticket, a ordem dos irmãos e o habilitador.
let counter = 0;
const t = (id: string, parentId: string | null = null, extra: Partial<OrderNode> = {}): OrderNode => ({ id, parentId, number: ++counter, priority: 0, status: "todo", ...extra });
const start = (from: string, to: string): DependencyEdge => ({ from, to, need: "start" });
const deliver = (from: string, to: string): DependencyEdge => ({ from, to, need: "deliver" });
const steps = (tickets: OrderNode[], edges: DependencyEdge[]) => Object.fromEntries(dependencySteps(tickets, edges));

describe("dependencySteps: o passo", () => {
  it("0 sem dependência para começar; 1 + o maior passo dos alvos nos outros casos", () => {
    expect(steps([t("a"), t("b"), t("c"), t("d")], [start("b", "a"), start("c", "b"), start("d", "a"), start("d", "c")])).toEqual({ a: 0, b: 1, c: 2, d: 3 });
  });

  it("dependência para entregar não conta", () => {
    expect(steps([t("a"), t("b")], [deliver("b", "a")])).toEqual({ a: 0, b: 0 });
  });

  it("conta a dependência mesmo com o alvo concluído: a ordem só muda quando uma dependência muda", () => {
    expect(steps([t("a", null, { status: "done" }), t("b")], [start("b", "a")])).toEqual({ a: 0, b: 1 });
  });

  it("um ticket com filhos tem o menor passo dentro dele, e as dependências próprias dele não contam", () => {
    const tickets = [t("x"), t("p"), t("c1", "p"), t("c2", "p"), t("q"), t("q1", "q")];
    expect(steps(tickets, [start("c1", "x"), start("c2", "c1"), start("p", "q"), start("q1", "c2")])).toEqual({ x: 0, p: 1, c1: 1, c2: 2, q: 3, q1: 3 });
  });

  it("depender de um pai é depender do passo dele", () => {
    const tickets = [t("x"), t("p"), t("c1", "p"), t("y")];
    expect(steps(tickets, [start("c1", "x"), start("y", "p")])).toMatchObject({ p: 1, y: 2 });
  });

  it("filho que é ideia fica fora do passo do pai; alvo fora da lista é ignorado", () => {
    const tickets = [t("x"), t("p"), t("i", "p", { ideaStage: "new" }), t("c", "p")];
    expect(steps(tickets, [start("c", "x"), start("i", "c"), start("x", "gone")])).toMatchObject({ x: 0, p: 1, c: 1, i: 2 });
  });

  it("um ciclo (que a API recusa) não trava a conta", () => {
    expect(Object.keys(steps([t("a"), t("b")], [start("a", "b"), start("b", "a")])).sort()).toEqual(["a", "b"]);
  });
});

const ids = (tickets: readonly OrderNode[]) => tickets.map((ticket) => ticket.id);
const under = (parent: string | null, tickets: readonly OrderNode[]) => ids(tickets.filter((ticket) => ticket.parentId === parent));

describe("inSiblingOrder: a ordem dos irmãos", () => {
  it("por passo, do menor para o maior", () => {
    const tickets = [t("p"), t("c", "p"), t("b", "p"), t("a", "p")];
    expect(under("p", inSiblingOrder(tickets, [start("c", "b"), start("b", "a")]))).toEqual(["a", "b", "c"]);
  });

  it("no empate, prioridade efetiva (maior primeiro, herdada do pai), depois número", () => {
    const tickets = [t("p"), t("a", "p"), t("b", "p", { priority: 5 }), t("c", "p"), t("q", "p", { priority: 9 }), t("q1", "q"), t("d", "p", { priority: -1 })];
    // q1 herda 9 de q; dentro de p: q (9), b (5), a e c (0, por número), d (-1).
    expect(under("p", inSiblingOrder(tickets, []))).toEqual(["q", "b", "a", "c", "d"]);
  });

  it("o passo vem antes da prioridade", () => {
    const tickets = [t("a"), t("b", null, { priority: 50 })];
    expect(under(null, inSiblingOrder(tickets, [start("b", "a")]))).toEqual(["a", "b"]);
  });

  it("devolve os mesmos tickets (os objetos de entrada), só em outra ordem", () => {
    const tickets = [t("p"), t("b", "p"), t("a", "p")];
    const ordered = inSiblingOrder(tickets, [start("b", "a")]);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered)).toEqual(new Set(tickets));
  });
});

describe("enablers: o habilitador", () => {
  const found = (tickets: OrderNode[], edges: DependencyEdge[]) => [...enablers(tickets, edges)].sort();

  it("é o filho de que um irmão depende para começar e que não depende de nenhum irmão para começar", () => {
    const tickets = [t("p"), t("casca", "p"), t("a", "p"), t("b", "p")];
    expect(found(tickets, [start("a", "casca"), start("b", "casca")])).toEqual(["casca"]);
  });

  it("não é habilitador quem também depende de um irmão para começar, nem o alvo de 'para entregar'", () => {
    const tickets = [t("p"), t("a", "p"), t("b", "p"), t("c", "p")];
    expect(found(tickets, [start("b", "a"), start("c", "b"), deliver("a", "c")])).toEqual(["a"]);
    expect(found([t("q"), t("x", "q"), t("y", "q")], [deliver("y", "x")])).toEqual([]);
  });

  it("dependência de fora do pai não conta, nem para o filho nem para o pai que o contém", () => {
    expect(found([t("p"), t("a", "p"), t("o")], [start("o", "a")])).toEqual([]);
  });

  it("um pai não vira habilitador porque um irmão depende de algo DENTRO dele: a ponta tem de ser ele mesmo", () => {
    const tickets = [t("catalogo"), t("fotos", "catalogo"), t("conta"), t("foto-perfil", "conta")];
    expect(found(tickets, [start("foto-perfil", "fotos")])).toEqual([]);
  });

  it("o habilitador já concluído ou cancelado não leva a marca: ele já abriu os irmãos", () => {
    const tickets = [t("p"), t("casca", "p", { status: "done" }), t("a", "p"), t("x", "p", { status: "cancelled" }), t("b", "p")];
    expect(found(tickets, [start("a", "casca"), start("b", "x")])).toEqual([]);
  });

  it("conta a dependência entre o que está DENTRO de dois irmãos", () => {
    const tickets = [t("p"), t("casca", "p"), t("secao", "p"), t("s1", "secao"), t("s2", "secao")];
    expect(found(tickets, [start("s1", "casca"), start("s2", "s1")])).toEqual(["casca", "s1"]);
  });

  it("vale também entre os tickets do topo do projeto", () => {
    expect(found([t("a"), t("b")], [start("b", "a")])).toEqual(["a"]);
  });
});

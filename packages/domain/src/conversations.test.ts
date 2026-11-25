import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MAX_DEPTH,
  assistantSpeaksIn,
  canOpenThreadBelow,
  canReadConversation,
  descendantIds,
  invariantViolations,
  newThreadParticipants,
  mentionsOpenThread,
  participantCountAfter,
  shownTree,
  visibleIds,
  visibleParentId,
  visibleTrail,
  visibleTree,
} from "./conversations.js";
import type { ConversationNode } from "./conversations.js";

const node = (id: string, parentId: string | null, ...people: string[]): ConversationNode => ({ id, parentId, participantIds: new Set(people) });
// Principal de O; D1 (O, Alice); D2 dentro de D1 (O, Alice, Bob); D3 irmã de D1 (O, Carol).
const tree = [node("main", null, "O"), node("d1", "main", "O", "alice"), node("d2", "d1", "O", "alice", "bob"), node("d3", "main", "O", "carol")];
const byId = new Map(tree.map((n) => [n.id, n]));

describe("quem lê uma conversa", () => {
  it("só quem participa, e nenhum papel entra na conta", () => {
    expect(canReadConversation("alice", byId.get("d1") as ConversationNode)).toBe(true);
    expect(canReadConversation("alice", byId.get("d3") as ConversationNode)).toBe(false);
    expect(canReadConversation.length).toBe(2);
  });
  it("o conjunto lido é fechado para baixo", () => {
    expect([...visibleIds("O", tree)].sort()).toEqual(["d1", "d2", "d3", "main"]);
    expect([...visibleIds("alice", tree)].sort()).toEqual(["d1", "d2"]);
    expect([...visibleIds("bob", tree)]).toEqual(["d2"]);
    expect([...visibleIds("zé", tree)]).toEqual([]);
  });
});

describe("o que fica acima do ponto de entrada não existe", () => {
  it("o pai só sai se a pessoa participa dele", () => {
    expect(visibleParentId("O", byId.get("d1") as ConversationNode, byId)).toBe("main");
    expect(visibleParentId("alice", byId.get("d1") as ConversationNode, byId)).toBeNull();
    expect(visibleParentId("bob", byId.get("d2") as ConversationNode, byId)).toBeNull();
    expect(visibleParentId("alice", byId.get("d2") as ConversationNode, byId)).toBe("d1");
  });
  it("a trilha começa onde a pessoa entra", () => {
    expect(visibleTrail("O", "d2", byId)).toEqual(["main", "d1"]);
    expect(visibleTrail("alice", "d2", byId)).toEqual(["d1"]);
    expect(visibleTrail("bob", "d2", byId)).toEqual([]);
  });
  it("a árvore da pessoa aninha pelo pai que ela lê", () => {
    expect([...visibleTree("bob", tree)]).toEqual([["d2", null]]);
    expect(Object.fromEntries(visibleTree("alice", tree))).toEqual({ d1: null, d2: "d1" });
    expect(Object.fromEntries(visibleTree("O", tree))).toEqual({ main: null, d1: "main", d2: "d1", d3: "main" });
  });
});

describe("a invariante e os limites", () => {
  it("filha inclui os da conversa de cima", () => {
    expect(invariantViolations(tree)).toEqual([]);
    expect(invariantViolations([node("a", null, "O", "x"), node("b", "a", "O")])).toEqual(["b"]);
  });
  it("as descendentes, sem a própria", () => {
    expect(descendantIds("d1", tree).sort()).toEqual(["d2"]);
    expect(descendantIds("main", tree).sort()).toEqual(["d1", "d2", "d3"]);
    expect(descendantIds("d2", tree)).toEqual([]);
  });
  it("a thread nova leva a dona, os de cima e os marcados, sem repetir", () => {
    expect(newThreadParticipants("O", ["O", "alice"], ["alice", "bob"]).sort()).toEqual(["O", "alice", "bob"]);
  });
  it("dez níveis", () => {
    expect(canOpenThreadBelow(CONVERSATION_MAX_DEPTH - 1)).toBe(true);
    expect(canOpenThreadBelow(CONVERSATION_MAX_DEPTH)).toBe(false);
    // o limite conta pela trilha visível; o teto técnico vale para todos
    expect(canOpenThreadBelow(2, 30)).toBe(true);
    expect(canOpenThreadBelow(2, 40)).toBe(false);
  });
  it("conta só quem é novo", () => {
    expect(participantCountAfter(new Set(["a", "b"]), ["b", "c"])).toBe(3);
  });
});

describe("onde o assistente fala (e, por isso, onde ele pode abrir um rascunho de ticket)", () => {
  it("nas conversas principais e nas threads de assunto, que são só de quem as abriu", () => {
    expect(assistantSpeaksIn({ kind: "general", purpose: null })).toBe(true);
    expect(assistantSpeaksIn({ kind: "ticket", purpose: null })).toBe(true);
    expect(assistantSpeaksIn({ kind: "thread", purpose: "topic" })).toBe(true);
  });
  it("nunca numa thread com pessoas nem na thread de criação", () => {
    expect(assistantSpeaksIn({ kind: "thread", purpose: "people" })).toBe(false);
    expect(assistantSpeaksIn({ kind: "thread", purpose: "creation" })).toBe(false);
    expect(assistantSpeaksIn({ kind: "thread", purpose: null })).toBe(false);
  });
});

describe("a árvore com conversas fechadas (ADR 0059)", () => {
  it("sem nada fechado é a mesma árvore de visibleTree", () => {
    for (const viewer of ["O", "alice", "bob", "carol", "ninguem"]) expect(shownTree(viewer, tree, new Set())).toEqual(visibleTree(viewer, tree));
  });
  it("a conversa fechada some, e a de dentro sobe para a mais próxima que aparece", () => {
    expect(shownTree("bob", tree, new Set(["d1"]))).toEqual(new Map([["d2", null]]));
    expect(shownTree("O", tree, new Set(["d1"]))).toEqual(
      new Map([
        ["main", null],
        ["d2", "main"],
        ["d3", "main"],
      ]),
    );
    expect(shownTree("O", tree, new Set(["d1", "main"])).get("d2")).toBeNull();
  });
  it("fechar não faz aparecer o que a pessoa não lê", () => {
    // Alice não lê main? lê: participa de main? não (main é só de O): d1 é a ponta dela.
    const t = [node("main", null, "O"), node("d1", "main", "O", "alice"), node("d2", "d1", "O", "alice", "bob")];
    expect(shownTree("alice", t, new Set(["d1"])).get("d2")).toBeNull();
    expect(shownTree("alice", t, new Set(["d1"])).has("main")).toBe(false);
    expect(shownTree("alice", t, new Set(["main"])).has("main")).toBe(false);
  });
  it("em árvore funda: a fechada no meio some e as de baixo sobem para a mais próxima aberta que a pessoa lê, sem pular uma que ela não lê", () => {
    // main(O) > a(O, alice) > b(O, alice, bob) > c(O, alice, bob, carol) > d(O, alice, bob, carol, dan) > e(O, alice, bob, carol, dan, eva)
    const deep = [
      node("main", null, "O"),
      node("a", "main", "O", "alice"),
      node("b", "a", "O", "alice", "bob"),
      node("c", "b", "O", "alice", "bob", "carol"),
      node("d", "c", "O", "alice", "bob", "carol", "dan"),
      node("e", "d", "O", "alice", "bob", "carol", "dan", "eva"),
    ];
    // O lê todas: fechando c, d sobe para b; fechando c e d, e sobe para b.
    expect(shownTree("O", deep, new Set(["c"])).get("d")).toBe("b");
    expect(shownTree("O", deep, new Set(["c", "d"])).get("e")).toBe("b");
    expect(shownTree("O", deep, new Set(["c", "d"])).has("c")).toBe(false);
    // Carol só entra em c: para ela, d e e descem de c; fechando c, d vira ponta de baixo e e continua sob d.
    expect(shownTree("carol", deep, new Set(["c"])).get("d")).toBeNull();
    expect(shownTree("carol", deep, new Set(["c"])).get("e")).toBe("d");
    // Fechar uma conversa abaixo de uma que a pessoa ainda não leu (aberta, só não lida) não muda o pai dela.
    expect(shownTree("O", deep, new Set(["e"])).get("d")).toBe("c");
    expect(shownTree("O", deep, new Set(["e"])).has("e")).toBe(false);
    // Fechar tudo no meio e depois a de cima: as de baixo sobem até a raiz que aparece, ou ficam como pontas.
    expect(shownTree("O", deep, new Set(["a", "b", "c"])).get("d")).toBe("main");
    expect(shownTree("O", deep, new Set(["main", "a", "b", "c"])).get("d")).toBeNull();
  });
});

describe("marcar pessoas: quando abre thread (ADR 0059)", () => {
  const here = new Set(["me", "ana"]);
  it("todas já participam: não abre", () => expect(mentionsOpenThread("me", ["ana"], here)).toBe(false));
  it("alguma de fora: abre", () => expect(mentionsOpenThread("me", ["ana", "bia"], here)).toBe(true));
  it("a própria pessoa não conta", () => {
    expect(mentionsOpenThread("me", ["me"], new Set(["me"]))).toBe(false);
    expect(mentionsOpenThread("me", ["me", "bia"], new Set(["me"]))).toBe(true);
  });
  it("conversa só dela: qualquer outra é de fora", () => expect(mentionsOpenThread("me", ["ana"], new Set(["me"]))).toBe(true));
});

import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MAX_DEPTH,
  canOpenThreadBelow,
  canReadConversation,
  descendantIds,
  invariantViolations,
  newThreadParticipants,
  participantCountAfter,
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

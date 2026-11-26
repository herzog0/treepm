import { describe, expect, it } from "vitest";
import { decideLinearLabelUpdate, decideLinearTicketLabels } from "./linear-labels.js";
import type { LinearTicketLabelRef } from "./linear-labels.js";

const ref = (linearLabelId: string, localId: string | null, extra: Partial<LinearTicketLabelRef> = {}): LinearTicketLabelRef => ({ linearLabelId, localId, removedHere: false, adopted: false, ...extra });

// ADR 0065, seção 5, e ADR 0061, seção 3: a regra das coisas que são muitas por ticket.
describe("decideLinearTicketLabels", () => {
  const resolve = new Map<string, string | null>([
    ["L1", "a"],
    ["L2", "b"],
    ["L3", "c"],
    ["Ldel", null],
  ]);

  it("posta no Linear chega (e cria a origem)", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1", "L2"], resolve, refs: [], current: [] });
    expect(out.add).toEqual(["a", "b"]);
    expect(out.remove).toEqual([]);
    expect(out.createRefs).toEqual([
      { linearLabelId: "L1", localId: "a", adopted: false },
      { linearLabelId: "L2", localId: "b", adopted: false },
    ]);
  });

  it("já posta aqui antes: a origem adota, sem mudança no ticket", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [], current: ["a"] });
    expect(out.add).toEqual([]);
    expect(out.createRefs).toEqual([{ linearLabelId: "L1", localId: "a", adopted: true }]);
  });

  it("sem mudança: nada a fazer (zero escritas)", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", "a")], current: ["a"] });
    expect(out).toEqual({ add: [], remove: [], createRefs: [], reviveRefs: [], forgetRefs: [], markRemovedHere: [], overLimit: 0, unresolved: 0 });
  });

  it("tirada no Linear sai daqui, se veio de lá", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: [], resolve, refs: [ref("L1", "a")], current: ["a", "z"] });
    expect(out.remove).toEqual(["a"]);
    expect(out.forgetRefs).toEqual(["L1"]);
  });

  it("tirada no Linear: a adotada (posta aqui) fica", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: [], resolve, refs: [ref("L1", "a", { adopted: true })], current: ["a"] });
    expect(out.remove).toEqual([]);
    expect(out.forgetRefs).toEqual(["L1"]);
  });

  it("tirada aqui não volta", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", null, { removedHere: true })], current: [] });
    expect(out.add).toEqual([]);
    expect(out.createRefs).toEqual([]);
  });

  it("posta aqui fica (o Linear não a conhece)", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", "a")], current: ["a", "z"] });
    expect(out.remove).toEqual([]);
  });

  it("tirada no Linear e posta de novo lá: volta", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", null)], current: [] });
    expect(out.add).toEqual(["a"]);
    expect(out.reviveRefs).toEqual([{ linearLabelId: "L1", localId: "a", adopted: false }]);
  });

  // Revisão E1, item 3: a origem que volta não guarda o `adopted` velho; vale o estado de AGORA.
  it("origem que volta com a etiqueta já posta aqui por alguém: adotada, mesmo que antes tenha vindo de lá", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", null, { adopted: false })], current: ["a"] });
    expect(out.add).toEqual([]);
    expect(out.reviveRefs).toEqual([{ linearLabelId: "L1", localId: "a", adopted: true }]);
  });

  it("origem que volta sem a etiqueta no ticket: veio de lá, mesmo que antes tenha sido adotada", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", null, { adopted: true })], current: [] });
    expect(out.add).toEqual(["a"]);
    expect(out.reviveRefs).toEqual([{ linearLabelId: "L1", localId: "a", adopted: false }]);
  });

  it("a origem ainda aponta mas a etiqueta não está no ticket: foi tirada aqui por um caminho sem marca; não volta e fica marcada", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", "a")], current: [] });
    expect(out.add).toEqual([]);
    expect(out.markRemovedHere).toEqual(["L1"]);
  });

  it("etiqueta apagada aqui (resolve nulo): não entra e não conta como não lida", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["Ldel"], resolve, refs: [], current: [] });
    expect(out.add).toEqual([]);
    expect(out.unresolved).toBe(0);
  });

  it("etiqueta sem nó nem origem conhecida: não lida, contada, nunca removida", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["Lunknown"], resolve, refs: [ref("Lunknown", "q")], current: ["q"] });
    expect(out.unresolved).toBe(1);
    expect(out.remove).toEqual([]);
    expect(out.forgetRefs).toEqual([]);
  });

  it("limite de 20 por ticket: o que passa não entra e é contado (sem origem, tenta de novo depois)", () => {
    const many = Array.from({ length: 25 }, (_, i) => `M${i}`);
    const big = new Map(many.map((id, i) => [id, `m${i}`] as const));
    const current = Array.from({ length: 18 }, (_, i) => `here${i}`);
    const out = decideLinearTicketLabels({ linearLabelIds: many, resolve: big, refs: [], current });
    expect(out.add).toHaveLength(2);
    expect(out.overLimit).toBe(23);
    expect(out.createRefs).toHaveLength(2);
  });

  it("ids repetidos contam uma vez", () => {
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1", "L1"], resolve, refs: [], current: [] });
    expect(out.add).toEqual(["a"]);
  });

  it("duas etiquetas do Linear que viraram a mesma daqui: entra uma vez", () => {
    const shared = new Map<string, string | null>([
      ["L1", "a"],
      ["L9", "a"],
    ]);
    const out = decideLinearTicketLabels({ linearLabelIds: ["L1", "L9"], resolve: shared, refs: [], current: [] });
    expect(out.add).toEqual(["a"]);
    expect(out.createRefs.map((r) => r.linearLabelId)).toEqual(["L1", "L9"]);
  });

  it("tirar no Linear uma de duas que viraram a mesma daqui: a outra segura", () => {
    const shared = new Map<string, string | null>([
      ["L1", "a"],
      ["L9", "a"],
    ]);
    const out = decideLinearTicketLabels({ linearLabelIds: ["L9"], resolve: shared, refs: [ref("L1", "a"), ref("L9", "a")], current: ["a"] });
    expect(out.remove).toEqual([]);
    expect(out.forgetRefs).toEqual(["L1"]);
  });
});

describe("decideLinearLabelUpdate", () => {
  it("renomeia e recolore quando o daqui ainda é o aplicado", () => {
    expect(decideLinearLabelUpdate({ current: { name: "Bug", color: "orange" }, applied: { name: "Bug", color: "orange" }, incoming: { name: "Defeito", color: "rose" } })).toEqual({ name: "Defeito", color: "rose" });
  });
  it("renomeado aqui segura o nome; a cor ainda acompanha", () => {
    expect(decideLinearLabelUpdate({ current: { name: "Meu bug", color: "orange" }, applied: { name: "Bug", color: "orange" }, incoming: { name: "Defeito", color: "rose" } })).toEqual({ color: "rose" });
  });
  it("cor trocada aqui segura a cor", () => {
    expect(decideLinearLabelUpdate({ current: { name: "Bug", color: "cyan" }, applied: { name: "Bug", color: "orange" }, incoming: { name: "Bug", color: "rose" } })).toEqual({});
  });
  it("sem mudança lá: nada", () => {
    expect(decideLinearLabelUpdate({ current: { name: "Bug", color: "orange" }, applied: { name: "Bug", color: "orange" }, incoming: { name: "Bug", color: "orange" } })).toEqual({});
  });
  it("só maiúsculas mudaram lá: renomeia (o nome exibido muda)", () => {
    expect(decideLinearLabelUpdate({ current: { name: "bug", color: "orange" }, applied: { name: "bug", color: "orange" }, incoming: { name: "Bug", color: "orange" } })).toEqual({ name: "Bug" });
  });
});

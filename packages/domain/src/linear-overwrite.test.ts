import { describe, expect, it } from "vitest";
import { decideLinearOverwrite, decideLinearStatusOverwrite, decideLinearTicketLabelsOverwrite, planLinearParentsConverging } from "./linear-overwrite.js";
import type { LinearTicketLabelRef } from "./linear-labels.js";

// ADR 0066: com "Sobrescrever com o Linear", o valor do Linear (já mapeado) vence o atual, mexido aqui ou não.
describe("decideLinearOverwrite", () => {
  it("sem a opção: vale a regra de sempre, nada sobrescrito", () => {
    expect(decideLinearOverwrite({ overwrite: false, incoming: "L", current: "aqui", regularApply: false })).toEqual({ apply: false, overwritten: false });
    expect(decideLinearOverwrite({ overwrite: false, incoming: "L", current: "aqui", regularApply: true })).toEqual({ apply: true, overwritten: false });
  });
  it("com a opção: difere do atual → aplica; só conta como sobrescrito o que a regra de sempre manteria", () => {
    expect(decideLinearOverwrite({ overwrite: true, incoming: "L", current: "aqui", regularApply: false })).toEqual({ apply: true, overwritten: true });
    expect(decideLinearOverwrite({ overwrite: true, incoming: "L", current: "aqui", regularApply: true })).toEqual({ apply: true, overwritten: false });
  });
  it("com a opção: igual ao atual → nada a aplicar", () => {
    expect(decideLinearOverwrite({ overwrite: true, incoming: "L", current: "L", regularApply: false })).toEqual({ apply: false, overwritten: false });
    expect(decideLinearOverwrite({ overwrite: true, incoming: ["b", "a"], current: ["a", "b"], regularApply: false })).toEqual({ apply: false, overwritten: false });
    expect(decideLinearOverwrite({ overwrite: true, incoming: null, current: null, regularApply: false })).toEqual({ apply: false, overwritten: false });
  });
  it("listas e nulos: o responsável que difere", () => {
    expect(decideLinearOverwrite({ overwrite: true, incoming: [], current: ["p1"], regularApply: false })).toEqual({ apply: true, overwritten: true });
    expect(decideLinearOverwrite({ overwrite: true, incoming: null, current: "2026-01-01", regularApply: false })).toEqual({ apply: true, overwritten: true });
  });
});

describe("decideLinearStatusOverwrite", () => {
  const base = { insideIdea: false, derived: false };
  it("mexido aqui: assume a do Linear e conta como sobrescrito", () => {
    const out = decideLinearStatusOverwrite({ ...base, desired: "in_progress", previousSource: "in_progress", current: "in_review", applied: "in_progress" });
    expect(out).toMatchObject({ outcome: "apply", target: "in_progress", touchedHere: true, overwritten: true, deviation: false });
  });
  it("mexido aqui e já igual à do Linear: nada", () => {
    const out = decideLinearStatusOverwrite({ ...base, desired: "done", previousSource: "todo", current: "done", applied: "todo" });
    expect(out).toMatchObject({ outcome: "none", target: "done", overwritten: false });
  });
  it("não mexido: a regra de sempre, sem contar sobrescrita", () => {
    const out = decideLinearStatusOverwrite({ ...base, desired: "done", previousSource: "todo", current: "todo", applied: "todo" });
    expect(out).toMatchObject({ outcome: "apply", target: "done", touchedHere: false, overwritten: false });
  });
  it("pai (ADR 0068): a situação sai dos filhos; a opção não se aplica, mesmo mexido aqui", () => {
    const out = decideLinearStatusOverwrite({ desired: "done", previousSource: "done", current: "in_progress", applied: "todo", insideIdea: false, derived: true });
    expect(out).toEqual({ outcome: "derived", target: "in_progress", touchedHere: false, changedInLinear: false, deviation: false, overwritten: false });
  });
  it("mexido aqui, concluído com dependência \"para entregar\" aberta: fica, em desvio", () => {
    const out = decideLinearStatusOverwrite({ ...base, desired: "done", previousSource: "done", current: "in_progress", applied: "todo", hasOpenDeliveries: true });
    expect(out).toMatchObject({ outcome: "blocked", target: "in_progress", deviation: true, overwritten: false });
  });
  it("mexido aqui, dentro de ideia: fica", () => {
    const out = decideLinearStatusOverwrite({ desired: "in_progress", previousSource: "in_progress", current: "todo", applied: "done", insideIdea: true, derived: false });
    expect(out).toMatchObject({ outcome: "blocked", target: "todo", overwritten: false });
  });
});

const ref = (linearLabelId: string, localId: string | null, extra: Partial<LinearTicketLabelRef> = {}): LinearTicketLabelRef => ({ linearLabelId, localId, removedHere: false, adopted: false, ...extra });
describe("decideLinearTicketLabelsOverwrite", () => {
  const resolve = new Map<string, string | null>([
    ["L1", "a"],
    ["L2", "b"],
    ["Ldel", null],
  ]);
  it("sem mudança: igual à regra de sempre, nada sobrescrito", () => {
    const out = decideLinearTicketLabelsOverwrite({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", "a")], current: ["a"] });
    expect(out).toMatchObject({ add: [], remove: [], restoreRefs: [], overwritten: false });
  });
  it("tirada aqui (marcada) volta, e a marca sai", () => {
    const out = decideLinearTicketLabelsOverwrite({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", null, { removedHere: true })], current: [] });
    expect(out.add).toEqual(["a"]);
    expect(out.reviveRefs).toEqual([{ linearLabelId: "L1", localId: "a", adopted: false }]);
    expect(out.restoreRefs).toEqual(["L1"]);
    expect(out.markRemovedHere).toEqual([]);
    expect(out.overwritten).toBe(true);
  });
  it("tirada aqui por um caminho sem marca: volta (não é marcada)", () => {
    const out = decideLinearTicketLabelsOverwrite({ linearLabelIds: ["L1"], resolve, refs: [ref("L1", "a")], current: [] });
    expect(out.add).toEqual(["a"]);
    expect(out.markRemovedHere).toEqual([]);
    expect(out.overwritten).toBe(true);
  });
  it("saiu no Linear: sai daqui, mesmo a adotada", () => {
    const out = decideLinearTicketLabelsOverwrite({ linearLabelIds: [], resolve, refs: [ref("L1", "a", { adopted: true })], current: ["a", "z"] });
    expect(out.remove).toEqual(["a"]);
    expect(out.forgetRefs).toEqual(["L1"]);
    expect(out.overwritten).toBe(true);
  });
  it("saiu no Linear e veio de lá: sai pela regra de sempre (não conta como sobrescrita)", () => {
    const out = decideLinearTicketLabelsOverwrite({ linearLabelIds: [], resolve, refs: [ref("L1", "a")], current: ["a"] });
    expect(out.remove).toEqual(["a"]);
    expect(out.overwritten).toBe(false);
  });
  it("etiqueta sem origem no Linear fica; etiqueta apagada aqui não renasce", () => {
    const out = decideLinearTicketLabelsOverwrite({ linearLabelIds: ["L1", "Ldel"], resolve, refs: [ref("L1", "a"), ref("Ldel", null, { removedHere: true })], current: ["a", "z"] });
    expect(out.add).toEqual([]);
    expect(out.remove).toEqual([]);
    expect(out.restoreRefs).toEqual([]);
    expect(out.overwritten).toBe(false);
  });
});

describe("planLinearParentsConverging", () => {
  it("o filho pedido antes do pai invertido: refaz o pulado depois do outro movimento e converge numa passada", () => {
    // Linear: G > P > C. Aqui: C na raiz, P embaixo de C. Pedidos na ordem C, P.
    const forest = new Map<string, string | null>([["G", null], ["C", null], ["P", "C"]]);
    const out = decideOrder(forest);
    expect(out.skipped).toEqual([]);
    expect(out.moves.map((move) => `${move.id}>${move.parentId}`)).toEqual(["P>G", "C>P"]);
  });
  it("ciclo de verdade continua pulado", () => {
    const forest = new Map<string, string | null>([["A", null], ["B", "A"]]);
    expect(planLinearParentsConverging(forest, [{ id: "A", parentId: "B" }], 20)).toEqual({ moves: [], skipped: ["A"] });
  });
});
const decideOrder = (forest: Map<string, string | null>) => planLinearParentsConverging(forest, [{ id: "C", parentId: "P" }, { id: "P", parentId: "G" }], 20);

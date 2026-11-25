import { describe, expect, it } from "vitest";
import { linearCreatorColumns, linearPreviousKeys } from "./linear-import.js";
import { decideLinearLateField, heldFieldsAfter } from "./linear-reimport.js";

// ADR 0061, seção 2: a regra do campo sem retrato. Tabela por situação.
type Input = Parameters<typeof decideLinearLateField>[0];
const base: Input = { hasSnapshot: false, held: false, changedInLinear: false, touchedHere: false, currentEmpty: true, incomingEmpty: false, incomingDiffers: true };

describe("decideLinearLateField (tabela)", () => {
  const cases: { name: string; input: Partial<Input>; expected: { action: string; apply: boolean; hold: boolean; kept: boolean } }[] = [
    { name: "sem retrato, vazio aqui, valor no Linear: preenche", input: {}, expected: { action: "fill", apply: true, hold: false, kept: false } },
    { name: "sem retrato, vazio aqui e vazio no Linear: só grava os dois lados", input: { incomingEmpty: true, incomingDiffers: false }, expected: { action: "synced", apply: false, hold: false, kept: false } },
    { name: "sem retrato, preenchido aqui com o mesmo valor: só grava os dois lados", input: { currentEmpty: false, incomingDiffers: false }, expected: { action: "synced", apply: false, hold: false, kept: false } },
    { name: "sem retrato, preenchido aqui e valor diferente no Linear: mantém o daqui e marca", input: { currentEmpty: false }, expected: { action: "hold", apply: false, hold: true, kept: true } },
    { name: "sem retrato, preenchido aqui e o Linear vazio: mantém o daqui e marca", input: { currentEmpty: false, incomingEmpty: true }, expected: { action: "hold", apply: false, hold: true, kept: true } },
    { name: "mantido daqui: o Linear mudou e não se aplica", input: { hasSnapshot: true, held: true, changedInLinear: true, currentEmpty: false }, expected: { action: "held", apply: false, hold: false, kept: true } },
    { name: "mantido daqui: o Linear não mudou, fica quieto", input: { hasSnapshot: true, held: true, currentEmpty: false, incomingDiffers: true }, expected: { action: "held", apply: false, hold: false, kept: false } },
    { name: "mantido daqui vence até um campo que ficou vazio aqui", input: { hasSnapshot: true, held: true, changedInLinear: true, currentEmpty: true }, expected: { action: "held", apply: false, hold: false, kept: true } },
    { name: "com retrato: mudou só no Linear, aplica", input: { hasSnapshot: true, changedInLinear: true }, expected: { action: "regular", apply: true, hold: false, kept: false } },
    { name: "com retrato: mudou nos dois, mantém", input: { hasSnapshot: true, changedInLinear: true, touchedHere: true }, expected: { action: "regular", apply: false, hold: false, kept: true } },
    { name: "com retrato: nada mudou", input: { hasSnapshot: true }, expected: { action: "regular", apply: false, hold: false, kept: false } },
    { name: "com retrato: mexido só aqui", input: { hasSnapshot: true, touchedHere: true }, expected: { action: "regular", apply: false, hold: false, kept: false } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(decideLinearLateField({ ...base, ...c.input })).toEqual(c.expected);
    });
  }
});

describe("heldFieldsAfter", () => {
  it("acrescenta sem repetir, em ordem, e ignora o que não é lista de textos", () => {
    expect(heldFieldsAfter(undefined, "description")).toEqual(["description"]);
    expect(heldFieldsAfter(["priority"], "description")).toEqual(["description", "priority"]);
    expect(heldFieldsAfter(["description"], "description")).toEqual(["description"]);
    expect(heldFieldsAfter("x", "assignees")).toEqual(["assignees"]);
    expect(heldFieldsAfter([1, "priority"], "assignees")).toEqual(["assignees", "priority"]);
  });
});

describe("linearCreatorColumns", () => {
  const ana = { id: "u-ana", name: "Ana Criadora" };
  it("com pessoa casada guarda só a pessoa e o id; o nome vem dela", () => {
    expect(linearCreatorColumns({ creator: ana, emailReadable: true, matchedPersonId: "p1", existingPersonId: null })).toEqual({ externalCreatorId: "u-ana", externalCreatorName: null, creatorPersonId: "p1" });
  });
  it("sem pessoa casada guarda o nome de exibição (cortado em 120)", () => {
    expect(linearCreatorColumns({ creator: { id: "u-z", name: "Z".repeat(300) }, emailReadable: true, matchedPersonId: null, existingPersonId: "p-antiga" })).toEqual({ externalCreatorId: "u-z", externalCreatorName: "Z".repeat(120), creatorPersonId: null });
  });
  it("e-mail ilegível nesta rodada: a pessoa que já estava casada fica; sem ela, vale o nome", () => {
    expect(linearCreatorColumns({ creator: ana, emailReadable: false, matchedPersonId: null, existingPersonId: "p1" })).toEqual({ externalCreatorId: "u-ana", externalCreatorName: null, creatorPersonId: "p1" });
    expect(linearCreatorColumns({ creator: ana, emailReadable: false, matchedPersonId: null, existingPersonId: null })).toEqual({ externalCreatorId: "u-ana", externalCreatorName: "Ana Criadora", creatorPersonId: null });
  });
  it("criador apagado no Linear: nada guardado; texto de controle sai do nome", () => {
    expect(linearCreatorColumns({ creator: null, emailReadable: true, matchedPersonId: "p1", existingPersonId: "p1" })).toEqual({ externalCreatorId: null, externalCreatorName: null, creatorPersonId: null });
    expect(linearCreatorColumns({ creator: { id: "u", name: "A\u0000b" }, emailReadable: true, matchedPersonId: null, existingPersonId: null }).externalCreatorName).toBe("Ab");
  });
});

describe("linearPreviousKeys", () => {
  it("limpa, tira repetidos e o identificador de hoje, e limita", () => {
    expect(linearPreviousKeys(["OPS-3", " OPS-3 ", "ENG-1", "", "OPS-\u00001"], "ENG-1")).toEqual(["OPS-3", "OPS-1"]);
    expect(linearPreviousKeys(Array.from({ length: 80 }, (_, i) => `K-${i}`), "X-1")).toHaveLength(50);
    expect(linearPreviousKeys(["A".repeat(300)], "X-1")[0]).toHaveLength(100);
  });
});

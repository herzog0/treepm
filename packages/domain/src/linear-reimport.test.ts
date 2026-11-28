import { describe, expect, it } from "vitest";
import { decideLinearField, decideLinearStatus, sameLinearValue } from "./linear-reimport.js";
import type { TicketStatus } from "./tickets.js";

// ADR 0060, seção 5: só se aplica o campo que mudou no Linear E não foi mexido no TreePM.
describe("decideLinearField (tabela)", () => {
  const cases: { name: string; incoming: unknown; previousSource: unknown; current: unknown; applied: unknown; expected: { changedInLinear: boolean; touchedHere: boolean; apply: boolean } }[] = [
    { name: "nada mudou em lugar nenhum", incoming: "a", previousSource: "a", current: "a", applied: "a", expected: { changedInLinear: false, touchedHere: false, apply: false } },
    { name: "mudou só no Linear: aplica", incoming: "b", previousSource: "a", current: "a", applied: "a", expected: { changedInLinear: true, touchedHere: false, apply: true } },
    { name: "mexido só aqui: mantém", incoming: "a", previousSource: "a", current: "c", applied: "a", expected: { changedInLinear: false, touchedHere: true, apply: false } },
    { name: "mudou nos dois: mantém o daqui", incoming: "b", previousSource: "a", current: "c", applied: "a", expected: { changedInLinear: true, touchedHere: true, apply: false } },
    { name: "o TreePM aplicou valor diferente do que veio e o Linear não mudou: não oscila", incoming: "done", previousSource: "done", current: "todo", applied: "todo", expected: { changedInLinear: false, touchedHere: false, apply: false } },
    { name: "mudou no Linear e o TreePM está no valor aplicado (diferente do de origem): aplica", incoming: "x", previousSource: "done", current: "todo", applied: "todo", expected: { changedInLinear: true, touchedHere: false, apply: true } },
    { name: "volta ao valor antigo no Linear depois de mexido aqui: nada (o retrato de origem acompanha)", incoming: "a", previousSource: "b", current: "c", applied: "a", expected: { changedInLinear: true, touchedHere: true, apply: false } },
    { name: "números", incoming: 300, previousSource: 200, current: 200, applied: 200, expected: { changedInLinear: true, touchedHere: false, apply: true } },
    { name: "nulo para valor (responsável)", incoming: ["p1"], previousSource: [], current: [], applied: [], expected: { changedInLinear: true, touchedHere: false, apply: true } },
    { name: "conjuntos sem ordem: mesma coisa", incoming: ["b", "a"], previousSource: ["a", "b"], current: ["b", "a"], applied: ["a", "b"], expected: { changedInLinear: false, touchedHere: false, apply: false } },
    { name: "responsável tirado aqui: mexido", incoming: ["p1"], previousSource: ["p1"], current: [], applied: ["p1"], expected: { changedInLinear: false, touchedHere: true, apply: false } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(decideLinearField({ incoming: c.incoming, previousSource: c.previousSource, current: c.current, applied: c.applied })).toEqual(c.expected);
    });
  }
});

describe("sameLinearValue", () => {
  it("compara texto, número, nulo e conjuntos", () => {
    expect(sameLinearValue("a", "a")).toBe(true);
    expect(sameLinearValue("a", "b")).toBe(false);
    expect(sameLinearValue(null, null)).toBe(true);
    expect(sameLinearValue(null, "")).toBe(false);
    expect(sameLinearValue(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameLinearValue(["a"], ["a", "b"])).toBe(false);
    expect(sameLinearValue(0, 0)).toBe(true);
  });
});

import { reimportedStatus } from "./linear-reimport.js";
describe("reimportedStatus (invariantes)", () => {
  it("dentro de ideia a situação não muda", () => {
    expect(reimportedStatus({ target: "done", current: "todo", insideIdea: true })).toBe("todo");
  });
  it("fora de ideia vale como veio", () => {
    expect(reimportedStatus({ target: "done", current: "todo", insideIdea: false })).toBe("done");
    expect(reimportedStatus({ target: "cancelled", current: "in_progress", insideIdea: false })).toBe("cancelled");
  });
});

// L14: a situação converge. Desejada = a do Linear mapeada; mexida aqui = atual ≠ aplicada; só uma invariante a impede, e então o
// ticket fica em desvio (aplicada ≠ desejada) e é reavaliado em toda reimportação.
describe("decideLinearStatus (tabela)", () => {
  type Row = { name: string; desired: TicketStatus; previousSource: TicketStatus; current: TicketStatus; applied: TicketStatus; insideIdea?: boolean; derived?: boolean; hasOpenDeliveries?: boolean; expected: ReturnType<typeof decideLinearStatus> };
  const cases: Row[] = [
    { name: "tudo igual: nada", desired: "todo", previousSource: "todo", current: "todo", applied: "todo", expected: { touchedHere: false, changedInLinear: false, outcome: "none", target: "todo", deviation: false } },
    { name: "Linear mudou e ninguém mexeu: aplica", desired: "done", previousSource: "todo", current: "todo", applied: "todo", expected: { touchedHere: false, changedInLinear: true, outcome: "apply", target: "done", deviation: false } },
    { name: "mexido aqui: não toca (e conta mexido quando o Linear mudou)", desired: "done", previousSource: "todo", current: "in_progress", applied: "todo", expected: { touchedHere: true, changedInLinear: true, outcome: "kept", target: "in_progress", deviation: false } },
    { name: "mexido aqui e o Linear não mudou: não toca, nada a contar", desired: "todo", previousSource: "todo", current: "in_progress", applied: "todo", expected: { touchedHere: true, changedInLinear: false, outcome: "kept", target: "in_progress", deviation: false } },
    { name: "desvio sem mudança no Linear: assume a desejada", desired: "done", previousSource: "done", current: "todo", applied: "todo", expected: { touchedHere: false, changedInLinear: false, outcome: "apply", target: "done", deviation: false } },
    { name: "dentro de ideia: não muda e fica em desvio", desired: "done", previousSource: "todo", current: "todo", applied: "todo", insideIdea: true, expected: { touchedHere: false, changedInLinear: true, outcome: "blocked", target: "todo", deviation: true } },
    // ADR 0068: a situação de um pai sai dos filhos; a da issue-mãe do Linear não é copiada, não é desvio nem "mexido aqui".
    { name: "pai (situação calculada): não aplica, não é desvio nem mexido aqui", desired: "done", previousSource: "todo", current: "in_progress", applied: "todo", derived: true, expected: { touchedHere: false, changedInLinear: true, outcome: "derived", target: "in_progress", deviation: false } },
    { name: "pai igual ao Linear: também é só calculado", desired: "todo", previousSource: "todo", current: "todo", applied: "todo", derived: true, expected: { touchedHere: false, changedInLinear: false, outcome: "derived", target: "todo", deviation: false } },
    // ADR 0068: dependência "para entregar" aberta barra o concluído vindo do Linear, como na tela; cancelar continua livre.
    { name: "concluído com dependência para entregar aberta: fica como está e em desvio", desired: "done", previousSource: "todo", current: "in_progress", applied: "in_progress", hasOpenDeliveries: true, expected: { touchedHere: false, changedInLinear: true, outcome: "blocked", target: "in_progress", deviation: true } },
    { name: "cancelado com dependência para entregar aberta: aplica (cancelar continua livre)", desired: "cancelled", previousSource: "todo", current: "todo", applied: "todo", hasOpenDeliveries: true, expected: { touchedHere: false, changedInLinear: true, outcome: "apply", target: "cancelled", deviation: false } },
    { name: "pai com dependência para entregar aberta: calculado vence (não é desvio)", desired: "done", previousSource: "todo", current: "in_progress", applied: "in_progress", derived: true, hasOpenDeliveries: true, expected: { touchedHere: false, changedInLinear: true, outcome: "derived", target: "in_progress", deviation: false } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(decideLinearStatus({ desired: c.desired, previousSource: c.previousSource, current: c.current, applied: c.applied, insideIdea: c.insideIdea ?? false, derived: c.derived ?? false, hasOpenDeliveries: c.hasOpenDeliveries ?? false })).toEqual(c.expected);
    });
  }
});

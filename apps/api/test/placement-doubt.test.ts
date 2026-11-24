import { describe, expect, it } from "vitest";
import { MAX_LEVELS } from "../src/assistant/placement-search.js";
import { DEFAULT_DOUBT, findDoubt } from "../src/assistant/placement-doubt.js";
import type { DoubtConfig, DoubtStepInput } from "../src/assistant/placement-doubt.js";

const cfg: DoubtConfig = { low: 0.2, high: 0.8, choice: 0.5 };
const step = (level: number, parentId: string | null, belongs: number | null, candidates: Record<string, number>, result?: DoubtStepInput["result"]): DoubtStepInput => ({
  level,
  parentId,
  belongs,
  result: result ?? (belongs === null ? "no_candidates" : belongs < 0.3 ? "below_low" : belongs <= 0.7 ? "band" : "descended"),
  candidates: Object.entries(candidates).map(([ticketId, probability]) => ({ ticketId, probability })),
});

describe("findDoubt — os tipos de dúvida (ADR 0054, item 1)", () => {
  it("o padrão é a faixa de 0,2 a 0,8 e a escolha abaixo de 0,5", () => {
    expect(DEFAULT_DOUBT).toEqual({ low: 0.2, high: 0.8, choice: 0.5 });
  });

  it("(a) raiz sem aviso: o primeiro nível abaixo de 0,3 e o destino na raiz é a dúvida `root`", () => {
    const steps = [step(1, null, 0.1, { A: 0.9, B: 0.1 })];
    expect(findDoubt({ steps, walk: [null], stoppedEarly: null }, cfg)).toEqual({ level: 1, parentId: null, kind: "root" });
  });

  it("raiz com belongs entre a faixa e 0,3 (0,25 com faixa 0,2–0,8) vira `fit`; com a faixa 0,3–0,7 vira `root`", () => {
    const steps = [step(1, null, 0.25, { A: 0.9, B: 0.1 })];
    expect(findDoubt({ steps, walk: [null], stoppedEarly: null }, cfg)?.kind).toBe("fit");
    expect(findDoubt({ steps, walk: [null], stoppedEarly: null }, { low: 0.3, high: 0.7, choice: 0 })?.kind).toBe("root");
  });

  it("abaixo de 0,3 num nível que não é a raiz é parada confiante: sem dúvida", () => {
    const steps = [step(1, null, 0.95, { A: 0.95, B: 0.05 }), step(2, "A", 0.05, { C: 1 })];
    expect(findDoubt({ steps, walk: [null, "A"], stoppedEarly: null }, cfg)).toBeNull();
  });

  it("(b) pai de poucos filhos na faixa do meio: `fit` no nível do pai", () => {
    const steps = [step(1, null, 0.95, { A: 0.95, B: 0.05 }), step(2, "A", 0.5, { C: 1 })];
    expect(findDoubt({ steps, walk: [null, "A", "C"], stoppedEarly: null }, cfg)).toEqual({ level: 2, parentId: "A", kind: "fit" });
  });

  it("(c) descida confiante em todos os níveis: nenhuma dúvida", () => {
    const steps = [step(1, null, 0.95, { A: 0.95, B: 0.05 }), step(2, "A", 0.9, { C: 0.9, D: 0.1 }), step(3, "C", 0.05, { E: 1 })];
    expect(findDoubt({ steps, walk: [null, "A", "C"], stoppedEarly: null }, cfg)).toBeNull();
  });

  it("`which`: desce, há mais de um candidato e o escolhido está abaixo da escolha (estritamente)", () => {
    const steps = [step(1, null, 0.95, { A: 0.45, B: 0.4, C: 0.15 })];
    expect(findDoubt({ steps, walk: [null, "A"], stoppedEarly: null }, cfg)).toEqual({ level: 1, parentId: null, kind: "which" });
    expect(findDoubt({ steps: [step(1, null, 0.95, { A: 0.5, B: 0.5 })], walk: [null, "A"], stoppedEarly: null }, cfg)).toBeNull();
  });

  it("`which` não vale com um candidato só, nem com escolha 0", () => {
    expect(findDoubt({ steps: [step(1, null, 0.95, { A: 0.4 })], walk: [null, "A"], stoppedEarly: null }, cfg)).toBeNull();
    expect(findDoubt({ steps: [step(1, null, 0.95, { A: 0.4, B: 0.3 })], walk: [null, "A"], stoppedEarly: null }, { ...cfg, choice: 0 })).toBeNull();
  });

  it("os limites da faixa são inclusivos: 0,2 e 0,8 são `fit`", () => {
    for (const belongs of [0.2, 0.8]) {
      expect(findDoubt({ steps: [step(1, null, belongs, { A: 0.9, B: 0.1 })], walk: [null, "A"], stoppedEarly: null }, cfg)?.kind).toBe("fit");
    }
    expect(findDoubt({ steps: [step(1, null, 0.81, { A: 0.9, B: 0.1 })], walk: [null, "A"], stoppedEarly: null }, cfg)).toBeNull();
  });

  it("`fit` vence `which` no mesmo nível; o mais raso vence o mais fundo", () => {
    const steps = [step(1, null, 0.5, { A: 0.4, B: 0.4 }), step(2, "A", 0.5, { C: 1 })];
    expect(findDoubt({ steps, walk: [null, "A", "C"], stoppedEarly: null }, cfg)).toEqual({ level: 1, parentId: null, kind: "fit" });
  });

  it("só os passos do caminho mantido contam: o passo de um ramo descartado é ignorado", () => {
    const steps = [step(1, null, 0.95, { A: 0.9, B: 0.1 }), step(2, "A", 0.9, { C: 1 }), step(2, "B", 0.5, { D: 1 })];
    expect(findDoubt({ steps, walk: [null, "A", "C"], stoppedEarly: null }, cfg)).toBeNull();
  });

  it("`interrupted`: nível grande demais (passo `too_large`) e limite de níveis", () => {
    const tooLarge = [step(1, null, 0.95, { A: 0.9, B: 0.1 }), step(2, "A", null, {}, "too_large")];
    expect(findDoubt({ steps: tooLarge, walk: [null, "A"], stoppedEarly: { reason: "candidates_too_large", level: 2, parentId: "A" } }, cfg)).toEqual({ level: 2, parentId: "A", kind: "interrupted" });
    const deep = [step(1, null, 0.95, { A: 0.9, B: 0.1 })];
    expect(findDoubt({ steps: deep, walk: [null, "A"], stoppedEarly: { reason: "max_levels", level: MAX_LEVELS, parentId: "A" } }, cfg)).toEqual({ level: 2, parentId: "A", kind: "interrupted" });
  });

  it("`related`: escolha sem confiança ou indisponível; com confiança, não", () => {
    const steps = [step(1, null, 0.95, { A: 0.95, B: 0.05 })];
    const related = (rule: "related_choice" | "choice_unavailable", choiceTop: number | null) => ({ steps, walk: [null, "A"], stoppedEarly: null, related: { rule, choiceTop, parentId: "A", level: 2 } });
    expect(findDoubt(related("related_choice", 0.4), cfg)).toEqual({ level: 2, parentId: "A", kind: "related" });
    expect(findDoubt(related("choice_unavailable", null), cfg)).toEqual({ level: 2, parentId: "A", kind: "related" });
    expect(findDoubt(related("related_choice", 0.9), cfg)).toBeNull();
    expect(findDoubt({ steps, walk: [null, "A"], stoppedEarly: null, related: { rule: "related_within", choiceTop: null, parentId: "A", level: 2 } }, cfg)).toBeNull();
  });

  it("`related` mais raso que a dúvida da descida vence", () => {
    const steps = [step(1, null, 0.95, { A: 0.95, B: 0.05 }), step(2, "A", 0.5, { C: 1 })];
    const found = findDoubt({ steps, walk: [null, "A", "C"], stoppedEarly: null, related: { rule: "choice_unavailable", choiceTop: null, parentId: null, level: 1 } }, cfg);
    expect(found).toEqual({ level: 1, parentId: null, kind: "related" });
  });

  it("`levelOffset` leva o nível da busca para a profundidade na árvore (partida em ramo ou escopo)", () => {
    const steps = [step(1, "S", 0.5, { C: 1 })];
    expect(findDoubt({ steps, walk: ["S", "C"], stoppedEarly: null, levelOffset: 2 }, cfg)).toEqual({ level: 3, parentId: "S", kind: "fit" });
  });

  it("sem candidatos (nada a perguntar) nunca é dúvida", () => {
    expect(findDoubt({ steps: [step(1, null, null, {}, "no_candidates")], walk: [null], stoppedEarly: null }, cfg)).toBeNull();
  });
});

describe("findDoubt — relacionados (Revisão 1, item 6)", () => {
  it("`related_choice` confiante não gera pergunta nem `which` com as probabilidades da descida no ponto de divergência", () => {
    // A descida foi por A (0,6) e B (0,4); os relacionados levaram a escolha para outro ramo (X) com confiança.
    const steps = [step(1, null, 0.95, { A: 0.6, B: 0.4 }), step(2, "A", 0.9, { C: 0.9, D: 0.1 })];
    const related = { rule: "related_choice" as const, choiceTop: 0.9, parentId: null, level: 1 };
    expect(findDoubt({ steps, walk: [null, "X", "Y"], stoppedEarly: null, related, divergence: { parentId: null } }, cfg)).toBeNull();
    // O ramo confirmado da descida (A, C) segue valendo, sem dúvida nenhuma, mesmo com relacionado em outro ramo.
    expect(findDoubt({ steps: [step(1, null, 0.95, { A: 0.9, B: 0.1 }), step(2, "A", 0.9, { C: 1 })], walk: [null, "A", "C"], stoppedEarly: null, related }, cfg)).toBeNull();
  });

  describe("a bifurcação é entre o destino da descida e o vencedor, não o ancestral de todas as opções", () => {
    // Raiz com A, B; em A, A1 (descida) e A2. A escolha dos relacionados é entre A1, A2 e B (ancestral comum: a raiz).
    const stepsWith = (rootA: number) => [step(1, null, 0.95, { A: rootA, B: 0.2 }), step(2, "A", 0.9, { A1: 0.8, A2: 0.1 })];
    const related = { rule: "related_choice" as const, choiceTop: 0.9, parentId: null, level: 1 };

    it("vencedor A2: o `which` de A (A2 com 0,1) é ignorado; o da raiz, não", () => {
      expect(findDoubt({ steps: stepsWith(0.9), walk: [null, "A", "A2"], stoppedEarly: null, related, divergence: { parentId: "A" } }, cfg)).toBeNull();
      expect(findDoubt({ steps: stepsWith(0.3), walk: [null, "A", "A2"], stoppedEarly: null, related, divergence: { parentId: "A" } }, cfg)).toEqual({ level: 1, parentId: null, kind: "which" });
    });

    it("vencedor A1 (o da descida): não há bifurcação e o `which` da raiz (A com 0,3) continua valendo", () => {
      expect(findDoubt({ steps: stepsWith(0.3), walk: [null, "A", "A1"], stoppedEarly: null, related, divergence: null }, cfg)).toEqual({ level: 1, parentId: null, kind: "which" });
      expect(findDoubt({ steps: stepsWith(0.9), walk: [null, "A", "A1"], stoppedEarly: null, related, divergence: null }, cfg)).toBeNull();
    });
  });

  it("um relacionado em outro ramo não cala a dúvida do caminho mantido: `fit` abaixo da divergência (raiz → Auth → SSO, cabe em Auth = 0,5)", () => {
    const steps = [step(1, null, 0.95, { Auth: 0.9, Billing: 0.1 }), step(2, "Auth", 0.5, { SSO: 0.9 })];
    const related = { rule: "related_choice" as const, choiceTop: 0.9, parentId: null, level: 1 };
    // A escolha confiante ficou com SSO, o destino da própria descida.
    expect(findDoubt({ steps, walk: [null, "Auth", "SSO"], stoppedEarly: null, related }, cfg)).toEqual({ level: 2, parentId: "Auth", kind: "fit" });
  });

  it("nível grande demais abaixo da divergência também vale", () => {
    const steps = [step(1, null, 0.95, { Auth: 0.9, Billing: 0.1 }), step(2, "Auth", null, {}, "too_large")];
    const related = { rule: "related_choice" as const, choiceTop: 0.9, parentId: null, level: 1 };
    expect(findDoubt({ steps, walk: [null, "Auth"], stoppedEarly: null, related }, cfg)).toEqual({ level: 2, parentId: "Auth", kind: "interrupted" });
  });

  it("`related_choice` não confiante e `choice_unavailable` geram `related`", () => {
    const steps = [step(1, null, 0.95, { A: 0.95, B: 0.05 })];
    for (const [rule, top] of [["related_choice", 0.3], ["choice_unavailable", null]] as const) {
      expect(findDoubt({ steps, walk: [null, "A"], stoppedEarly: null, related: { rule, choiceTop: top, parentId: null, level: 1 } }, cfg)).toEqual({ level: 1, parentId: null, kind: "related" });
    }
  });

  it("`related_ancestor` fraco gera `related` (inclusive o que tira o ticket da raiz); confiante, não", () => {
    const steps = [step(1, null, 0.1, { A: 0.9, B: 0.1 })];
    const base = { steps, walk: [null, "A"], stoppedEarly: null } as const;
    expect(findDoubt({ ...base, related: { rule: "related_ancestor", choiceTop: null, weak: true, parentId: null, level: 1 } }, cfg)).toEqual({ level: 1, parentId: null, kind: "related" });
    expect(findDoubt({ ...base, related: { rule: "related_ancestor", choiceTop: null, weak: false, parentId: null, level: 1 } }, cfg)).toBeNull();
  });
});

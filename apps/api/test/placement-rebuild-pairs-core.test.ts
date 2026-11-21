import { noul } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { descriptionExcerpt } from "@treepm/domain";
import { buildJudgeRequest } from "../src/assistant/jev-branch-judge.js";
import { JEV_MODEL, JEV_SCOPE_FALSE, JEV_SCOPE_QUESTION, JEV_SCOPE_TRUE } from "../src/assistant/prompts.js";
import {
  W1_FALSE,
  W1_QUESTION,
  W1_TRUE,
  W2_FALSE,
  W2_QUESTION,
  W2_TRUE,
  buildPairs,
  buildW0Request,
  buildW12Request,
  candidateState,
  pairsStats,
  renderPairsReport,
  summaryKey,
} from "../scripts/placement-rebuild/pairs-core.js";
import type { PairRecord, PairType, SummaryRecord } from "../scripts/placement-rebuild/pairs-core.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import { tickets } from "./pairs-fixture.js";

describe("buildPairs: os quatro tipos de par", () => {
  const { tested, pairs } = buildPairs(tickets);
  const of = (testedTitle: string, pair?: PairType) => pairs.filter((p) => p.tested.title === testedTitle && (pair === undefined || p.pair === pair));

  it("testados: os tickets que têm pai, na ordem do número; pares: 32 no total", () => {
    expect(tested.map((t) => t.title)).toEqual(["Cobrar no cartão", "Estornar cobrança", "Emitir recibo", "Entrar com senha", "Relatório mensal", "Relatório anual"]);
    expect(pairs).toHaveLength(32);
    expect(new Set(pairs.map((p) => p.key)).size).toBe(32);
  });

  it("parent e parent_as_leaf: o pai real (G), uma vez cada; sibling: os outros filhos de G; other_parent: as outras raízes que têm filhos", () => {
    expect(of("Cobrar no cartão", "parent").map((p) => p.candidate.title)).toEqual(["Pagamentos"]);
    expect(of("Cobrar no cartão", "parent_as_leaf").map((p) => p.candidate.title)).toEqual(["Pagamentos"]);
    expect(of("Cobrar no cartão", "sibling").map((p) => p.candidate.title)).toEqual(["Estornar cobrança", "Emitir recibo"]);
    // Acesso e Relatórios têm filhos; Solto (sem filhos) e Pagamentos (o pai) ficam de fora.
    expect(of("Cobrar no cartão", "other_parent").map((p) => p.candidate.title)).toEqual(["Acesso", "Relatórios"]);
  });

  it("o texto do parent vem de um resumo escrito SEM o testado; o dos outros é título + trecho da descrição", () => {
    const parent = of("Cobrar no cartão", "parent")[0];
    expect(parent?.leafFallback).toBe(false);
    expect(parent?.candidate.text).toEqual({
      kind: "summary",
      input: { title: "Pagamentos", descriptionExcerpt: "Cobrar e estornar", children: [{ title: "Estornar cobrança", summary: null }, { title: "Emitir recibo", summary: null }] },
    });
    expect(of("Cobrar no cartão", "parent_as_leaf")[0]?.candidate.text).toEqual({ kind: "excerpt", excerpt: "Cobrar e estornar" });
    expect(of("Cobrar no cartão", "sibling")[0]?.candidate.text).toEqual({ kind: "excerpt", excerpt: "" });
    expect(of("Cobrar no cartão", "sibling")[1]?.candidate.text).toEqual({ kind: "excerpt", excerpt: descriptionExcerpt("palavra ".repeat(120)) });
    // other_parent: o resumo vê TODOS os filhos da outra raiz.
    expect(of("Cobrar no cartão", "other_parent")[1]?.candidate.text).toEqual({
      kind: "summary",
      input: { title: "Relatórios", descriptionExcerpt: "", children: [{ title: "Relatório mensal", summary: null }, { title: "Relatório anual", summary: null }] },
    });
  });

  it("G com um só filho: o parent usa o texto de ticket sem filhos e fica marcado", () => {
    const parent = of("Entrar com senha", "parent")[0];
    expect(parent?.leafFallback).toBe(true);
    expect(parent?.candidate.text).toEqual({ kind: "excerpt", excerpt: "Entrar no sistema" });
    expect(of("Entrar com senha", "sibling")).toHaveLength(0);
    expect(of("Entrar com senha", "parent_as_leaf")[0]?.leafFallback).toBe(false);
    expect(of("Cobrar no cartão", "parent")[0]?.leafFallback).toBe(false);
  });

  it("--limit corta os testados, não os pares de um testado", () => {
    const limited = buildPairs(tickets, 2);
    expect(limited.tested.map((t) => t.title)).toEqual(["Cobrar no cartão", "Estornar cobrança"]);
    expect(limited.pairs).toHaveLength(12);
  });

  it("a chave do resumo depende só do conteúdo", () => {
    const a = { title: "A", descriptionExcerpt: "", children: [{ title: "x", summary: null }] };
    expect(summaryKey(a)).toBe(summaryKey({ ...a, children: [{ title: "x", summary: null }] }));
    expect(summaryKey(a)).not.toBe(summaryKey({ ...a, children: [{ title: "y", summary: null }] }));
    expect(summaryKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("requisições ao Jev", () => {
  const draft = { title: "Cobrar no cartão", description: "Cobrança por cartão" };

  it("W0 é a requisição de escopo da produção: textos de hoje, candidato no campo scope", () => {
    const withChildren = buildW0Request(draft, { title: "Pagamentos", text: "Resumo de pagamentos", hasChildren: true });
    expect(withChildren).toEqual({
      model: JEV_MODEL,
      state: { draft, scope: { title: "Pagamentos", summary: "Resumo de pagamentos" } },
      questions: { scope: noul(JEV_SCOPE_QUESTION, { true: JEV_SCOPE_TRUE, false: JEV_SCOPE_FALSE }) },
    });
    const production = buildJudgeRequest({ draft, current: null, candidates: [], scope: { id: "x", title: "Pagamentos", summary: "Resumo de pagamentos", hasChildren: true } });
    expect(withChildren).toEqual(production.request);
    const leaf = buildW0Request(draft, { title: "Cobrar", text: "Trecho", hasChildren: false });
    expect(leaf.state).toEqual({ draft, scope: { title: "Cobrar", description: "Trecho" } });
    expect(buildW0Request(draft, { title: "Cobrar", text: "", hasChildren: false }).state).toEqual({ draft, scope: { title: "Cobrar" } });
  });

  it("W1 e W2 batem letra por letra com o brief", () => {
    expect(W1_QUESTION).toBe("O ticket `candidate` só pode ser dado por pronto depois que o trabalho descrito em `draft` estiver feito?");
    expect(W1_TRUE).toBe(
      "O trabalho de `draft` é uma parte de `candidate` ou uma etapa de que `candidate` depende: enquanto `draft` não estiver feito, `candidate` não está completo.",
    );
    expect(W1_FALSE).toBe(
      "O ticket `candidate` pode ser concluído sem `draft`: os dois são trabalhos separados, mesmo que tratem do mesmo assunto, ou é `draft` que depende de `candidate`.",
    );
    expect(W2_QUESTION).toBe("O trabalho descrito em `draft` é uma parte do trabalho descrito no ticket `candidate`?");
    expect(W2_TRUE).toBe("O trabalho de `draft` é um pedaço de `candidate`: faz parte do que `candidate` promete entregar.");
    expect(W2_FALSE).toBe(
      "O trabalho de `draft` não é um pedaço de `candidate`: é um trabalho separado, mesmo que trate do mesmo assunto, ou é maior que `candidate`.",
    );
  });

  it("W1 e W2 vão juntas, em outra requisição: estado draft + candidate, duas perguntas", () => {
    const request = buildW12Request(draft, { title: "Pagamentos", text: "Resumo", hasChildren: true });
    expect(request).toEqual({
      model: JEV_MODEL,
      state: { draft, candidate: { title: "Pagamentos", summary: "Resumo" } },
      questions: { w1: noul(W1_QUESTION, { true: W1_TRUE, false: W1_FALSE }), w2: noul(W2_QUESTION, { true: W2_TRUE, false: W2_FALSE }) },
    });
    expect(Object.keys(request.state)).toEqual(["draft", "candidate"]);
    // O campo do candidato tem a mesma forma de W0.
    expect(request.state.candidate).toEqual(buildW0Request(draft, { title: "Pagamentos", text: "Resumo", hasChildren: true }).state.scope);
    expect(buildW12Request(draft, { title: "Cobrar", text: "Trecho", hasChildren: false }).state.candidate).toEqual({ title: "Cobrar", description: "Trecho" });
    expect(buildW12Request(draft, { title: "Cobrar", text: "", hasChildren: false }).state.candidate).toEqual({ title: "Cobrar" });
    expect(Object.keys(buildW0Request(draft, { title: "x", text: "", hasChildren: false }).state)).toEqual(["draft", "scope"]);
  });

  it("candidateState: a forma da produção para escopo com e sem filhos", () => {
    expect(candidateState("T", "R", true)).toEqual({ title: "T", summary: "R" });
    expect(candidateState("T", "R", false)).toEqual({ title: "T", description: "R" });
    expect(candidateState("T", "", false)).toEqual({ title: "T" });
  });
});

// ---- relatório ---------------------------------------------------------------------------------------------------

const rec = (testedTitle: string, pair: PairType, candidateTitle: string, w: { w0?: number[]; w1?: number[]; w2?: number[] }, extra: Partial<PairRecord> = {}): PairRecord => ({
  type: "pair",
  key: `${testedTitle}|${pair}|${candidateTitle}`,
  testedId: `id-${testedTitle}`,
  testedNumber: 1,
  testedTitle,
  pair,
  candidateId: `id-${candidateTitle}`,
  candidateTitle,
  candidateText: "",
  hasChildren: pair === "parent" || pair === "other_parent",
  leafFallback: false,
  w0: w.w0 ?? [0.5],
  w1: w.w1 ?? [0.5],
  w2: w.w2 ?? [0.5],
  errors: [],
  jev: { calls: 2, inputTokens: 100, outputTokens: 10, model: "jev-teste" },
  ...extra,
});

/** Três testados (A, B, C), cada um com pai G; A e B são irmãos nos dois sentidos; B recebe "sim" de A e C (ímã). */
const records: PairRecord[] = [
  rec("A", "parent", "G", { w0: [0.9], w1: [0.8], w2: [0.5] }),
  rec("B", "parent", "G", { w0: [0.5], w1: [0.9], w2: [0.1] }),
  rec("C", "parent", "G", { w0: [0.1], w1: [0.95], w2: [0.2] }),
  rec("A", "parent_as_leaf", "G", { w0: [0.95], w1: [0.2], w2: [0.9] }),
  rec("B", "parent_as_leaf", "G", { w0: [0.2], w1: [0.5], w2: [0.5] }),
  rec("C", "parent_as_leaf", "G", { w0: [0.5], w1: [0.1], w2: [0.5] }),
  rec("A", "sibling", "B", { w0: [0.9], w1: [0.1], w2: [0.2] }),
  rec("B", "sibling", "A", { w0: [0.8], w1: [0.2], w2: [0.1] }),
  rec("C", "sibling", "B", { w0: [0.75], w1: [0.1], w2: [0.1] }),
  rec("A", "other_parent", "H", { w0: [0.85], w1: [0.1], w2: [0.1] }),
  rec("B", "other_parent", "H", { w0: [0.1], w1: [0.1], w2: [0.1] }),
];

describe("pairsStats: cada número do relatório", () => {
  it("1. parent e parent_as_leaf por faixa (acima de 0,7 sim; abaixo de 0,3 não; 0,7 é meio)", () => {
    const w0 = pairsStats(records, "w0");
    expect(w0.parent).toEqual({ high: 1, mid: 1, low: 1 });
    expect(w0.parentAsLeaf).toEqual({ high: 1, mid: 1, low: 1 });
    expect(pairsStats(records, "w1").parent).toEqual({ high: 3, mid: 0, low: 0 });
    expect(pairsStats([rec("A", "parent", "G", { w0: [0.7] })], "w0").parent).toEqual({ high: 0, mid: 1, low: 0 });
  });

  it("2. sibling: quantos passam de 0,7 e a lista (testado → irmão, com a probabilidade)", () => {
    const w0 = pairsStats(records, "w0");
    expect(w0.siblingYes).toEqual([
      { tested: "A", candidate: "B", p: 0.9 },
      { tested: "B", candidate: "A", p: 0.8 },
      { tested: "C", candidate: "B", p: 0.75 },
    ]);
    expect(pairsStats(records, "w1").siblingYes).toEqual([]);
  });

  it("3. direção: pares de irmãos que passam nos dois sentidos, uma vez só", () => {
    expect(pairsStats(records, "w0").bothWays).toEqual([{ a: "A", b: "B", pAB: 0.9, pBA: 0.8 }]);
    expect(pairsStats(records, "w2").bothWays).toEqual([]);
  });

  it("4. ímãs: candidatos que mais recebem sim de irmãos", () => {
    expect(pairsStats(records, "w0").magnets).toEqual([{ candidate: "B", yes: 2 }, { candidate: "A", yes: 1 }]);
  });

  it("5. other_parent: quantos passam de 0,7, com a lista", () => {
    expect(pairsStats(records, "w0").otherParentYes).toEqual([{ tested: "A", candidate: "H", p: 0.85 }]);
    expect(pairsStats(records, "w1").otherParentYes).toEqual([]);
  });

  it("6. separação: parcela dos pares (sim esperado × não esperado, do mesmo testado) em que o sim é maior", () => {
    // w1, parent: A 0,8 contra sibling B 0,1 e other H 0,1 (ganha 2 de 2); B 0,9 contra A 0,2 (1 de 1); C 0,95 contra B 0,1 (1 de 1).
    // O testado B tem ainda other_parent 0,1: B 0,9 contra A 0,2 e H 0,1 (2 de 2). Total 5 de 5.
    expect(pairsStats(records, "w1").separationParent).toBe(1);
    // w0, parent: A 0,9 > B 0,9? A: sibling B 0,9 (empate: 0,5), other H 0,85 (ganha) → 1,5 de 2; B 0,5 > sibling A 0,8? não; > other 0,1 sim → 1 de 2; C 0,1 < sibling B 0,75 → 0 de 1. Total 2,5 de 5.
    expect(pairsStats(records, "w0").separationParent).toBeCloseTo(0.5, 10);
    // parent_as_leaf w0: A 0,95 ganha 2 de 2; B 0,2 perde para A 0,8 e ganha de H 0,1 → 1 de 2; C 0,5 perde para B 0,75 → 0 de 1. Total 3 de 5.
    expect(pairsStats(records, "w0").separationParentAsLeaf).toBeCloseTo(0.6, 10);
  });

  it("7. com repetições: pares cuja resposta muda de faixa entre repetições", () => {
    const withReps = [rec("A", "sibling", "B", { w0: [0.9, 0.2] }), rec("B", "sibling", "A", { w0: [0.9, 0.8, 0.95] }), rec("C", "sibling", "B", { w0: [0.4, 0.5] })];
    expect(pairsStats(withReps, "w0").flips).toBe(1);
    expect(pairsStats(records, "w0").flips).toBe(0);
  });

  it("pares com falha (sem resposta) não entram nas contas da redação que falhou", () => {
    const broken = [...records, rec("D", "sibling", "A", { w0: [] }, { errors: ["w0: provedor indisponível"] })];
    expect(pairsStats(broken, "w0").siblingYes).toHaveLength(3);
  });
});

describe("renderPairsReport", () => {
  const summaries: SummaryRecord[] = [
    { type: "summary", key: "k1", title: "G", text: "x", model: "claude-teste", inputTokens: 300, outputTokens: 40 },
    { type: "summary", key: "k2", title: "H", text: "y", model: "claude-teste", inputTokens: 200, outputTokens: 20 },
  ];
  const text = renderPairsReport(records, summaries, { variant: "base", now: new Date("2026-11-22T10:00:00Z"), repeats: 1 });

  it("o topo diz testados, pares por tipo, modelo do Jev e data", () => {
    const top = text.split("\n").slice(0, 14).join("\n");
    expect(top).toContain("2026-11-22");
    expect(top).toContain("jev-teste");
    expect(top).toMatch(/3 testados/);
    expect(top).toMatch(/parent: 3/);
    expect(top).toMatch(/parent_as_leaf: 3/);
    expect(top).toMatch(/sibling: 3/);
    expect(top).toMatch(/other_parent: 2/);
  });

  it("traz as listas, os ímãs, a tabela lado a lado e o custo", () => {
    expect(text).toContain("A → B (0,90)");
    expect(text).toContain("B → A (0,80)");
    expect(text).toContain("C → B (0,75)");
    expect(text).toContain("A ↔ B");
    expect(text).toMatch(/B: 2 sim/);
    expect(text).toContain("A → H (0,85)");
    for (const heading of ["W0", "W1", "W2"]) expect(text).toContain(heading);
    // custo: Jev 11 registros × 2 chamadas = 22 chamadas, 1100 tokens de entrada; Claude 2 chamadas, 500 de entrada.
    expect(text).toMatch(/Jev[^\n]*22 chamadas[^\n]*1100/);
    expect(text).toMatch(/Claude[^\n]*2 chamadas[^\n]*500/);
  });

  it("com falhas: lista os pares com erro", () => {
    const broken = [...records, rec("D", "sibling", "A", { w0: [] }, { errors: ["w0: provedor indisponível"] })];
    const out = renderPairsReport(broken, summaries, { variant: "base", now: new Date("2026-11-22T10:00:00Z"), repeats: 1 });
    expect(out).toMatch(/Falhas[^\n]*1/);
    expect(out).toContain("D → A");
    expect(out).toContain("provedor indisponível");
  });

  it("sem repetições a seção de repetições não aparece; com mais de uma, aparece", () => {
    expect(text).not.toMatch(/muda de faixa/);
    const out = renderPairsReport(records, summaries, { variant: "base", now: new Date("2026-11-22T10:00:00Z"), repeats: 3 });
    expect(out).toMatch(/muda de faixa/);
  });
});

describe("parseCliArgs: pairs e report --pairs", () => {
  it("pairs exige só --dir e aceita variante, limite, repetições, retomada e provedores falsos", () => {
    const parsed = parseCliArgs(["pairs", "--dir", "/x", "--variant", "v1", "--limit", "3", "--repeats", "2", "--resume", "--fake-providers"]);
    expect(parsed).toMatchObject({ ok: true, command: "pairs", options: { dir: "/x", variant: "v1", limit: 3, repeats: 2, resume: true, fakeProviders: true } });
    expect(parseCliArgs(["pairs"])).toMatchObject({ ok: false });
  });
  it("report --pairs: sem --project, com --variant; --resume só existe no pairs", () => {
    expect(parseCliArgs(["report", "--pairs", "--dir", "/x", "--variant", "v1"])).toMatchObject({ ok: true, command: "report", options: { pairs: true, variant: "v1" } });
    expect(parseCliArgs(["report", "--dir", "/x"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["collect", "--org", "o", "--user", "u", "--dir", "/x", "--project", "p", "--resume"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["report", "--pairs", "--collect", "--dir", "/x"])).toMatchObject({ ok: false });
  });
});

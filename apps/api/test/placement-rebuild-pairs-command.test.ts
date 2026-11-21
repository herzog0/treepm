import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { BranchSummaryInput } from "../src/assistant/ports.js";
import type { SystemOneCall } from "../src/assistant/jev-branch-judge.js";
import { pairsCommand, pairsPath, pairsReportCommand, pairsReportPath } from "../scripts/placement-rebuild/pairs.js";
import type { PairsContext, PairsKit } from "../scripts/placement-rebuild/pairs.js";
import type { PairRecord, SummaryRecord } from "../scripts/placement-rebuild/pairs-core.js";
import { gabarito } from "./pairs-fixture.js";

type Call = { request: Parameters<SystemOneCall>[0] };

let dir: string;
let jevCalls: Call[];
let summarized: BranchSummaryInput[];
let answer: (call: Call) => number;
let failJev: ((call: Call) => boolean) | null;
let failSummary: ((input: BranchSummaryInput) => boolean) | null;

const kit = (): PairsKit => ({
  systemOne: (request) => {
    const call = { request };
    jevCalls.push(call);
    if (failJev?.(call)) return Promise.reject(new Error("falha do provedor"));
    const keys = Object.keys(request.questions as Record<string, unknown>);
    const answers = Object.fromEntries(keys.map((key) => [key, { noul: answer(call) }]));
    return Promise.resolve({ model: "jev-falso", answers, usage: { input_tokens: 100, output_tokens: 10 } });
  },
  summarizer: {
    summarize: (input) => {
      summarized.push(input);
      if (failSummary?.(input)) return Promise.reject(new Error("falha do resumidor"));
      return Promise.resolve({ summary: `Resumo de ${input.title} com ${input.children.map((c) => c.title).join(" e ")}`, model: "claude-falso" });
    },
  },
  takeClaudeUsage: () => ({ inputTokens: 300, outputTokens: 40 }),
});

const context = (extra: Partial<PairsContext> = {}): PairsContext => ({
  dir,
  kit: kit(),
  log: () => undefined,
  sleep: () => Promise.resolve(),
  retryDelaysMs: [0],
  now: () => new Date("2026-11-22T10:00:00Z"),
  ...extra,
});

const lines = (variant = "base"): (PairRecord | SummaryRecord)[] =>
  readFileSync(pairsPath(dir, "proj-sentinela", variant), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PairRecord | SummaryRecord);
const pairRecords = (variant = "base"): PairRecord[] => lines(variant).filter((r): r is PairRecord => r.type === "pair");
const summaryRecords = (variant = "base"): SummaryRecord[] => lines(variant).filter((r): r is SummaryRecord => r.type === "summary");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pairs-cmd-"));
  writeFileSync(join(dir, "gabarito.json"), JSON.stringify(gabarito()));
  jevCalls = [];
  summarized = [];
  answer = () => 0.5;
  failJev = null;
  failSummary = null;
});

describe("pairs: coleta completa", () => {
  it("32 pares, duas requisições ao Jev por par (W0 separada de W1+W2) e relatório gravado", async () => {
    expect(await pairsCommand(context())).toBe(true);
    const records = pairRecords();
    expect(records).toHaveLength(32);
    expect(jevCalls).toHaveLength(64);
    expect(jevCalls.filter((c) => "scope" in (c.request.questions as object))).toHaveLength(32);
    expect(jevCalls.filter((c) => "w1" in (c.request.questions as object))).toHaveLength(32);
    for (const r of records) {
      expect(r.w0).toEqual([0.5]);
      expect(r.w1).toEqual([0.5]);
      expect(r.w2).toEqual([0.5]);
      expect(r.errors).toEqual([]);
      expect(r.jev).toEqual({ calls: 2, inputTokens: 200, outputTokens: 20, model: "jev-falso" });
    }
    expect(existsSync(pairsReportPath(dir, "proj-sentinela", "base"))).toBe(true);
    expect(readFileSync(pairsReportPath(dir, "proj-sentinela", "base"), "utf8")).toContain("W0");
  });

  it("o resumo do parent é pedido sem o testado; o do other_parent, uma vez só por ticket, com todos os filhos", async () => {
    await pairsCommand(context());
    const byTitle = (title: string) => summarized.filter((s) => s.title === title);
    // Pagamentos: um resumo por testado (p1, p2, p3), cada um sem o testado, mais UM com todos os filhos (other_parent de a1, r1, r2).
    const pagamentos = byTitle("Pagamentos").map((s) => s.children.map((c) => c.title).sort());
    expect(pagamentos).toHaveLength(4);
    expect(pagamentos).toContainEqual(["Emitir recibo", "Estornar cobrança"]);
    expect(pagamentos).toContainEqual(["Cobrar no cartão", "Emitir recibo"]);
    expect(pagamentos).toContainEqual(["Cobrar no cartão", "Estornar cobrança"]);
    expect(pagamentos).toContainEqual(["Cobrar no cartão", "Emitir recibo", "Estornar cobrança"]);
    // Acesso só tem a1: o parent de a1 não pede resumo; o other_parent pede um, uma vez, com o filho.
    expect(byTitle("Acesso")).toHaveLength(1);
    // Relatórios: r1 e r2 (sem o testado) mais um com os dois filhos.
    expect(byTitle("Relatórios")).toHaveLength(3);
    expect(summarized).toHaveLength(8);
    expect(summaryRecords()).toHaveLength(8);
  });

  it("o texto escrito pelo resumidor vai ao Jev como `summary` do candidato; o ticket sem filhos vai como `description`", async () => {
    await pairsCommand(context(), 1);
    const w0 = jevCalls.filter((c) => "scope" in (c.request.questions as object)).map((c) => (c.request.state as { scope: Record<string, string> }).scope);
    expect(w0[0]).toEqual({ title: "Pagamentos", summary: "Resumo de Pagamentos com Estornar cobrança e Emitir recibo" });
    expect(w0[1]).toEqual({ title: "Pagamentos", description: "Cobrar e estornar" });
    expect(w0[2]).toEqual({ title: "Estornar cobrança" });
    expect(w0[3]).toEqual({ title: "Emitir recibo", description: `${"palavra ".repeat(75).slice(0, 600)}…` });
  });

  it("nenhum id, número, chave, pessoa ou situação vai aos provedores", async () => {
    await pairsCommand(context());
    const sent = JSON.stringify([jevCalls.map((c) => c.request), summarized]);
    for (const forbidden of ["SENTINELA", "SENTK", "PESSOA", "in_progress", "proj-sentinela", "Projeto Sentinela"]) expect(sent).not.toContain(forbidden);
  });

  it("o registro do par guarda o texto do candidato e a marca de ticket sem filhos", async () => {
    await pairsCommand(context());
    const a1 = pairRecords().find((r) => r.testedTitle === "Entrar com senha" && r.pair === "parent");
    expect(a1).toMatchObject({ candidateTitle: "Acesso", leafFallback: true, hasChildren: false, candidateText: "Entrar no sistema" });
    const p1 = pairRecords().find((r) => r.testedTitle === "Cobrar no cartão" && r.pair === "parent");
    expect(p1).toMatchObject({ leafFallback: false, hasChildren: true, candidateText: "Resumo de Pagamentos com Estornar cobrança e Emitir recibo" });
  });

  it("o resumo escrito fica no arquivo com título, texto, modelo e tokens", async () => {
    await pairsCommand(context(), 1);
    expect(summaryRecords()[0]).toMatchObject({ type: "summary", title: "Pagamentos", model: "claude-falso", inputTokens: 300, outputTokens: 40 });
    expect(summaryRecords()[0]?.key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pairs: --limit, --repeats, --variant", () => {
  it("--limit 2 testa só os dois primeiros (12 pares)", async () => {
    await pairsCommand(context(), 2);
    expect(pairRecords()).toHaveLength(12);
    expect(new Set(pairRecords().map((r) => r.testedTitle)).size).toBe(2);
  });

  it("--repeats 3 repete as perguntas ao Jev para o mesmo estado e guarda todas as respostas", async () => {
    let n = 0;
    answer = () => [0.1, 0.5, 0.9][n++ % 3] as number;
    await pairsCommand(context({ repeats: 3 }), 1);
    const first = pairRecords()[0] as PairRecord;
    expect(first.w0).toHaveLength(3);
    expect(first.w1).toHaveLength(3);
    expect(first.w2).toHaveLength(3);
    expect(first.jev.calls).toBe(6);
    expect(jevCalls).toHaveLength(6 * 6);
    // as repetições mandam o payload idêntico
    expect(JSON.stringify(jevCalls[0]?.request)).toBe(JSON.stringify(jevCalls[1]?.request));
    // o resumo não é refeito a cada repetição
    expect(summarized).toHaveLength(3); // Pagamentos (sem p1), Acesso e Relatórios (other_parent)
  });

  it("variantes escrevem arquivos separados", async () => {
    await pairsCommand(context({ variant: "v1" }), 1);
    await pairsCommand(context({ variant: "v2" }), 1);
    expect(existsSync(pairsPath(dir, "proj-sentinela", "v1"))).toBe(true);
    expect(existsSync(pairsPath(dir, "proj-sentinela", "v2"))).toBe(true);
  });
});

describe("pairs: --resume", () => {
  it("arquivo existente sem --resume é recusado (nada é sobrescrito nem repetido)", async () => {
    await pairsCommand(context(), 1);
    await expect(pairsCommand(context(), 1)).rejects.toThrow(/--resume/);
  });

  it("continua um arquivo interrompido sem repetir o que já foi respondido", async () => {
    await pairsCommand(context(), 2);
    const answered = pairRecords().length;
    expect(answered).toBe(12);
    jevCalls = [];
    summarized = [];
    expect(await pairsCommand(context({ resume: true }))).toBe(true);
    expect(pairRecords()).toHaveLength(32);
    expect(new Set(pairRecords().map((r) => r.key)).size).toBe(32);
    // só os 20 pares que faltavam foram perguntados
    expect(jevCalls).toHaveLength(40);
    const drafts = new Set(jevCalls.map((c) => (c.request.state as { draft: { title: string } }).draft.title));
    expect(drafts.has("Cobrar no cartão")).toBe(false);
    expect(drafts.has("Estornar cobrança")).toBe(false);
    expect(drafts.size).toBe(4);
  });

  it("os resumos escritos antes são reaproveitados (não são pagos duas vezes)", async () => {
    await pairsCommand(context(), 1);
    const before = summarized.length;
    summarized = [];
    await pairsCommand(context({ resume: true }));
    // 8 resumos distintos no total; os que já existiam não voltam
    expect(before + summarized.length).toBe(8);
    expect(summaryRecords()).toHaveLength(8);
  });

  it("uma segunda retomada completa não chama provedor nenhum", async () => {
    await pairsCommand(context());
    jevCalls = [];
    summarized = [];
    expect(await pairsCommand(context({ resume: true }))).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(summarized).toHaveLength(0);
    expect(pairRecords()).toHaveLength(32);
  });
});

describe("pairs: falha de provedor", () => {
  it("falha do Jev em um par não derruba a coleta; o par fica com o erro e o relatório o lista", async () => {
    failJev = (call) => "w1" in (call.request.questions as object) && (call.request.state as unknown as { candidate: { title: string } }).candidate.title === "Estornar cobrança";
    expect(await pairsCommand(context())).toBe(false);
    const records = pairRecords();
    expect(records).toHaveLength(32);
    const failed = records.filter((r) => r.errors.length > 0);
    // Estornar cobrança é candidato de p1 e p3 (sibling); o W0 deles respondeu, o W1+W2 não.
    expect(failed.map((r) => `${r.testedTitle} → ${r.candidateTitle}`).sort()).toEqual(["Cobrar no cartão → Estornar cobrança", "Emitir recibo → Estornar cobrança"]);
    for (const r of failed) {
      expect(r.w0).toEqual([0.5]);
      expect(r.w1).toEqual([]);
      expect(r.w2).toEqual([]);
      expect(r.errors[0]).toMatch(/^w12:/);
    }
    const report = readFileSync(pairsReportPath(dir, "proj-sentinela", "base"), "utf8");
    expect(report).toMatch(/Falhas[^\n]*2/);
    expect(report).toContain("Cobrar no cartão → Estornar cobrança");
  });

  it("a retomada refaz só a parte que falhou", async () => {
    failJev = (call) => "w1" in (call.request.questions as object) && (call.request.state as unknown as { candidate: { title: string } }).candidate.title === "Estornar cobrança";
    await pairsCommand(context());
    failJev = null;
    jevCalls = [];
    summarized = [];
    expect(await pairsCommand(context({ resume: true }))).toBe(true);
    expect(jevCalls).toHaveLength(2);
    expect(jevCalls.every((c) => "w1" in (c.request.questions as object))).toBe(true);
    // a retomada acrescenta a linha nova; vale a última de cada chave
    const latest = new Map(pairRecords().map((r) => [r.key, r]));
    expect(latest.size).toBe(32);
    expect([...latest.values()].filter((r) => r.errors.length > 0)).toHaveLength(0);
    const fixed = [...latest.values()].find((r) => r.candidateTitle === "Estornar cobrança" && r.testedTitle === "Cobrar no cartão") as PairRecord;
    expect(fixed).toMatchObject({ w0: [0.5], w1: [0.5], w2: [0.5], errors: [] });
    expect(fixed.jev.calls).toBe(2);
  });

  it("falha do resumidor derruba só o par que precisava dele", async () => {
    failSummary = (input) => input.title === "Acesso";
    expect(await pairsCommand(context())).toBe(false);
    const failed = pairRecords().filter((r) => r.errors.length > 0);
    expect(failed.map((r) => r.candidateTitle)).toEqual(["Acesso", "Acesso", "Acesso", "Acesso", "Acesso"]);
    expect(failed.every((r) => r.pair === "other_parent" && r.errors[0]?.startsWith("resumo:"))).toBe(true);
    expect(pairRecords()).toHaveLength(32);
  });
});

describe("pairs report", () => {
  it("regenera o relatório sem chamar provedor", async () => {
    await pairsCommand(context());
    const path = pairsReportPath(dir, "proj-sentinela", "base");
    writeFileSync(path, "apagado");
    pairsReportCommand({ dir, log: () => undefined, now: () => new Date("2026-11-22T10:00:00Z") });
    expect(readFileSync(path, "utf8")).toContain("W1");
  });

  it("sem coleta, diz o que fazer", () => {
    expect(() => pairsReportCommand({ dir, log: () => undefined })).toThrow(/pairs/);
  });
});

/**
 * Comando `pairs` (ferramenta de medição, ADR 0034, segunda fatia): mede, par a par, três redações da pergunta de
 * "filho" (W0 a de hoje, W1 dependência, W2 parte). NÃO escreve no banco nem fala com a API: lê o `gabarito.json`,
 * chama o resumidor e o Jev pelos provedores do kit e grava `pairs-<projeto>-<variante>.jsonl` e o relatório `.md`.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AssistantUnavailableError } from "../../src/assistant/ports.js";
import type { BranchSummarizer } from "../../src/assistant/ports.js";
import type { SystemOneCall } from "../../src/assistant/jev-branch-judge.js";
import { withProvider } from "./collect.js";
import { DEFAULT_VARIANT } from "./collect-core.js";
import { readGabarito, readJsonLines } from "./commands.js";
import type { Context } from "./commands.js";
import { asSystemOne, buildPairs, buildW0Request, buildW12Request, renderPairsReport, summaryKey } from "./pairs-core.js";
import type { CandidateView, Draft, JevUsage, PairRecord, PairSpec, SummaryRecord } from "./pairs-core.js";

/** O que o `pairs` usa dos provedores: o Jev, o resumidor de produção e o consumo do Claude desde a última leitura. */
export type PairsKit = {
  systemOne: SystemOneCall;
  summarizer: BranchSummarizer;
  /** Consumo do Claude desde a última chamada a esta função (zera ao ler); `null` quando o provedor não informa. */
  takeClaudeUsage(): { inputTokens: number; outputTokens: number } | null;
};

export type PairsContext = Pick<Context, "dir" | "log" | "sleep"> & {
  kit: PairsKit;
  retryDelaysMs?: number[];
  variant?: string;
  /** Repetições de cada pergunta ao Jev para o mesmo estado (padrão 1). */
  repeats?: number;
  resume?: boolean;
  now?: () => Date;
};

export const pairsPath = (dir: string, projectId: string, variant: string): string => join(dir, `pairs-${projectId}-${variant}.jsonl`);
export const pairsReportPath = (dir: string, projectId: string, variant: string): string => join(dir, `report-pairs-${projectId}-${variant}.md`);

const DEFAULT_REPEATS = 1;
/** Mesmo prazo por tentativa que o juiz do produto usa com o Jev. */
const JEV_TIMEOUT_MS = 20_000;
const noulSchema = z.object({ noul: z.number().min(0).max(1) });

type Line = PairRecord | SummaryRecord;

/** O arquivo tem uma linha por resposta; vale a última de cada chave (a retomada acrescenta, nunca reescreve). */
function readState(path: string): { pairs: Map<string, PairRecord>; summaries: Map<string, SummaryRecord> } {
  const pairs = new Map<string, PairRecord>();
  const summaries = new Map<string, SummaryRecord>();
  for (const line of readJsonLines<Line>(path)) {
    if (line.type === "pair") pairs.set(line.key, line);
    else summaries.set(line.key, line);
  }
  return { pairs, summaries };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : "erro inesperado");
const sumOrNull = (a: number | null, b: number | null | undefined): number | null => (a === null && (b === undefined || b === null) ? null : (a ?? 0) + (b ?? 0));

export async function pairsCommand(ctx: PairsContext, limit?: number): Promise<boolean> {
  const repeats = ctx.repeats ?? DEFAULT_REPEATS;
  const variant = ctx.variant ?? DEFAULT_VARIANT;
  const gabarito = readGabarito(ctx.dir);
  const projectId = gabarito.project.id;
  const path = pairsPath(ctx.dir, projectId, variant);
  if (existsSync(path) && !ctx.resume) {
    throw new Error(`Já existe ${path}. Use --resume para continuar de onde parou, ou outra --variant.`);
  }
  const state = readState(path);
  const { pairs } = buildPairs(gabarito.tickets, limit);
  const failedSummaries = new Map<string, string>();
  const providerCtx = { sleep: ctx.sleep, ...(ctx.retryDelaysMs ? { retryDelaysMs: ctx.retryDelaysMs } : {}) };
  ctx.log(`Pares: ${pairs.length}; já respondidos: ${state.pairs.size}; repetições: ${repeats}.`);

  /** O texto do candidato: o resumo escrito (reaproveitado pelo conteúdo, uma chamada por entrada) ou o trecho. */
  const textOf = async (spec: PairSpec): Promise<string> => {
    const { text } = spec.candidate;
    if (text.kind === "excerpt") return text.excerpt;
    const key = summaryKey(text.input);
    const cached = state.summaries.get(key);
    if (cached) return cached.text;
    const failure = failedSummaries.get(key);
    if (failure !== undefined) throw new Error(failure);
    try {
      ctx.kit.takeClaudeUsage();
      const written = await withProvider(providerCtx, "resumo", () => ctx.kit.summarizer.summarize(text.input));
      const usage = ctx.kit.takeClaudeUsage();
      const record: SummaryRecord = {
        type: "summary",
        key,
        title: text.input.title,
        text: written.summary,
        model: written.model,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
      };
      appendFileSync(path, `${JSON.stringify(record)}\n`);
      state.summaries.set(key, record);
      return record.text;
    } catch (error) {
      failedSummaries.set(key, message(error));
      throw error;
    }
  };

  /** Uma requisição ao Jev, repetida `repeats` vezes com o mesmo estado; qualquer falha esgotada derruba só esta requisição. */
  const ask = async <K extends string>(what: string, request: Parameters<SystemOneCall>[0], keys: readonly K[], usage: JevUsage): Promise<Record<K, number[]>> => {
    const answers = Object.fromEntries(keys.map((k) => [k, [] as number[]])) as Record<K, number[]>;
    for (let i = 0; i < repeats; i++) {
      const result = await withProvider(providerCtx, what, async () => {
        try {
          return await ctx.kit.systemOne(request, { timeout: JEV_TIMEOUT_MS });
        } catch {
          throw new AssistantUnavailableError("provider_error");
        }
      });
      const parsed = z.object(Object.fromEntries(keys.map((k) => [k, noulSchema]))).safeParse(result.answers);
      if (!parsed.success) throw new Error(`${what}: resposta fora do formato`);
      for (const k of keys) answers[k].push((parsed.data as Record<K, { noul: number }>)[k].noul);
      usage.calls += 1;
      usage.inputTokens = sumOrNull(usage.inputTokens, result.usage?.input_tokens);
      usage.outputTokens = sumOrNull(usage.outputTokens, result.usage?.output_tokens);
      usage.model = result.model;
    }
    return answers;
  };

  let position = 0;
  for (const spec of pairs) {
    position += 1;
    const previous = state.pairs.get(spec.key);
    const needW0 = !(previous && previous.w0.length >= repeats);
    const needW12 = !(previous && previous.w1.length >= repeats && previous.w2.length >= repeats);
    if (!needW0 && !needW12) continue;

    const errors: string[] = [];
    const jev: JevUsage = previous ? { ...previous.jev } : { calls: 0, inputTokens: null, outputTokens: null, model: null };
    let w0 = needW0 ? [] : (previous as PairRecord).w0;
    let w1 = needW12 ? [] : (previous as PairRecord).w1;
    let w2 = needW12 ? [] : (previous as PairRecord).w2;
    let candidateText = previous?.candidateText ?? "";
    let textFailed = false;
    try {
      candidateText = await textOf(spec);
    } catch (error) {
      textFailed = true;
      errors.push(`resumo: ${message(error)}`);
    }
    if (!textFailed) {
      const draft: Draft = { title: spec.tested.title, description: spec.tested.description };
      const candidate: CandidateView = { title: spec.candidate.title, text: candidateText, hasChildren: spec.candidate.text.kind === "summary" };
      if (needW0) {
        try {
          w0 = (await ask("W0", buildW0Request(draft, candidate), ["scope"], jev)).scope;
        } catch (error) {
          errors.push(`w0: ${message(error)}`);
        }
      }
      if (needW12) {
        try {
          const answers = await ask("W1 e W2", asSystemOne(buildW12Request(draft, candidate)), ["w1", "w2"], jev);
          w1 = answers.w1;
          w2 = answers.w2;
        } catch (error) {
          errors.push(`w12: ${message(error)}`);
        }
      }
    }
    const record: PairRecord = {
      type: "pair",
      key: spec.key,
      testedId: spec.tested.id,
      testedNumber: spec.tested.number,
      testedTitle: spec.tested.title,
      pair: spec.pair,
      candidateId: spec.candidate.id,
      candidateTitle: spec.candidate.title,
      candidateText,
      hasChildren: spec.candidate.text.kind === "summary",
      leafFallback: spec.leafFallback,
      w0,
      w1,
      w2,
      errors,
      jev,
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    state.pairs.set(spec.key, record);
    ctx.log(`[${position}/${pairs.length}] ${spec.pair}: ${errors.length === 0 ? "respondido" : `com falha (${errors.length})`}`);
  }

  const now = ctx.now?.() ?? new Date();
  const final = readState(path);
  writeFileSync(pairsReportPath(ctx.dir, projectId, variant), renderPairsReport([...final.pairs.values()], [...final.summaries.values()], { variant, now, repeats: repeatsOf(final.pairs.values()) }));
  const failed = [...final.pairs.values()].filter((r) => r.errors.length > 0).length;
  ctx.log(failed === 0 ? `Pairs: ${final.pairs.size} pares respondidos; relatório gravado.` : `Pairs: ${failed} par(es) com falha de ${final.pairs.size}; rode com --resume para refazer só o que falhou.`);
  return failed === 0;
}

const repeatsOf = (records: Iterable<PairRecord>): number => Math.max(1, ...[...records].map((r) => r.w0.length));

/** `report --pairs`: sem chamada a provedor; regenera o relatório a partir do `.jsonl` da variante. */
export function pairsReportCommand(ctx: { dir: string; variant?: string; log: (line: string) => void; now?: () => Date }): void {
  const variant = ctx.variant ?? DEFAULT_VARIANT;
  const gabarito = readGabarito(ctx.dir);
  const path = pairsPath(ctx.dir, gabarito.project.id, variant);
  const state = readState(path);
  if (state.pairs.size === 0) throw new Error(`Não há coleta em ${path}. Rode \`pairs\` primeiro.`);
  const text = renderPairsReport([...state.pairs.values()], [...state.summaries.values()], { variant, now: ctx.now?.() ?? new Date(), repeats: repeatsOf(state.pairs.values()) });
  writeFileSync(pairsReportPath(ctx.dir, gabarito.project.id, variant), text);
  ctx.log(`Relatório dos pares gravado: ${state.pairs.size} pares.`);
}

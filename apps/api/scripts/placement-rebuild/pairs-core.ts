/**
 * Parte pura do comando `pairs` (ferramenta de medição, ADR 0034, segunda fatia): os pares (testado, candidato), as
 * três redações da pergunta de "filho", as requisições ao Jev, as contas e o relatório. Nada aqui fala com rede ou disco.
 * A produção não muda: os textos de W1 e W2 vivem aqui, e W0 usa as constantes de `prompts.ts` sem alteração.
 */
import { noul } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { descriptionExcerpt } from "@treepm/domain";
import type { BranchSummaryInput } from "../../src/assistant/ports.js";
import { buildJudgeRequest } from "../../src/assistant/jev-branch-judge.js";
import { JEV_MODEL, SUMMARY_SYSTEM_PROMPT } from "../../src/assistant/prompts.js";
import type { SystemOneCall } from "../../src/assistant/jev-branch-judge.js";
import { LOW, HIGH, bandCounts } from "./collect-core.js";
import { judgmentBand } from "./core.js";
import type { Band, GabaritoTicket } from "./core.js";

// ---- as redações novas (letra por letra como no brief) ------------------------------------------------------------

export const W1_QUESTION = "O ticket `candidate` só pode ser dado por pronto depois que o trabalho descrito em `draft` estiver feito?";
export const W1_TRUE =
  "O trabalho de `draft` é uma parte de `candidate` ou uma etapa de que `candidate` depende: enquanto `draft` não estiver feito, `candidate` não está completo.";
export const W1_FALSE =
  "O ticket `candidate` pode ser concluído sem `draft`: os dois são trabalhos separados, mesmo que tratem do mesmo assunto, ou é `draft` que depende de `candidate`.";
export const W2_QUESTION = "O trabalho descrito em `draft` é uma parte do trabalho descrito no ticket `candidate`?";
export const W2_TRUE = "O trabalho de `draft` é um pedaço de `candidate`: faz parte do que `candidate` promete entregar.";
export const W2_FALSE =
  "O trabalho de `draft` não é um pedaço de `candidate`: é um trabalho separado, mesmo que trate do mesmo assunto, ou é maior que `candidate`.";

export type Wording = "w0" | "w1" | "w2";
export const WORDINGS: readonly Wording[] = ["w0", "w1", "w2"];
export const WORDING_LABEL: Record<Wording, string> = {
  w0: "W0 — a de hoje (cabe dentro do assunto)",
  w1: "W1 — dependência (só pode ser dado por pronto depois)",
  w2: "W2 — parte (é uma parte do trabalho)",
};

export type PairType = "parent" | "parent_as_leaf" | "sibling" | "other_parent";
export const PAIR_TYPES: readonly PairType[] = ["parent", "parent_as_leaf", "sibling", "other_parent"];

// ---- tipos --------------------------------------------------------------------------------------------------------

/** Como o texto do candidato é obtido: um resumo escrito pelo resumidor de produção, ou o trecho da descrição. */
export type CandidateText = { kind: "summary"; input: BranchSummaryInput } | { kind: "excerpt"; excerpt: string };

export type PairSpec = {
  key: string;
  tested: GabaritoTicket;
  pair: PairType;
  candidate: { id: string; title: string; text: CandidateText };
  /** Só no `parent`: o pai tem apenas o testado como filho e por isso usa o texto de ticket sem filhos. */
  leafFallback: boolean;
};

export type Draft = { title: string; description: string };
export type CandidateView = { title: string; text: string; hasChildren: boolean };

export type JevUsage = { calls: number; inputTokens: number | null; outputTokens: number | null; model: string | null };

/** Uma linha do `.jsonl` por par. Os arrays guardam todas as respostas (uma por repetição); vazio = sem resposta. */
export type PairRecord = {
  type: "pair";
  key: string;
  testedId: string;
  testedNumber: number;
  testedTitle: string;
  pair: PairType;
  candidateId: string;
  candidateTitle: string;
  candidateText: string;
  hasChildren: boolean;
  leafFallback: boolean;
  w0: number[];
  w1: number[];
  w2: number[];
  /** `w0: …`, `w12: …` ou `resumo: …`; vazio quando o par está completo. */
  errors: string[];
  jev: JevUsage;
};

/** Um resumo escrito, guardado para reaproveitar entre execuções da mesma variante. */
export type SummaryRecord = {
  type: "summary";
  key: string;
  title: string;
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

// ---- os pares -----------------------------------------------------------------------------------------------------

/** A chave do resumo vem do conteúdo da entrada e do texto que o escreve (mudar o prompt invalida o reaproveitamento). */
export const summaryKey = (input: BranchSummaryInput): string =>
  createHash("sha256").update(SUMMARY_SYSTEM_PROMPT).update("\0").update(JSON.stringify(input)).digest("hex");

/**
 * Os pares do gabarito. Testado: todo ticket que tem pai, na ordem do número (`limit` corta os testados). Para cada um:
 * `parent`, `parent_as_leaf`, um `sibling` por irmão e um `other_parent` por outra raiz que tem filhos.
 */
export function buildPairs(gabarito: readonly GabaritoTicket[], limit?: number): { tested: GabaritoTicket[]; pairs: PairSpec[] } {
  const byNumber = (a: GabaritoTicket, b: GabaritoTicket): number => a.number - b.number;
  const sorted = [...gabarito].sort(byNumber);
  const byId = new Map(sorted.map((t) => [t.id, t]));
  const childrenOf = (id: string): GabaritoTicket[] => sorted.filter((t) => t.parentId === id);
  const excerptOf = (t: GabaritoTicket): CandidateText => ({ kind: "excerpt", excerpt: descriptionExcerpt(t.description) });
  const summaryOf = (g: GabaritoTicket, exclude: string | null): CandidateText => ({
    kind: "summary",
    input: {
      title: g.title,
      descriptionExcerpt: descriptionExcerpt(g.description),
      children: childrenOf(g.id)
        .filter((c) => c.id !== exclude)
        .map((c) => ({ title: c.title, summary: null })),
    },
  });
  const roots = sorted.filter((t) => t.parentId === null && childrenOf(t.id).length > 0);
  const allTested = sorted.filter((t) => t.parentId !== null);
  const tested = limit === undefined ? allTested : allTested.slice(0, limit);

  const pairs: PairSpec[] = [];
  for (const t of tested) {
    const g = byId.get(t.parentId as string) as GabaritoTicket;
    const ancestors = new Set<string>();
    for (let cursor: GabaritoTicket | undefined = g; cursor; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) ancestors.add(cursor.id);
    const add = (pair: PairType, candidate: GabaritoTicket, text: CandidateText, leafFallback = false): void => {
      pairs.push({ key: `${t.id}|${pair}|${candidate.id}`, tested: t, pair, candidate: { id: candidate.id, title: candidate.title, text }, leafFallback });
    };
    const siblings = childrenOf(g.id).filter((c) => c.id !== t.id);
    if (siblings.length > 0) add("parent", g, summaryOf(g, t.id));
    else add("parent", g, excerptOf(g), true);
    add("parent_as_leaf", g, excerptOf(g));
    for (const s of siblings) add("sibling", s, excerptOf(s));
    for (const root of roots) if (!ancestors.has(root.id)) add("other_parent", root, summaryOf(root, null));
  }
  return { tested, pairs };
}

// ---- requisições ao Jev -------------------------------------------------------------------------------------------

/** O candidato como dado nomeado do estado: a forma que a produção usa para o agrupador do escopo. */
export const candidateState = (title: string, text: string, hasChildren: boolean): Record<string, string> =>
  hasChildren ? { title, summary: text } : text === "" ? { title } : { title, description: text };

type JevRequest = Parameters<SystemOneCall>[0];

/** W0: exatamente a requisição de escopo da produção (estado `draft` e `scope`, as constantes de hoje). */
export function buildW0Request(draft: Draft, candidate: CandidateView): JevRequest {
  return buildJudgeRequest({
    draft,
    current: null,
    candidates: [],
    scope: { id: "", title: candidate.title, summary: candidate.text, hasChildren: candidate.hasChildren },
  }).request;
}

/** A requisição de W1 e W2: a forma difere da do juiz de produção, então quem a envia ao SDK a converte (`asSystemOne`). */
export type W12Request = {
  model: string;
  state: { draft: Draft; candidate: Record<string, string> };
  questions: { w1: ReturnType<typeof noul>; w2: ReturnType<typeof noul> };
};
export const asSystemOne = (request: W12Request): JevRequest => request as unknown as JevRequest;

/** W1 e W2 juntas: estado `draft` e `candidate`, duas perguntas. */
export function buildW12Request(draft: Draft, candidate: CandidateView): W12Request {
  return {
    model: JEV_MODEL,
    state: { draft, candidate: candidateState(candidate.title, candidate.text, candidate.hasChildren) },
    questions: {
      w1: noul(W1_QUESTION, { true: W1_TRUE, false: W1_FALSE }),
      w2: noul(W2_QUESTION, { true: W2_TRUE, false: W2_FALSE }),
    },
  };
}

// ---- contas -------------------------------------------------------------------------------------------------------

const mean = (values: readonly number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
/** A probabilidade do par numa redação: a média das repetições; `null` quando o par não tem resposta nessa redação. */
const valueOf = (record: PairRecord, wording: Wording): number | null => (record[wording].length === 0 ? null : mean(record[wording]));

export type PairValue = { tested: string; candidate: string; p: number };
export type WordingStats = {
  parent: Record<Band, number>;
  parentAsLeaf: Record<Band, number>;
  siblingYes: PairValue[];
  bothWays: { a: string; b: string; pAB: number; pBA: number }[];
  magnets: { candidate: string; yes: number }[];
  otherParentYes: PairValue[];
  separationParent: number;
  separationParentAsLeaf: number;
  /** Pares cujas repetições não caem todas na mesma faixa. */
  flips: number;
  /** Quantos pares entraram (têm resposta nesta redação). */
  answered: number;
};

const MAX_MAGNETS = 5;

/** Fração dos pares (sim esperado × não esperado, do MESMO testado) em que o sim recebe mais; empate vale meio. NaN sem pares. */
function separationOf(items: readonly { tested: string; pair: PairType; p: number }[], positive: PairType): number {
  let wins = 0;
  let total = 0;
  const testedIds = new Set(items.map((i) => i.tested));
  for (const id of testedIds) {
    const pos = items.filter((i) => i.tested === id && i.pair === positive);
    const neg = items.filter((i) => i.tested === id && (i.pair === "sibling" || i.pair === "other_parent"));
    for (const a of pos) {
      for (const b of neg) {
        total += 1;
        wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
      }
    }
  }
  return total === 0 ? Number.NaN : wins / total;
}

export function pairsStats(records: readonly PairRecord[], wording: Wording): WordingStats {
  const usable = records.filter((r) => r[wording].length > 0);
  const p = (r: PairRecord): number => valueOf(r, wording) as number;
  const view = (r: PairRecord): PairValue => ({ tested: r.testedTitle, candidate: r.candidateTitle, p: p(r) });
  const ofType = (pair: PairType): PairRecord[] => usable.filter((r) => r.pair === pair);
  const siblings = ofType("sibling");
  const yes = siblings.filter((r) => p(r) > HIGH);

  const bothWays: WordingStats["bothWays"] = [];
  const seen = new Set<string>();
  for (const r of yes) {
    const reverse = yes.find((o) => o.testedId === r.candidateId && o.candidateId === r.testedId);
    const unordered = [r.testedId, r.candidateId].sort().join("|");
    if (!reverse || seen.has(unordered)) continue;
    seen.add(unordered);
    bothWays.push({ a: r.testedTitle, b: r.candidateTitle, pAB: p(r), pBA: p(reverse) });
  }

  const received = new Map<string, { candidate: string; yes: number }>();
  for (const r of yes) {
    const entry = received.get(r.candidateId) ?? { candidate: r.candidateTitle, yes: 0 };
    entry.yes += 1;
    received.set(r.candidateId, entry);
  }
  const magnets = [...received.values()].sort((a, b) => b.yes - a.yes || a.candidate.localeCompare(b.candidate)).slice(0, MAX_MAGNETS);

  const items = usable.map((r) => ({ tested: r.testedId, pair: r.pair, p: p(r) }));
  const flips = usable.filter((r) => r[wording].length > 1 && new Set(r[wording].map(judgmentBand)).size > 1).length;
  return {
    parent: bandCounts(ofType("parent").map(p)),
    parentAsLeaf: bandCounts(ofType("parent_as_leaf").map(p)),
    siblingYes: yes.map(view),
    bothWays,
    magnets,
    otherParentYes: ofType("other_parent").filter((r) => p(r) > HIGH).map(view),
    separationParent: separationOf(items, "parent"),
    separationParentAsLeaf: separationOf(items, "parent_as_leaf"),
    flips,
    answered: usable.length,
  };
}

// ---- relatório ----------------------------------------------------------------------------------------------------

const num = (value: number): string => (Number.isNaN(value) ? "—" : value.toFixed(2).replace(".", ","));
const pct = (value: number): string => (Number.isNaN(value) ? "—" : `${(value * 100).toFixed(1).replace(".", ",")}%`);
const bandsText = (b: Record<Band, number>): string => `sim ${b.high} · meio ${b.mid} · não ${b.low}`;
const sum = (values: readonly (number | null)[]): number | null => (values.some((v) => v !== null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null);
const tokensText = (input: number | null, output: number | null): string =>
  input === null && output === null ? "tokens não informados" : `${input ?? 0} tokens de entrada, ${output ?? 0} de saída`;

export function renderPairsReport(
  records: readonly PairRecord[],
  summaries: readonly SummaryRecord[],
  ctx: { variant: string; now: Date; repeats: number },
): string {
  const testedCount = new Set(records.map((r) => r.testedId)).size;
  const perType = PAIR_TYPES.map((t) => `${t}: ${records.filter((r) => r.pair === t).length}`).join(" · ");
  const models = [...new Set(records.map((r) => r.jev.model).filter((m): m is string => m !== null))];
  const lines: string[] = [
    `# Pares de "filho" (variante \`${ctx.variant}\`)`,
    "",
    `- Data: ${ctx.now.toISOString().slice(0, 10)}`,
    `- ${testedCount} testados; ${records.length} pares (${perType})`,
    `- Modelo do Jev: ${models.length > 0 ? models.join(", ") : "não informado"}`,
    `- Repetições por pergunta: ${ctx.repeats}. Limites: acima de ${num(HIGH)} é "sim", abaixo de ${num(LOW)} é "não". Com repetições, vale a média delas.`,
    `- Pares do parent marcados como ticket sem filhos (o pai só tem o testado): ${records.filter((r) => r.pair === "parent" && r.leafFallback).length}`,
    "",
  ];

  const stats = Object.fromEntries(WORDINGS.map((w) => [w, pairsStats(records, w)])) as Record<Wording, WordingStats>;
  for (const w of WORDINGS) {
    const s = stats[w];
    lines.push(`## ${WORDING_LABEL[w]}`, "");
    lines.push(`Pares com resposta: ${s.answered} de ${records.length}.`, "");
    lines.push(`1. \`parent\` (esperado sim): ${bandsText(s.parent)}.`);
    lines.push(`   \`parent_as_leaf\` (esperado sim): ${bandsText(s.parentAsLeaf)}.`, "");
    lines.push(`2. \`sibling\` acima de ${num(HIGH)} (esperado não): ${s.siblingYes.length}.`);
    for (const x of s.siblingYes) lines.push(`   - ${x.tested} → ${x.candidate} (${num(x.p)})`);
    lines.push("", `3. Nos dois sentidos: ${s.bothWays.length} par(es) de irmãos.`);
    for (const x of s.bothWays) lines.push(`   - ${x.a} ↔ ${x.b} (${num(x.pAB)} / ${num(x.pBA)})`);
    lines.push("", `4. Ímãs (candidatos que mais recebem sim de irmãos):`);
    if (s.magnets.length === 0) lines.push("   - nenhum");
    for (const m of s.magnets) lines.push(`   - ${m.candidate}: ${m.yes} sim`);
    lines.push("", `5. \`other_parent\` acima de ${num(HIGH)} (esperado não): ${s.otherParentYes.length}.`);
    for (const x of s.otherParentYes) lines.push(`   - ${x.tested} → ${x.candidate} (${num(x.p)})`);
    lines.push(
      "",
      `6. Separação (o sim recebe mais que o não, do mesmo testado): \`parent\` ${pct(s.separationParent)} · \`parent_as_leaf\` ${pct(s.separationParentAsLeaf)}.`,
    );
    if (ctx.repeats > 1) lines.push("", `7. Pares cuja resposta muda de faixa entre as repetições: ${s.flips}.`);
    lines.push("");
  }

  lines.push("## Lado a lado", "");
  lines.push("| Redação | 1. parent | 1. parent_as_leaf | 2. sibling > 0,7 | 3. dois sentidos | 5. other_parent > 0,7 | 6. separação parent | 6. separação parent_as_leaf |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const w of WORDINGS) {
    const s = stats[w];
    lines.push(
      `| ${w.toUpperCase()} | ${bandsText(s.parent)} | ${bandsText(s.parentAsLeaf)} | ${s.siblingYes.length} | ${s.bothWays.length} | ${s.otherParentYes.length} | ${pct(s.separationParent)} | ${pct(s.separationParentAsLeaf)} |`,
    );
  }
  lines.push("");

  const failed = records.filter((r) => r.errors.length > 0);
  lines.push(`## Falhas: ${failed.length} par(es) com erro`, "");
  for (const r of failed) lines.push(`- ${r.testedTitle} → ${r.candidateTitle} (${r.pair}): ${r.errors.join("; ")}`);
  if (failed.length > 0) lines.push("");

  lines.push("## Custo", "");
  const jevIn = sum(records.map((r) => r.jev.inputTokens));
  const jevOut = sum(records.map((r) => r.jev.outputTokens));
  lines.push(`- Jev: ${records.reduce((s, r) => s + r.jev.calls, 0)} chamadas, ${tokensText(jevIn, jevOut)}.`);
  const claudeModels = [...new Set(summaries.map((s) => s.model))];
  lines.push(
    `- Claude (resumidor${claudeModels.length > 0 ? `; ${claudeModels.join(", ")}` : ""}): ${summaries.length} chamadas, ${tokensText(sum(summaries.map((s) => s.inputTokens)), sum(summaries.map((s) => s.outputTokens)))}.`,
    "",
  );
  return lines.join("\n");
}

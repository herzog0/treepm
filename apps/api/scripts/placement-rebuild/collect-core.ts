/**
 * Parte pura da coleta de julgamentos (`collect`) e do relatório `report --collect`: regras de decisão, sinais,
 * separação, cobertura, variação entre repetições e o texto do relatório. Nada aqui fala com rede, banco ou disco.
 */
import { judgmentBand } from "./core.js";
import type { Band } from "./core.js";

export const ROOT = "root";

export type CollectRep = { gate: number; choice: Record<string, number>; ms: number };
export type FitRep = { fit: Record<string, number>; ms: number };
export type ClaudeResult = { ranking: string[] | null; invalid: string | null; ms: number; inputTokens: number | null; outputTokens: number | null };

export type CollectRecord = {
  oldId: string;
  number: number;
  title: string;
  /** Agrupador da raiz que contém o ticket no gabarito; `null` para ticket solto na raiz (fica fora das contas). */
  originalGroupId: string | null;
  /** Agrupadores da raiz, na ordem do número. */
  groupIds: string[];
  a: CollectRep[];
  aNeg: CollectRep[] | null;
  b: FitRep[];
  d: ClaudeResult | null;
  dNeg: ClaudeResult | null;
};

export type Sample = { order: string[]; gate: number; choice: Record<string, number>; fit: Record<string, number> };

export const JEV_RULES = ["R0", "R1", "R2", "R3", "R4", "R5", "desce", "raiz"] as const;
export type JevRule = (typeof JEV_RULES)[number];
export type Signal = "gate" | "pTop" | "maxFit" | "fitTop" | "gateXpTop";

export const LOW = 0.3;
export const HIGH = 0.7;
export const INVALID = "inválido";

/** Opção mais provável do Choice; empate fica com a primeira da ordem. */
export function topOf(s: Sample): { id: string; p: number } {
  let best = { id: "", p: -1 };
  for (const id of s.order) {
    const p = s.choice[id] ?? 0;
    if (p > best.p) best = { id, p };
  }
  return best.p < 0 ? { id: "", p: 0 } : best;
}

/** Maior Noul individual (coleta B); empate fica com o primeiro da ordem. */
export function maxFitOf(s: Sample): { id: string; value: number } {
  let best = { id: "", value: -1 };
  for (const id of s.order) {
    const value = s.fit[id] ?? 0;
    if (value > best.value) best = { id, value };
  }
  return best.value < 0 ? { id: "", value: 0 } : best;
}

/** As opções do Choice da mais para a menos provável; empate respeita a ordem. */
export function choiceRanking(s: Sample): string[] {
  return s.order
    .map((id, index) => ({ id, index, p: s.choice[id] ?? 0 }))
    .sort((a, b) => b.p - a.p || a.index - b.index)
    .map((x) => x.id);
}

/** Destino de uma regra do Jev: um agrupador ou a raiz. */
export function ruleDestination(rule: JevRule, s: Sample): string {
  const top = topOf(s);
  const fitTop = s.fit[top.id] ?? 0;
  switch (rule) {
    case "R0":
      return s.gate > HIGH ? top.id : ROOT;
    case "R1":
      return s.gate >= LOW ? top.id : ROOT;
    case "R2":
      return s.gate > HIGH && top.p > HIGH ? top.id : ROOT;
    case "R3": {
      const best = maxFitOf(s);
      return best.value > HIGH ? best.id : ROOT;
    }
    case "R4":
      return fitTop > HIGH ? top.id : ROOT;
    case "R5":
      if (s.gate > HIGH) return top.id;
      return s.gate >= LOW && fitTop > HIGH ? top.id : ROOT;
    case "desce":
      return top.id;
    case "raiz":
      return ROOT;
  }
}

/** Repetições que o registro tem para o positivo (A e B) ou para o negativo (A− e B). */
export function repCount(r: CollectRecord, negative: boolean): number {
  if (r.originalGroupId === null) return 0;
  if (negative) return r.aNeg === null ? 0 : Math.min(r.aNeg.length, r.b.length);
  return Math.min(r.a.length, r.b.length);
}

/**
 * A amostra de uma repetição. No negativo vale a coleta A− e o `fit` ignora o agrupador original. `null` quando o
 * registro não tem essa coleta (ticket solto na raiz, um agrupador só, repetição que não existe).
 */
export function sampleOf(r: CollectRecord, rep: number, negative: boolean): Sample | null {
  if (rep >= repCount(r, negative)) return null;
  const judged = negative ? (r.aNeg as CollectRep[])[rep] : r.a[rep];
  const fits = r.b[rep];
  if (!judged || !fits) return null;
  const order = r.groupIds.filter((id) => id in judged.choice && !(negative && id === r.originalGroupId));
  return {
    order,
    gate: judged.gate,
    choice: Object.fromEntries(order.map((id) => [id, judged.choice[id] as number])),
    fit: Object.fromEntries(order.map((id) => [id, fits.fit[id] ?? 0])),
  };
}

/** D: o primeiro do ranking; ranking inválido não é destino de nada. */
export function dDestination(d: ClaudeResult | null): string {
  return d?.ranking?.[0] ?? INVALID;
}

/** O original está entre o destino e a segunda opção do Choice (e a terceira, com `n = 3`)? */
export function coverage(destination: string, s: Sample, original: string, n: 2 | 3): boolean {
  return [destination, ...choiceRanking(s).slice(1, n)].includes(original);
}

/** D: o original está entre os dois (ou três) primeiros do ranking? */
export function rankingCoverage(ranking: readonly string[] | null, original: string, n: 2 | 3): boolean {
  return ranking !== null && ranking.slice(0, n).includes(original);
}

export function signalsOf(s: Sample): Record<Signal, number> {
  const top = topOf(s);
  return { gate: s.gate, pTop: top.p, maxFit: maxFitOf(s).value, fitTop: s.fit[top.id] ?? 0, gateXpTop: s.gate * top.p };
}

/** Fração dos pares (um positivo, um negativo) em que o positivo é maior; empate conta meio. Sem pares: NaN. */
export function separation(pos: readonly number[], neg: readonly number[]): number {
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function bandCounts(values: readonly number[]): Record<Band, number> {
  const counts: Record<Band, number> = { low: 0, mid: 0, high: 0 };
  for (const value of values) counts[judgmentBand(value)] += 1;
  return counts;
}

export const spread = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.max(...values) - Math.min(...values));

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const samplesOfRecord = (r: CollectRecord, negative: boolean): Sample[] =>
  Array.from({ length: repCount(r, negative) }, (_, rep) => sampleOf(r, rep, negative) as Sample);

export type VariationRow = { signal: "gate" | "pTop" | "fit"; median: number; max: number };

/** Maior diferença entre repetições do mesmo payload, por ticket: mediana e máximo sobre os tickets. `fit`: o maior entre os agrupadores. */
export function variation(records: readonly CollectRecord[], negative: boolean): VariationRow[] {
  const perTicket = records.map((r) => samplesOfRecord(r, negative)).filter((samples) => samples.length > 0);
  const row = (signal: VariationRow["signal"], diff: (samples: Sample[]) => number): VariationRow => {
    const diffs = perTicket.map(diff);
    return { signal, median: median(diffs), max: diffs.length === 0 ? Number.NaN : Math.max(...diffs) };
  };
  return [
    row("gate", (samples) => spread(samples.map((s) => s.gate))),
    row("pTop", (samples) => spread(samples.map((s) => topOf(s).p))),
    row("fit", (samples) => Math.max(0, ...(samples[0] as Sample).order.map((id) => spread(samples.map((s) => s.fit[id] ?? 0))))),
  ];
}

/** Quantos tickets mudam de destino entre repetições, para uma regra. */
export function destinationChanges(records: readonly CollectRecord[], rule: JevRule, negative: boolean): number {
  return records.filter((r) => new Set(samplesOfRecord(r, negative).map((s) => ruleDestination(rule, s))).size > 1).length;
}

// ---- relatório ---------------------------------------------------------------------------------------------------

export const NOTE =
  "No negativo, o agrupador certo foi retirado; um ticket pode caber de verdade em outro agrupador, então parte dos 'erros' do negativo é discutível.";

const RULE_LABEL: Record<JevRule, string> = { R0: "R0", R1: "R1", R2: "R2", R3: "R3", R4: "R4", R5: "R5", desce: "Sempre desce", raiz: "Sempre raiz" };
const RULE_MEANING: Record<JevRule, string> = {
  R0: "a de hoje: `gate` > 0,7 → `top`; senão raiz",
  R1: "`gate` ≥ 0,3 → `top`; senão raiz",
  R2: "`gate` > 0,7 e `pTop` > 0,7 → `top`; senão raiz",
  R3: "`maxFit` > 0,7 → `argmaxFit`; senão raiz",
  R4: "`fit(top)` > 0,7 → `top`; senão raiz",
  R5: "`gate` > 0,7 → `top`; `gate` entre 0,3 e 0,7 e `fit(top)` > 0,7 → `top`; senão raiz",
  desce: "sempre `top`",
  raiz: "sempre raiz",
};
const SIGNAL_LABEL: Record<Signal, string> = { gate: "gate", pTop: "pTop", maxFit: "maxFit", fitTop: "fit(top)", gateXpTop: "gate × pTop" };

const pct = (value: number): string => (Number.isNaN(value) ? "—" : `${(value * 100).toFixed(1)}%`);
const num = (value: number, digits = 3): string => (Number.isNaN(value) ? "—" : value.toFixed(digits));
const ms = (value: number): string => (Number.isNaN(value) ? "—" : `${Math.round(value)} ms`);
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** "31 / 30 / 31 (30–31)": o valor de cada repetição e o menor e o maior. */
const perRep = (values: readonly number[]): string =>
  values.length === 0 ? "—" : `${values.join(" / ")} (${Math.min(...values)}–${Math.max(...values)})`;

const sumReps = (a: readonly number[], b: readonly number[]): number[] => a.map((value, index) => value + (b[index] ?? 0));

export function renderCollectReport(records: readonly CollectRecord[], ctx: { projectKey: string; groupTitles: ReadonlyMap<string, string> }): string {
  const positives = records.filter((r) => repCount(r, false) > 0);
  const negatives = records.filter((r) => repCount(r, true) > 0);
  const posReps = positives.length === 0 ? 0 : Math.min(...positives.map((r) => repCount(r, false)));
  const negReps = negatives.length === 0 ? 0 : Math.min(...negatives.map((r) => repCount(r, true)));
  const groupIds = records[0]?.groupIds ?? [];
  const label = (id: string): string => (id === ROOT ? "raiz" : id === INVALID ? INVALID : `G${groupIds.indexOf(id) + 1}`);
  const original = (r: CollectRecord): string => r.originalGroupId as string;

  const hitsByRep = (rule: JevRule, negative: boolean, list: readonly CollectRecord[], reps: number): number[] =>
    Array.from({ length: reps }, (_, rep) =>
      list.filter((r) => {
        const destination = ruleDestination(rule, sampleOf(r, rep, negative) as Sample);
        return negative ? destination === ROOT : destination === original(r);
      }).length,
    );
  const dHits = (negative: boolean, list: readonly CollectRecord[]): number =>
    list.filter((r) => {
      const destination = dDestination(negative ? r.dNeg : r.d);
      return negative ? destination === ROOT : destination === original(r);
    }).length;

  const lines: string[] = [];
  lines.push(`# Coleta de julgamentos — ${ctx.projectKey}`, "", `> ${NOTE}`, "");
  const loose = records.filter((r) => r.originalGroupId === null).length;
  lines.push(
    `${records.length} tickets coletados: ${positives.length} no positivo (${posReps} repetição(ões)) e ${negatives.length} no negativo (${negReps} repetição(ões)); ${loose} solto(s) na raiz, fora das contas. Limites fixos: 0,3 e 0,7.`,
    "",
    "Agrupadores da raiz:",
    "",
    ...groupIds.map((id, index) => `- G${index + 1} = ${cell(ctx.groupTitles.get(id) ?? id)}`),
    "",
    "Regras:",
    "",
    ...JEV_RULES.map((rule) => `- ${RULE_LABEL[rule]}: ${RULE_MEANING[rule]}`),
    "- D: primeiro do `ranking` do Claude, que vê o projeto inteiro.",
    "",
  );

  // 1. tabela principal
  lines.push("## Tabela principal", "", `Acertos por repetição (menor–maior). Positivo: o destino é o agrupador original (de ${positives.length}); negativo: o destino é a raiz (de ${negatives.length}).`, "");
  lines.push("| Regra | Positivo | Negativo | Soma |", "| --- | --- | --- | --- |");
  for (const rule of JEV_RULES) {
    const pos = hitsByRep(rule, false, positives, posReps);
    const neg = hitsByRep(rule, true, negatives, negReps);
    lines.push(`| ${RULE_LABEL[rule]} | ${perRep(pos)} | ${perRep(neg)} | ${perRep(sumReps(pos, neg).slice(0, Math.min(pos.length, neg.length)))} |`);
  }
  const dPos = dHits(false, positives.filter((r) => r.d !== null));
  const dNeg = dHits(true, negatives.filter((r) => r.dNeg !== null));
  lines.push(`| D | ${dPos} | ${dNeg} | ${dPos + dNeg} |`, "");

  // 2. cobertura
  lines.push("## Cobertura em duas e três opções (positivo)", "", "O original está entre o destino e a segunda opção do `Choice` (e a terceira). Para D, entre os dois (e três) primeiros do ranking.", "");
  lines.push("| Regra | Duas opções | Três opções |", "| --- | --- | --- |");
  for (const rule of JEV_RULES) {
    const covered = (n: 2 | 3): number[] =>
      Array.from({ length: posReps }, (_, rep) =>
        positives.filter((r) => {
          const s = sampleOf(r, rep, false) as Sample;
          return coverage(ruleDestination(rule, s), s, original(r), n);
        }).length,
      );
    lines.push(`| ${RULE_LABEL[rule]} | ${perRep(covered(2))} | ${perRep(covered(3))} |`);
  }
  const dCovered = (n: 2 | 3): number => positives.filter((r) => rankingCoverage(r.d?.ranking ?? null, original(r), n)).length;
  lines.push(`| D | ${dCovered(2)} | ${dCovered(3)} |`, "");

  // 3. separação
  lines.push("## Separação dos sinais, sem limite", "", "Fração dos pares (um positivo, um negativo) em que o sinal do positivo é maior que o do negativo (empate conta meio); primeira repetição. As faixas são: abaixo de 0,3 / de 0,3 a 0,7 / acima de 0,7.", "");
  lines.push("| Sinal | Separação | Positivos (baixa / meio / alta) | Negativos (baixa / meio / alta) |", "| --- | --- | --- | --- |");
  const firstSignals = (list: readonly CollectRecord[], negative: boolean) => list.map((r) => signalsOf(sampleOf(r, 0, negative) as Sample));
  const posSignals = firstSignals(positives, false);
  const negSignals = firstSignals(negatives, true);
  for (const signal of Object.keys(SIGNAL_LABEL) as Signal[]) {
    const pos = posSignals.map((x) => x[signal]);
    const neg = negSignals.map((x) => x[signal]);
    const band = (values: number[]): string => {
      const counts = bandCounts(values);
      return `${counts.low} / ${counts.mid} / ${counts.high}`;
    };
    lines.push(`| ${SIGNAL_LABEL[signal]} | ${pct(separation(pos, neg))} | ${band(pos)} | ${band(neg)} |`);
  }
  lines.push("");

  // 4. variação
  lines.push("## Variação do Jev com payload idêntico", "", "Maior diferença entre repetições do mesmo ticket (mediana e máximo sobre os tickets). `fit`: o maior entre os agrupadores.", "");
  lines.push("| Sinal | Positivo: mediana | Positivo: máximo | Negativo: mediana | Negativo: máximo |", "| --- | --- | --- | --- | --- |");
  const varPos = variation(positives, false);
  const varNeg = variation(negatives, true);
  varPos.forEach((row, index) => {
    const other = varNeg[index] as VariationRow;
    lines.push(`| ${row.signal} | ${num(row.median)} | ${num(row.max)} | ${num(other.median)} | ${num(other.max)} |`);
  });
  lines.push("", "Tickets que mudam de destino entre repetições:", "", "| Regra | Positivo | Negativo |", "| --- | --- | --- |");
  for (const rule of JEV_RULES) {
    lines.push(`| ${RULE_LABEL[rule]} | ${destinationChanges(positives, rule, false)} | ${destinationChanges(negatives, rule, true)} |`);
  }
  lines.push("");

  // 5. por ticket
  const perTicket = (title: string, list: readonly CollectRecord[], negative: boolean): void => {
    lines.push(`### ${title}`, "", `| # | Título | Original | ${JEV_RULES.map((rule) => RULE_LABEL[rule]).join(" | ")} | D |`, `| --- | --- | --- | ${JEV_RULES.map(() => "---").join(" | ")} | --- |`);
    for (const r of list) {
      const hit = (destination: string): string => `${label(destination)} ${(negative ? destination === ROOT : destination === original(r)) ? "✓" : "✗"}`;
      const cells = JEV_RULES.map((rule) => hit(ruleDestination(rule, sampleOf(r, 0, negative) as Sample)));
      lines.push(`| ${r.number} | ${cell(r.title)} | ${label(original(r))} | ${cells.join(" | ")} | ${hit(dDestination(negative ? r.dNeg : r.d))} |`);
    }
    lines.push("");
  };
  lines.push("## Por ticket", "", "Destino de cada regra na primeira repetição (✓ acerta, ✗ erra).", "");
  perTicket("Positivo", positives, false);
  perTicket("Negativo (agrupador original retirado)", negatives, true);

  // 6. custo e tempo
  lines.push("## Custo e tempo", "", "| Coleta | Chamadas | Duração mediana |", "| --- | --- | --- |");
  const durations = (values: number[]): string => `| ${values.length} | ${ms(median(values))} |`;
  lines.push(`| A (positivo) ${durations(records.flatMap((r) => r.a.map((x) => x.ms)))}`);
  lines.push(`| A− (negativo) ${durations(records.flatMap((r) => (r.aNeg ?? []).map((x) => x.ms)))}`);
  lines.push(`| B (um Noul por agrupador) ${durations(records.flatMap((r) => r.b.map((x) => x.ms)))}`);
  const dResults = records.flatMap((r) => [r.d, r.dNeg]).filter((x): x is ClaudeResult => x !== null);
  lines.push(`| D (Claude) ${durations(dResults.map((x) => x.ms))}`, "");
  const tokens = (key: "inputTokens" | "outputTokens"): number => dResults.reduce((sum, x) => sum + (x[key] ?? 0), 0);
  const invalid = dResults.filter((x) => x.ranking === null).length;
  lines.push(`Tokens de D (positivo e negativo): ${tokens("inputTokens")} de entrada e ${tokens("outputTokens")} de saída. Rankings inválidos: ${invalid}.`, "");
  return lines.join("\n");
}

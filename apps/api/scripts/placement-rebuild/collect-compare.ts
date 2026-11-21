/** Comparação pareada de duas coletas (`report --collect --compare`): ganhos, perdas, saldo e mudanças de destino por regra. */
import { JEV_RULES, ROOT, dDestination, ruleDestination, sampleOf } from "./collect-core.js";
import type { CollectRecord, JevRule } from "./collect-core.js";

export type CompareCell = { a: number; b: number; gains: number; losses: number; balance: number; changed: number };
export type RuleCompare = { rule: string; pos: CompareCell; neg: CompareCell; sum: CompareCell };
export type Comparison = { rules: RuleCompare[]; paired: number; onlyA: number[]; onlyB: number[] };

export const NOTE =
  "Uma variante só é melhor que a outra se o saldo passar do ruído: o número de tickets que mudam de destino entre duas coletas da mesma variante em cópias diferentes do projeto.";

const LABEL: Record<JevRule, string> = { R0: "R0", R1: "R1", R2: "R2", R3: "R3", R4: "R4", R5: "R5", desce: "Sempre desce", raiz: "Sempre raiz" };

const empty = (): CompareCell => ({ a: 0, b: 0, gains: 0, losses: 0, balance: 0, changed: 0 });
const add = (x: CompareCell, y: CompareCell): CompareCell => ({
  a: x.a + y.a,
  b: x.b + y.b,
  gains: x.gains + y.gains,
  losses: x.losses + y.losses,
  balance: x.balance + y.balance,
  changed: x.changed + y.changed,
});

type Pair = { a: CollectRecord; b: CollectRecord };

/** Destino de uma regra (ou de D) na primeira repetição; `null` quando a coleta não tem a amostra. */
function destination(rule: JevRule | "D", r: CollectRecord, negative: boolean): string | null {
  if (rule === "D") {
    const d = negative ? r.dNeg : r.d;
    return d == null ? null : dDestination(d);
  }
  const sample = sampleOf(r, 0, negative);
  return sample === null ? null : ruleDestination(rule, sample);
}

const hit = (dest: string, r: CollectRecord, negative: boolean): boolean => (negative ? dest === ROOT : dest === r.originalGroupId);

function pairsOf(a: readonly CollectRecord[], b: readonly CollectRecord[]): { pairs: Pair[]; onlyA: number[]; onlyB: number[] } {
  const byB = new Map(b.map((r) => [r.number, r]));
  const byA = new Map(a.map((r) => [r.number, r]));
  return {
    pairs: a.filter((r) => byB.has(r.number)).map((r) => ({ a: r, b: byB.get(r.number) as CollectRecord })),
    onlyA: a.filter((r) => !byB.has(r.number)).map((r) => r.number).sort((x, y) => x - y),
    onlyB: b.filter((r) => !byA.has(r.number)).map((r) => r.number).sort((x, y) => x - y),
  };
}

function cellOf(rule: JevRule | "D", pairs: readonly Pair[], negative: boolean): CompareCell {
  const cell = empty();
  for (const { a, b } of pairs) {
    const destA = destination(rule, a, negative);
    const destB = destination(rule, b, negative);
    if (destA === null || destB === null) continue;
    const hitA = hit(destA, a, negative);
    const hitB = hit(destB, b, negative);
    cell.a += hitA ? 1 : 0;
    cell.b += hitB ? 1 : 0;
    if (!hitA && hitB) cell.gains += 1;
    if (hitA && !hitB) cell.losses += 1;
    if (destA !== destB) cell.changed += 1;
  }
  cell.balance = cell.gains - cell.losses;
  return cell;
}

export function compareVariants(
  a: readonly CollectRecord[],
  b: readonly CollectRecord[],
  options: { groupIds?: ReadonlySet<string> } = {},
): Comparison {
  const { pairs, onlyA, onlyB } = pairsOf(a, b);
  const eligible = pairs.filter(({ a: ra }) => ra.originalGroupId !== null && (options.groupIds === undefined || options.groupIds.has(ra.originalGroupId)));
  const hasD = a.some((r) => r.d != null) && b.some((r) => r.d != null);
  const rules: (JevRule | "D")[] = [...JEV_RULES, ...(hasD ? (["D"] as const) : [])];
  return {
    rules: rules.map((rule) => {
      const pos = cellOf(rule, eligible, false);
      const neg = cellOf(rule, eligible, true);
      return { rule: rule === "D" ? "D" : LABEL[rule], pos, neg, sum: add(pos, neg) };
    }),
    paired: pairs.length,
    onlyA,
    onlyB,
  };
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const row = (label: string, c: CompareCell): string => `| ${label} | ${c.a} | ${c.b} | ${c.gains} | ${c.losses} | ${signed(c.balance)} | ${c.changed} |`;
const HEADER = ["| A | B | Ganhos | Perdas | Saldo | Mudaram de destino |", "| --- | --- | --- | --- | --- | --- |"];
const cellText = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderCompareReport(
  a: readonly CollectRecord[],
  b: readonly CollectRecord[],
  ctx: { labelA: string; labelB: string; groupTitles: ReadonlyMap<string, string>; phaseGroupIds: ReadonlySet<string> | null },
): string {
  const all = compareVariants(a, b);
  const lines: string[] = [`# Comparação pareada: ${ctx.labelA} × ${ctx.labelB}`, "", `> ${NOTE}`, ""];
  lines.push(
    `Tickets pareados pelo número: ${all.paired}. Só em ${ctx.labelA}: ${all.onlyA.length}${all.onlyA.length > 0 ? ` (números ${all.onlyA.join(", ")})` : ""}. Só em ${ctx.labelB}: ${all.onlyB.length}${all.onlyB.length > 0 ? ` (números ${all.onlyB.join(", ")})` : ""}. Primeira repetição de cada coleta. Ganho: A errou e B acertou; perda: A acertou e B errou; saldo: ganhos menos perdas. Positivo acerta no agrupador original; negativo acerta na raiz.`,
    "",
  );
  for (const [title, pick] of [
    ["Positivo", (r: RuleCompare) => r.pos],
    ["Negativo", (r: RuleCompare) => r.neg],
    ["Soma", (r: RuleCompare) => r.sum],
  ] as const) {
    lines.push(`## ${title}`, "", `| Regra ${HEADER[0]}`, `| --- ${HEADER[1]}`);
    for (const r of all.rules) lines.push(row(r.rule, pick(r)));
    lines.push("");
  }

  if (ctx.phaseGroupIds !== null) {
    const allGroups = new Set(a.concat(b).flatMap((r) => (r.originalGroupId === null ? [] : [r.originalGroupId])));
    const subject = new Set([...allGroups].filter((g) => !(ctx.phaseGroupIds as ReadonlySet<string>).has(g)));
    lines.push("## R0 por tipo de agrupador", "");
    for (const [title, groupIds] of [
      ["De fase", ctx.phaseGroupIds],
      ["De assunto", subject],
    ] as const) {
      const r0 = compareVariants(a, b, { groupIds }).rules.find((r) => r.rule === "R0") as RuleCompare;
      lines.push(`### ${title}`, "", `| Parte ${HEADER[0]}`, `| --- ${HEADER[1]}`, row("Positivo", r0.pos), row("Negativo", r0.neg), row("Soma", r0.sum), "");
    }
  }

  const { pairs } = pairsOf(a, b);
  const name = (dest: string | null): string => (dest === null ? "—" : dest === ROOT ? "raiz" : (ctx.groupTitles.get(dest) ?? dest));
  const changed = pairs
    .filter(({ a: ra }) => ra.originalGroupId !== null)
    .map(({ a: ra, b: rb }) => ({
      ra,
      posA: destination("R0", ra, false),
      posB: destination("R0", rb, false),
      negA: destination("R0", ra, true),
      negB: destination("R0", rb, true),
    }))
    .filter((x) => x.posA !== x.posB || x.negA !== x.negB);
  lines.push("## Tickets que mudaram de destino na R0", "");
  if (changed.length === 0) lines.push("Nenhum.", "");
  else {
    lines.push("| # | Título | Original | Positivo em A | Positivo em B | Negativo em A | Negativo em B |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const x of changed) {
      lines.push(
        `| ${x.ra.number} | ${cellText(x.ra.title)} | ${cellText(name(x.ra.originalGroupId))} | ${cellText(name(x.posA))} | ${cellText(name(x.posB))} | ${cellText(name(x.negA))} | ${cellText(name(x.negB))} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

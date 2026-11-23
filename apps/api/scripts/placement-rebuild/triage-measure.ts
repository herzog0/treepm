import { readFileSync, writeFileSync } from "node:fs";
import { createPrismaClient, withTenant } from "@treepm/db";
import { descriptionExcerpt, fuseBy, RELATED_SHORTLIST, ticketEmbeddingText, triageRelated } from "@treepm/domain";
import type { FusionRule } from "@treepm/domain";
import type { IdeaStage, TicketStatus } from "@treepm/domain";
import { EMBEDDING_DIMENSIONS } from "../../src/assistant/ports.js";
import { SEMANTIC_MAX_DISTANCE } from "../../src/assistant/semantic-triage.js";
import type { EmbeddingKind, EmbeddingProvider } from "../../src/assistant/ports.js";
import { liveTickets } from "../../src/assistant/branch-tree.js";
import { loadConfig } from "../../src/config.js";
import { EMBEDDING_SYNC_MAX, loadEmbeddableTickets, nearestTickets, syncEmbeddings } from "../../src/assistant/ticket-embeddings.js";
import type { EmbeddingStore } from "../../src/assistant/ticket-embeddings.js";
import { requireAssistantConsentOfOrg } from "./consent.js";
import type { CliOptions } from "./core.js";
import { embeddingProviderFor, refuseFakeOverReal } from "./embeddings-kit.js";

/**
 * `triage-measure` (ADR 0053, item 8): mede só a triagem de relacionados, sem Jev nem Claude. Para cada par (consulta, esperado)
 * dá a posição do esperado em listas de até N (padrão 30): só palavras, só vetor e as fusões pedidas por `--fusion` (soma de
 * posições `rrf` e intercalação `interleave`; as duas por padrão). Os vetores são determinísticos; por isso a triagem é medida
 * à parte do resto, que oscila. Pares: (a) toda ligação "depende de" entre tickets vivos (a origem é a consulta e fica fora dos
 * candidatos; o alvo é o esperado); (b) com `--mentions`, cada citação de um ticket vivo na descrição de outro (quem cita é a
 * consulta e fica fora, com os descendentes; o citado é o esperado; citação de ancestral ou de descendente direto não conta);
 * (c) os do arquivo `--pairs`. A saída mostra chaves de ticket e números, nunca título ou texto, e a conferência do aceite vem
 * ANTES de ler ticket ou criar provedor. Perda não é erro de execução: a coordenação lê os números.
 */
const DEFAULT_LIMIT = RELATED_SHORTLIST;
const NEAR = 10;

export type FusionChoice = "rrf" | "interleave" | "both";
export type PairOrigin = "dependency" | "mention" | "file";
export type ExtraPair = { query: { title: string; description: string }; expect: string[]; omit?: string[] };
export type TriageItem = {
  pair: string;
  origin: PairOrigin;
  expected: string;
  words: number | null;
  vector: number | null;
  /** Posição na soma de posições; `null` se não achou ou se a fusão não foi pedida. */
  rrf: number | null;
  /** Posição na intercalação; `null` se não achou ou se a fusão não foi pedida. */
  interleave: number | null;
  /** Distância do cosseno do esperado (mesmo fora do limiar); `null` se nem entre os vizinhos pedidos. */
  distance: number | null;
};
/** Contagens de um grupo de esperados. `rrf` e `interleave` ficam `null` quando a fusão não foi pedida. */
export type Counts = { words: number; vector: number; rrf: number | null; interleave: number | null };
export type GroupSummary = {
  items: number;
  top10: Counts;
  topN: Counts;
  /** Achados pelas palavras entre os 10 que a fusão tirou dos 10 (rebaixados). */
  demoted: { rrf: number | null; interleave: number | null };
  /** Achados pelas palavras entre os N que a fusão deixou de fora. */
  lost: { rrf: number | null; interleave: number | null };
  /** Achados pela fusão entre os N e não pelas palavras. */
  gained: { rrf: number | null; interleave: number | null };
};
export type TriageSummary = {
  limit: number;
  fusion: FusionChoice;
  total: GroupSummary;
  groups: Record<PairOrigin, GroupSummary>;
  /** Chaves `par>esperado` dos achados das palavras que cada fusão perdeu entre os N. */
  lostKeys: { rrf: string[]; interleave: string[] };
  /** Distâncias dos esperados e do 10º e do último vizinho (medianas dos pares), para escolher o limiar. */
  distances: { expectedMin: number | null; expectedMedian: number | null; expectedMax: number | null; neighbour10Median: number | null; neighbourNMedian: number | null };
  maxDistance: number;
};
export type TriageReport = { kind: EmbeddingKind; model: string; items: TriageItem[]; summary: TriageSummary };

export class TriageMeasureError extends Error {
  override name = "TriageMeasureError";
}

type Row = { id: string; number: number; parentId: string | null; title: string; description: string; status: string; ideaStage: string | null };

export function parsePairsFile(raw: string): ExtraPair[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TriageMeasureError("O arquivo --pairs não é JSON válido.");
  }
  if (!Array.isArray(value)) throw new TriageMeasureError("O arquivo --pairs deve ser uma lista de pares.");
  return value.map((entry: unknown, index) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const q = (typeof e["query"] === "object" && e["query"] !== null ? e["query"] : {}) as Record<string, unknown>;
    const keys = (name: string, required: boolean): string[] => {
      const field = e[name];
      if (field === undefined && !required) return [];
      if (!Array.isArray(field) || field.some((k) => typeof k !== "string") || (required && field.length === 0)) throw new TriageMeasureError(`Par ${index + 1}: "${name}" deve ser uma lista de chaves de ticket${required ? " (ao menos uma)" : ""}.`);
      return field as string[];
    };
    if (typeof q["title"] !== "string" || q["title"].trim() === "") throw new TriageMeasureError(`Par ${index + 1}: "query.title" é obrigatório.`);
    return { query: { title: q["title"], description: typeof q["description"] === "string" ? q["description"] : "" }, expect: keys("expect", true), omit: keys("omit", false) };
  });
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)] as number;
};
const positionOf = (list: readonly string[], id: string): number | null => (list.indexOf(id) < 0 ? null : list.indexOf(id) + 1);

export type MeasureContext = {
  store: EmbeddingStore;
  projectId: string;
  provider: EmbeddingProvider;
  kind: EmbeddingKind;
  extra: readonly ExtraPair[];
  log: (line: string) => void;
  /** Limiar de distância dos vizinhos (`SEMANTIC_MAX_DISTANCE` por padrão). */
  maxDistance?: number;
  /** Quais fusões medir (`both` por padrão). */
  fusion?: FusionChoice;
  /** Tamanho das listas (30 por padrão). */
  limit?: number;
  /** Inclui os pares por citação na descrição. */
  mentions?: boolean;
  /** Tickets por lote da sincronização; só os testes trocam. */
  max?: number;
};

const RULES: Record<FusionChoice, readonly FusionRule[]> = { rrf: ["rrf"], interleave: ["interleave"], both: ["rrf", "interleave"] };

export async function measureTriage(ctx: MeasureContext): Promise<TriageReport> {
  const limit = ctx.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new TriageMeasureError("--limit deve ser um inteiro maior que zero.");
  const choice = ctx.fusion ?? "both";
  const rules = RULES[choice];
  if (ctx.provider.model === "fake") await refuseFakeOverReal(ctx.store, ctx.projectId);
  const { rows, projectKey, relations, mentions } = await ctx.store.run(async (tx) => {
    const all = await tx.$queryRaw<Row[]>`select id, number, parent_id as "parentId", title, left(description, 8000) as description, status, idea_stage as "ideaStage" from tickets where project_id = ${ctx.projectId}::uuid order by number`;
    const project = await tx.project.findFirstOrThrow({ where: { id: ctx.projectId }, select: { key: true } });
    const rel = await tx.$queryRaw<{ from: string; to: string }[]>`select from_ticket_id as "from", to_ticket_id as "to" from ticket_relations where project_id = ${ctx.projectId}::uuid and kind = 'depends_on' order by from_ticket_id, to_ticket_id`;
    const cited = ctx.mentions ? await tx.$queryRaw<{ from: string; to: string }[]>`select from_ticket_id as "from", to_ticket_id as "to" from ticket_relations where project_id = ${ctx.projectId}::uuid and kind = 'mentions' order by from_ticket_id, to_ticket_id` : [];
    return { rows: all, projectKey: project.key, relations: rel, mentions: cited };
  });
  const live = liveTickets(rows.map((t) => ({ ...t, status: t.status as TicketStatus, ideaStage: (t.ideaStage ?? null) as IdeaStage | null })));
  const byId = new Map(live.map((t) => [t.id, t]));
  const keyOf = (id: string): string => `${projectKey}-${(byId.get(id) as Row).number}`;
  const byKey = new Map(live.map((t) => [keyOf(t.id), t]));
  const descendantsOf = (roots: Iterable<string>): Set<string> => {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      out.add(id);
      for (const t of live) if (t.parentId === id) stack.push(t.id);
    }
    return out;
  };
  const isAncestor = (maybe: string, of: string): boolean => {
    for (let cursor = byId.get(of)?.parentId ?? null, guard = 0; cursor !== null && guard <= live.length; cursor = byId.get(cursor)?.parentId ?? null, guard += 1) if (cursor === maybe) return true;
    return false;
  };

  // Põe os vetores do projeto em dia, com o provedor escolhido, antes de medir.
  const embeddable = await ctx.store.run((tx) => loadEmbeddableTickets(tx, ctx.projectId));
  for (let batch = 1; ; batch += 1) {
    const sync = await syncEmbeddings(ctx.store, { projectId: ctx.projectId, tickets: embeddable, provider: ctx.provider, max: ctx.max ?? EMBEDDING_SYNC_MAX, deadlineMs: 120_000 });
    ctx.log(`vetores, lote ${batch}: em dia ao começar ${sync.upToDate}, gravados ${sync.embedded}, pendentes ${sync.pending}`);
    if (sync.failure !== undefined) throw new TriageMeasureError(`A sincronização dos vetores falhou (${sync.failure}); nada foi medido.`);
    if (sync.pending === 0) break;
    if (sync.embedded === 0) throw new TriageMeasureError("A sincronização dos vetores não avançou; nada foi medido.");
  }

  type Pair = { label: string; origin: PairOrigin; query: { title: string; description: string }; expected: string[]; omit: Set<string> };
  const pairs: Pair[] = [];
  for (const rel of relations) {
    const from = byId.get(rel.from);
    if (!from || !byId.has(rel.to)) continue;
    pairs.push({ label: keyOf(from.id), origin: "dependency", query: { title: from.title, description: from.description }, expected: [rel.to], omit: new Set([from.id]) });
  }
  // Citações: quem cita é a consulta e sai dos candidatos com os descendentes; citação de si, de ancestral ou de filho direto não é par.
  const citedBy = new Map<string, string[]>();
  for (const m of mentions) {
    const from = byId.get(m.from);
    const to = byId.get(m.to);
    if (!from || !to || from.id === to.id || isAncestor(to.id, from.id) || to.parentId === from.id) continue;
    citedBy.set(from.id, [...(citedBy.get(from.id) ?? []), to.id]);
  }
  for (const [fromId, targets] of citedBy) {
    const from = byId.get(fromId) as Row;
    pairs.push({ label: keyOf(fromId), origin: "mention", query: { title: from.title, description: from.description }, expected: [...new Set(targets)], omit: descendantsOf([fromId]) });
  }
  const resolveKey = (key: string, what: string): string => {
    const ticket = byKey.get(key);
    if (!ticket) throw new TriageMeasureError(`${what} ${key} não é um ticket vivo do projeto.`);
    return ticket.id;
  };
  ctx.extra.forEach((pair, index) => {
    const omit = descendantsOf(pair.omit?.map((key) => resolveKey(key, "\"omit\"")) ?? []);
    pairs.push({ label: `extra-${index + 1}`, origin: "file", query: pair.query, expected: pair.expect.map((key) => resolveKey(key, "\"expect\"")), omit });
  });
  if (pairs.length === 0) throw new TriageMeasureError("Não há pares para medir: o projeto não tem ligação \"depende de\" entre tickets vivos (nem citações, com --mentions) e não veio --pairs.");

  // UMA consulta ao provedor por lote de 128 textos, depois os vizinhos de cada par (k maior para compensar o que sai por `omit`).
  const vectors: number[][] = [];
  for (let start = 0; start < pairs.length; start += 128) {
    const chunk = pairs.slice(start, start + 128);
    const out = await ctx.provider.embed(chunk.map((p) => ticketEmbeddingText(p.query)), ctx.kind, { signal: AbortSignal.timeout(120_000) });
    if (out.length !== chunk.length || out.some((v) => v.length !== EMBEDDING_DIMENSIONS)) throw new TriageMeasureError("O provedor devolveu vetores malformados; nada foi medido.");
    vectors.push(...out);
  }
  const items: TriageItem[] = [];
  const maxDistance = ctx.maxDistance ?? SEMANTIC_MAX_DISTANCE;
  const n10: number[] = [];
  const nLast: number[] = [];
  const candidatesBase = live.map((t) => ({ id: t.id, title: t.title, excerpt: descriptionExcerpt(t.description) }));
  for (const [index, pair] of pairs.entries()) {
    const candidates = candidatesBase.filter((t) => !pair.omit.has(t.id));
    const wordsList = triageRelated({ ...pair.query, partTitles: [] }, candidates, limit).map((hit) => hit.id);
    const near = await ctx.store.run((tx, orgId) => nearestTickets(tx, { orgId, projectId: ctx.projectId, model: ctx.provider.model, vector: vectors[index] as number[], k: limit + pair.omit.size }));
    const kept = near.filter((n) => !pair.omit.has(n.ticketId) && byId.has(n.ticketId));
    if (kept[NEAR - 1]) n10.push(kept[NEAR - 1]!.distance);
    if (kept[limit - 1]) nLast.push(kept[limit - 1]!.distance);
    const vectorList = kept.filter((n) => n.distance <= maxDistance).slice(0, limit).map((n) => n.ticketId);
    const fused = new Map<FusionRule, string[]>(rules.map((rule) => [rule, fuseBy(rule, wordsList, vectorList, limit).map((hit) => hit.id)]));
    for (const expected of pair.expected) {
      items.push({
        pair: pair.label,
        origin: pair.origin,
        expected: keyOf(expected),
        words: positionOf(wordsList, expected),
        vector: positionOf(vectorList, expected),
        rrf: fused.has("rrf") ? positionOf(fused.get("rrf") as string[], expected) : null,
        interleave: fused.has("interleave") ? positionOf(fused.get("interleave") as string[], expected) : null,
        distance: kept.find((n) => n.ticketId === expected)?.distance ?? null,
      });
    }
  }
  const sorted = items.flatMap((i) => (i.distance === null ? [] : [i.distance])).sort((a, b) => a - b);
  const groups = { dependency: summarize(items.filter((i) => i.origin === "dependency"), rules, limit), mention: summarize(items.filter((i) => i.origin === "mention"), rules, limit), file: summarize(items.filter((i) => i.origin === "file"), rules, limit) };
  const lostKeys = (field: "rrf" | "interleave"): string[] => (rules.includes(field) ? items.filter((i) => i.words !== null && i[field] === null).map((i) => `${i.pair}>${i.expected}`) : []);
  const summary: TriageSummary = {
    limit,
    fusion: choice,
    total: summarize(items, rules, limit),
    groups,
    lostKeys: { rrf: lostKeys("rrf"), interleave: lostKeys("interleave") },
    distances: { expectedMin: sorted[0] ?? null, expectedMedian: median(sorted), expectedMax: sorted[sorted.length - 1] ?? null, neighbour10Median: median(n10), neighbourNMedian: median(nLast) },
    maxDistance,
  };
  return { kind: ctx.kind, model: ctx.provider.model, items, summary };
}

/** As contagens de um grupo de esperados: achados entre os 10 e entre os N, rebaixados, perdidos e ganhos pela fusão. */
function summarize(items: readonly TriageItem[], rules: readonly FusionRule[], limit: number): GroupSummary {
  const within = (field: "words" | "vector" | "rrf" | "interleave", n: number): number => items.filter((i) => i[field] !== null && (i[field] as number) <= n).length;
  const count = (n: number): Counts => ({ words: within("words", n), vector: within("vector", n), rrf: rules.includes("rrf") ? within("rrf", n) : null, interleave: rules.includes("interleave") ? within("interleave", n) : null });
  const per = (test: (item: TriageItem, field: "rrf" | "interleave") => boolean): { rrf: number | null; interleave: number | null } => ({
    rrf: rules.includes("rrf") ? items.filter((i) => test(i, "rrf")).length : null,
    interleave: rules.includes("interleave") ? items.filter((i) => test(i, "interleave")).length : null,
  });
  return {
    items: items.length,
    top10: count(NEAR),
    topN: count(limit),
    demoted: per((i, f) => i.words !== null && i.words <= NEAR && (i[f] === null || (i[f] as number) > NEAR)),
    lost: per((i, f) => i.words !== null && i[f] === null),
    gained: per((i, f) => i.words === null && i[f] !== null),
  };
}

/** As linhas do relatório: só chaves de ticket e números. */
export function renderTriage(report: TriageReport): string[] {
  const fmt = (n: number | null): string => (n === null ? "-" : n.toFixed(4));
  const show = (n: number | null): string => (n === null ? "-" : String(n));
  const s = report.summary;
  const showFusion = (field: "rrf" | "interleave"): boolean => s.fusion === "both" || s.fusion === field;
  const lines = report.items.map((i) => {
    const fusions = [...(showFusion("rrf") ? [`soma=${show(i.rrf)}`] : []), ...(showFusion("interleave") ? [`intercalação=${show(i.interleave)}`] : [])].join("  ");
    return `${i.pair} -> ${i.expected}  [${i.origin === "dependency" ? "depende-de" : i.origin === "mention" ? "citação" : "arquivo"}]  palavras=${show(i.words)}  vetor=${show(i.vector)}  ${fusions}  distância=${i.distance === null ? "-" : i.distance.toFixed(4)}`;
  });
  const counts = (c: Counts): string => [`palavras ${c.words}`, `vetor ${c.vector}`, ...(c.rrf === null ? [] : [`soma ${c.rrf}`]), ...(c.interleave === null ? [] : [`intercalação ${c.interleave}`])].join(", ");
  const pair = (v: { rrf: number | null; interleave: number | null }): string => [...(v.rrf === null ? [] : [`soma ${v.rrf}`]), ...(v.interleave === null ? [] : [`intercalação ${v.interleave}`])].join(", ");
  const group = (name: string, g: GroupSummary): string[] => [
    `${name} (${g.items} esperados)`,
    `  entre os 10: ${counts(g.top10)}`,
    `  entre os ${s.limit}: ${counts(g.topN)}`,
    `  achados pelas palavras entre os 10 que a fusão tirou dos 10: ${pair(g.demoted) || "-"}`,
    `  achados pelas palavras entre os ${s.limit} que a fusão perdeu: ${pair(g.lost) || "-"}`,
    `  achados só pela fusão (não pelas palavras): ${pair(g.gained) || "-"}`,
  ];
  lines.push(
    `resumo (consulta ${report.kind}; modelo ${report.model}; fusão ${s.fusion}; listas de ${s.limit})`,
    ...group("total", s.total),
    ...group("depende-de", s.groups.dependency),
    ...group("citações", s.groups.mention),
    ...group("arquivo", s.groups.file),
  );
  for (const field of ["rrf", "interleave"] as const) if (s.lostKeys[field].length > 0) lines.push(`  perdidos pela ${field === "rrf" ? "soma" : "intercalação"}: ${s.lostKeys[field].join(", ")}`);
  lines.push(`  limiar de distância: ${s.maxDistance}; esperados: mín ${fmt(s.distances.expectedMin)}, mediana ${fmt(s.distances.expectedMedian)}, máx ${fmt(s.distances.expectedMax)}; 10º vizinho (mediana) ${fmt(s.distances.neighbour10Median)}, ${s.limit}º ${fmt(s.distances.neighbourNMedian)}`);
  return lines;
}

export type TriageRunDeps = { log: (line: string) => void; providerFor?: typeof embeddingProviderFor; onConnect?: () => void };

/** O comando: aceite primeiro, depois banco e provedor. Devolve 0 quando a medição roda (perda não é erro); erro lança. */
export async function runTriageMeasure(options: CliOptions & { pairsFile?: string; jsonFile?: string; kinds?: string; maxDistance?: number; fusion?: string; mentions?: boolean }, deps: TriageRunDeps): Promise<number> {
  const config = loadConfig(process.env);
  await requireAssistantConsentOfOrg(config, options.org as string);
  const kind = (options.kinds ?? "query") as EmbeddingKind;
  if (kind !== "query" && kind !== "document") throw new TriageMeasureError("--kinds é `query` ou `document`.");
  const fusion = (options.fusion ?? "both") as FusionChoice;
  if (fusion !== "rrf" && fusion !== "interleave" && fusion !== "both") throw new TriageMeasureError("--fusion é `rrf`, `interleave` ou `both`.");
  const extra = options.pairsFile === undefined ? [] : parsePairsFile(readFileSync(options.pairsFile, "utf8"));
  const fake = options.fakeProviders ?? false;
  const provider = (deps.providerFor ?? embeddingProviderFor)(config, fake);
  if (provider === null) throw new TriageMeasureError("A medição precisa de VOYAGE_API_KEY (ou de --fake-providers, só para ensaio). Nada foi enviado.");
  deps.onConnect?.();
  const orgId = options.org as string;
  const prisma = createPrismaClient(config.DATABASE_URL);
  try {
    const report = await measureTriage({
      store: { run: (fn) => withTenant(prisma, { orgId, userId: options.user as string }, (tx) => fn(tx, orgId)) },
      projectId: options.project as string,
      provider,
      kind,
      extra,
      fusion,
      mentions: options.mentions ?? false,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
      log: deps.log,
    });
    for (const line of renderTriage(report)) deps.log(line);
    if (options.jsonFile !== undefined) writeFileSync(options.jsonFile, `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

import { readFileSync, writeFileSync } from "node:fs";
import { createPrismaClient, withTenant } from "@treepm/db";
import { descriptionExcerpt, fuseRankings, RELATED_SHORTLIST, ticketEmbeddingText, triageRelated } from "@treepm/domain";
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
 * dá a posição do esperado em três listas de até 30 (só palavras, só vetor, fusão). Os vetores são determinísticos; por isso a
 * triagem é medida à parte do resto, que oscila. Pares: (a) toda ligação "depende de" entre tickets vivos (a origem é a consulta
 * e fica fora dos candidatos; o alvo é o esperado); (b) os do arquivo `--pairs`. A saída mostra chaves de ticket e números,
 * nunca título ou texto, e a conferência do aceite vem ANTES de ler ticket ou criar provedor.
 */
const TOP = RELATED_SHORTLIST;
const NEAR = 10;

export type ExtraPair = { query: { title: string; description: string }; expect: string[]; omit?: string[] };
export type TriageItem = { pair: string; origin: "dependency" | "file"; expected: string; words: number | null; vector: number | null; fused: number | null; /** Distância do cosseno do esperado (mesmo fora do limiar); `null` se nem entre os vizinhos pedidos. */ distance: number | null };
export type TriageSummary = {
  items: number;
  top10: { words: number; vector: number; fused: number };
  top30: { words: number; vector: number; fused: number };
  /** Achados por palavras entre os 30 que a fusão deixou de fora: tem de ser 0 (critério da ADR 0053). */
  lostByFusion: number;
  lostKeys: string[];
  /** Achados pela fusão entre os 30 e não pelas palavras. */
  gainedByFusion: number;
  /** Distâncias dos esperados e do 10º e do 30º vizinho (medianas dos pares), para escolher o limiar. */
  distances: { expectedMin: number | null; expectedMedian: number | null; expectedMax: number | null; neighbour10Median: number | null; neighbour30Median: number | null };
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
  /** Tickets por lote da sincronização; só os testes trocam. */
  max?: number;
};

export async function measureTriage(ctx: MeasureContext): Promise<TriageReport> {
  if (ctx.provider.model === "fake") await refuseFakeOverReal(ctx.store, ctx.projectId);
  const { rows, projectKey, relations } = await ctx.store.run(async (tx) => {
    const all = await tx.$queryRaw<Row[]>`select id, number, parent_id as "parentId", title, left(description, 8000) as description, status, idea_stage as "ideaStage" from tickets where project_id = ${ctx.projectId}::uuid order by number`;
    const project = await tx.project.findFirstOrThrow({ where: { id: ctx.projectId }, select: { key: true } });
    const rel = await tx.$queryRaw<{ from: string; to: string }[]>`select from_ticket_id as "from", to_ticket_id as "to" from ticket_relations where project_id = ${ctx.projectId}::uuid and kind = 'depends_on'`;
    return { rows: all, projectKey: project.key, relations: rel };
  });
  const live = liveTickets(rows.map((t) => ({ ...t, status: t.status as TicketStatus, ideaStage: (t.ideaStage ?? null) as IdeaStage | null })));
  const byId = new Map(live.map((t) => [t.id, t]));
  const keyOf = (id: string): string => `${projectKey}-${(byId.get(id) as Row).number}`;
  const byKey = new Map(live.map((t) => [keyOf(t.id), t]));

  // Põe os vetores do projeto em dia, com o provedor escolhido, antes de medir.
  const embeddable = await ctx.store.run((tx) => loadEmbeddableTickets(tx, ctx.projectId));
  for (let batch = 1; ; batch += 1) {
    const sync = await syncEmbeddings(ctx.store, { projectId: ctx.projectId, tickets: embeddable, provider: ctx.provider, max: ctx.max ?? EMBEDDING_SYNC_MAX, deadlineMs: 120_000 });
    ctx.log(`vetores, lote ${batch}: em dia ao começar ${sync.upToDate}, gravados ${sync.embedded}, pendentes ${sync.pending}`);
    if (sync.failure !== undefined) throw new TriageMeasureError(`A sincronização dos vetores falhou (${sync.failure}); nada foi medido.`);
    if (sync.pending === 0) break;
    if (sync.embedded === 0) throw new TriageMeasureError("A sincronização dos vetores não avançou; nada foi medido.");
  }

  type Pair = { label: string; origin: "dependency" | "file"; query: { title: string; description: string }; expected: string[]; omit: Set<string> };
  const pairs: Pair[] = [];
  for (const rel of relations) {
    const from = byId.get(rel.from);
    if (!from || !byId.has(rel.to)) continue;
    pairs.push({ label: keyOf(from.id), origin: "dependency", query: { title: from.title, description: from.description }, expected: [rel.to], omit: new Set([from.id]) });
  }
  const resolveKey = (key: string, what: string): string => {
    const ticket = byKey.get(key);
    if (!ticket) throw new TriageMeasureError(`${what} ${key} não é um ticket vivo do projeto.`);
    return ticket.id;
  };
  ctx.extra.forEach((pair, index) => {
    const omit = new Set<string>();
    const stack = pair.omit?.map((key) => resolveKey(key, "\"omit\"")) ?? [];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (omit.has(id)) continue;
      omit.add(id);
      for (const t of live) if (t.parentId === id) stack.push(t.id);
    }
    pairs.push({ label: `extra-${index + 1}`, origin: "file", query: pair.query, expected: pair.expect.map((key) => resolveKey(key, "\"expect\"")), omit });
  });
  if (pairs.length === 0) throw new TriageMeasureError("Não há pares para medir: o projeto não tem ligação \"depende de\" entre tickets vivos e não veio --pairs.");

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
  const n30: number[] = [];
  const candidatesBase = live.map((t) => ({ id: t.id, title: t.title, excerpt: descriptionExcerpt(t.description) }));
  for (const [index, pair] of pairs.entries()) {
    const candidates = candidatesBase.filter((t) => !pair.omit.has(t.id));
    const wordsList = triageRelated({ ...pair.query, partTitles: [] }, candidates, TOP).map((hit) => hit.id);
    const near = await ctx.store.run((tx, orgId) => nearestTickets(tx, { orgId, projectId: ctx.projectId, model: ctx.provider.model, vector: vectors[index] as number[], k: TOP + pair.omit.size }));
    const kept = near.filter((n) => !pair.omit.has(n.ticketId) && byId.has(n.ticketId));
    if (kept[NEAR - 1]) n10.push(kept[NEAR - 1]!.distance);
    if (kept[TOP - 1]) n30.push(kept[TOP - 1]!.distance);
    const vectorList = kept.filter((n) => n.distance <= maxDistance).slice(0, TOP).map((n) => n.ticketId);
    const fusedList = fuseRankings(wordsList, vectorList, TOP).map((hit) => hit.id);
    for (const expected of pair.expected) {
      items.push({ pair: pair.label, origin: pair.origin, expected: keyOf(expected), words: positionOf(wordsList, expected), vector: positionOf(vectorList, expected), fused: positionOf(fusedList, expected), distance: kept.find((n) => n.ticketId === expected)?.distance ?? null });
    }
  }
  const within = (field: "words" | "vector" | "fused", n: number): number => items.filter((i) => i[field] !== null && (i[field] as number) <= n).length;
  const sorted = items.flatMap((i) => (i.distance === null ? [] : [i.distance])).sort((a, b) => a - b);
  const lost = items.filter((i) => i.words !== null && i.fused === null);
  const summary: TriageSummary = {
    items: items.length,
    top10: { words: within("words", NEAR), vector: within("vector", NEAR), fused: within("fused", NEAR) },
    top30: { words: within("words", TOP), vector: within("vector", TOP), fused: within("fused", TOP) },
    lostByFusion: lost.length,
    lostKeys: lost.map((i) => `${i.pair}>${i.expected}`),
    gainedByFusion: items.filter((i) => i.words === null && i.fused !== null).length,
    distances: { expectedMin: sorted[0] ?? null, expectedMedian: median(sorted), expectedMax: sorted[sorted.length - 1] ?? null, neighbour10Median: median(n10), neighbour30Median: median(n30) },
    maxDistance,
  };
  return { kind: ctx.kind, model: ctx.provider.model, items, summary };
}

/** As linhas do relatório: só chaves de ticket e números. */
export function renderTriage(report: TriageReport): string[] {
  const fmt = (n: number | null): string => (n === null ? "-" : n.toFixed(4));
  const show = (n: number | null): string => (n === null ? "-" : String(n));
  const lines = report.items.map((i) => `${i.pair} -> ${i.expected}  palavras=${show(i.words)}  vetor=${show(i.vector)}  fusão=${show(i.fused)}  distância=${i.distance === null ? "-" : i.distance.toFixed(4)}`);
  const s = report.summary;
  lines.push(
    `resumo (${s.items} esperados; consulta ${report.kind}; modelo ${report.model})`,
    `  entre os 10: palavras ${s.top10.words}, vetor ${s.top10.vector}, fusão ${s.top10.fused}`,
    `  entre os 30: palavras ${s.top30.words}, vetor ${s.top30.vector}, fusão ${s.top30.fused}`,
    `  achados por palavras entre os 30 que a fusão perdeu: ${s.lostByFusion}${s.lostKeys.length > 0 ? ` (${s.lostKeys.join(", ")})` : ""}`,
    `  achados só pela fusão (não pelas palavras): ${s.gainedByFusion}`,
    `  limiar de distância: ${s.maxDistance}; esperados: mín ${fmt(s.distances.expectedMin)}, mediana ${fmt(s.distances.expectedMedian)}, máx ${fmt(s.distances.expectedMax)}; 10º vizinho (mediana) ${fmt(s.distances.neighbour10Median)}, 30º ${fmt(s.distances.neighbour30Median)}`,
  );
  return lines;
}

/** 1 quando a fusão perdeu algum achado das palavras (o critério da ADR 0053 é zero); senão 0. */
export const exitCodeOf = (report: TriageReport): number => (report.summary.lostByFusion > 0 ? 1 : 0);

export type TriageRunDeps = { log: (line: string) => void; providerFor?: typeof embeddingProviderFor; onConnect?: () => void };

/** O comando: aceite primeiro, depois banco e provedor. Devolve 0, ou 1 se a fusão perdeu algum achado das palavras. */
export async function runTriageMeasure(options: CliOptions & { pairsFile?: string; jsonFile?: string; kinds?: string; maxDistance?: number }, deps: TriageRunDeps): Promise<number> {
  const config = loadConfig(process.env);
  await requireAssistantConsentOfOrg(config, options.org as string);
  const kind = (options.kinds ?? "query") as EmbeddingKind;
  if (kind !== "query" && kind !== "document") throw new TriageMeasureError("--kinds é `query` ou `document`.");
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
      ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
      log: deps.log,
    });
    for (const line of renderTriage(report)) deps.log(line);
    if (options.jsonFile !== undefined) writeFileSync(options.jsonFile, `${JSON.stringify(report, null, 2)}\n`);
    return exitCodeOf(report);
  } finally {
    await prisma.$disconnect();
  }
}

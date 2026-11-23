import type pg from "pg";
import type { TimedQuery } from "./query-recorder.js";

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
};
const SCANS = new Set(["Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"]);

export type ExplainedReads = {
  /** Linhas que o executor leu nas tabelas (as devolvidas mais as descartadas pelo filtro), somadas sobre todos os `loops`. */
  scanned: number;
  /** Varreduras sequenciais de `tickets`: o sinal de uma busca proporcional ao projeto. */
  seqScansOfTickets: number;
  /** Quantas consultas foram refeitas e quantas ficaram de fora (escritas, controle). */
  replayed: number;
};

function walk(node: PlanNode, acc: { scanned: number; seq: number }): void {
  if (SCANS.has(node["Node Type"])) {
    acc.scanned += ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 1);
    if (node["Node Type"] === "Seq Scan" && node["Relation Name"] === "tickets") acc.seq += 1;
  }
  for (const child of node.Plans ?? []) walk(child, acc);
}

/**
 * Refaz as LEITURAS (`select`/`with`) de uma requisição já gravada com `EXPLAIN (ANALYZE, BUFFERS)`, numa transação desfeita, com o
 * papel da aplicação e a organização/usuário dados (a mesma RLS da requisição), e soma as linhas que o executor leu. É o que
 * `recordQueries` não vê: uma busca que varre o projeto e devolve 0 linhas parece barata pelas linhas devolvidas.
 * Não depende das estatísticas do servidor (`pg_stat_*`), que chegam com atraso. As escritas e as consultas de contexto não são
 * refeitas. Uma leitura que não pôde ser refeita é erro (senão o custo seria subcontado em silêncio).
 */
export async function explainReads(appPool: pg.Pool, who: { orgId: string; userId: string }, queries: readonly Pick<TimedQuery, "text" | "values">[]): Promise<ExplainedReads> {
  const acc = { scanned: 0, seq: 0 };
  let replayed = 0;
  const client = await appPool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [who.orgId, who.userId]);
    for (const q of queries) {
      if (!/^\s*(select|with)\b/i.test(q.text) || /set_config|pg_advisory|current_setting|app_uuid_v7/i.test(q.text)) continue;
      const res = await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>({ text: `explain (analyze, buffers, format json) ${q.text}`, values: q.values as unknown[] });
      walk(res.rows[0]!["QUERY PLAN"][0]!.Plan, acc);
      replayed += 1;
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  return { scanned: acc.scanned, seqScansOfTickets: acc.seq, replayed };
}

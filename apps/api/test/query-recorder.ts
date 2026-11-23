import pg from "pg";

export type RecordedQuery = { text: string; rows: number; params: number; chars: number };

/** Uma consulta com o tempo, incluindo as de controle (BEGIN, COMMIT, trava): só a medição por caminho usa. */
export type TimedQuery = { text: string; values: unknown[]; startedAt: number; endedAt: number; rows: number };

let sink: RecordedQuery[] | null = null;
let timedSink: TimedQuery[] | null = null;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const original = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  (pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] };
    const text = typeof first === "string" ? first : (first?.text ?? "");
    const values = (typeof first === "string" ? args[1] : first?.values) as unknown[] | undefined;
    const startedAt = performance.now();
    const result = original.apply(this, args) as Promise<{ rows?: unknown[] }> | undefined;
    const target = sink;
    const timed = timedSink;
    if ((target !== null || timed !== null) && result && typeof result.then === "function") {
      result.then((res) => {
        const endedAt = performance.now();
        const rows = res?.rows ?? [];
        target?.push({ text, rows: rows.length, params: values?.length ?? 0, chars: JSON.stringify(rows).length });
        timed?.push({ text, values: values ?? [], startedAt, endedAt, rows: rows.length });
      }, () => undefined);
    }
    return result;
  };
}

const isControl = (text: string): boolean => /^\s*(begin|commit|rollback|savepoint|release|start transaction)/i.test(text) || /set_config\('app\.org_id'/i.test(text) || /pg_advisory_xact_lock|lock_timeout/i.test(text);

/** Roda `run` anotando as consultas ao banco (sem BEGIN/COMMIT/`set_config`/trava): quantas, quantas linhas e quantos caracteres vieram. */
export async function recordQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: RecordedQuery[]; rows: number; chars: number }> {
  install();
  const mine: RecordedQuery[] = [];
  sink = mine;
  try {
    const result = await run();
    await new Promise((resolve) => setImmediate(resolve)); // deixa os `then` de registro rodarem
    const queries = mine.filter((q) => !isControl(q.text));
    return { result, queries, rows: queries.reduce((sum, q) => sum + q.rows, 0), chars: queries.reduce((sum, q) => sum + q.chars, 0) };
  } finally {
    sink = null;
  }
}

/** Todas as consultas de `run` com os instantes de início e fim (controle incluído), para medir quanto tempo a transação e a trava duram. */
export async function recordTimed<T>(run: () => Promise<T>): Promise<{ result: T; queries: TimedQuery[] }> {
  install();
  const mine: TimedQuery[] = [];
  timedSink = mine;
  try {
    const result = await run();
    await new Promise((resolve) => setImmediate(resolve));
    return { result, queries: mine };
  } finally {
    timedSink = null;
  }
}

/** Dos instantes de uma requisição: a transação inteira e o tempo que a trava de estrutura foi segurada (até o COMMIT). */
export function lockTimes(queries: readonly TimedQuery[]): { txMs: number; lockHeldMs: number | null; queryCount: number; rows: number; queryMs: number } {
  const commit = [...queries].reverse().find((q) => /^\s*commit/i.test(q.text));
  const lock = queries.find((q) => /pg_advisory_xact_lock/i.test(q.text) && String(q.values[0] ?? "").startsWith("ticket-structure:"));
  // Uma requisição abre 2 ou 3 transações (sessão, ticket, trabalho): a que conta é a que pegou a trava, ou a última.
  const begins = queries.filter((q) => /^\s*begin/i.test(q.text));
  const begin = lock ? [...begins].reverse().find((q) => q.startedAt <= lock.startedAt) : begins.at(-1);
  const work = queries.filter((q) => !isControl(q.text));
  return {
    txMs: begin && commit ? commit.endedAt - begin.startedAt : 0,
    lockHeldMs: lock && commit ? commit.endedAt - lock.endedAt : null,
    queryCount: work.length,
    rows: work.reduce((sum, q) => sum + q.rows, 0),
    queryMs: work.reduce((sum, q) => sum + (q.endedAt - q.startedAt), 0),
  };
}

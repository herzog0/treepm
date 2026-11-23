import pg from "pg";

export type RecordedQuery = { text: string; rows: number; params: number; chars: number };

let sink: RecordedQuery[] | null = null;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const original = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  (pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] };
    const text = typeof first === "string" ? first : (first?.text ?? "");
    const values = (typeof first === "string" ? args[1] : first?.values) as unknown[] | undefined;
    const result = original.apply(this, args) as Promise<{ rows?: unknown[] }> | undefined;
    const target = sink;
    if (target !== null && result && typeof result.then === "function") {
      result.then((res) => {
        const rows = res?.rows ?? [];
        target.push({ text, rows: rows.length, params: values?.length ?? 0, chars: JSON.stringify(rows).length });
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

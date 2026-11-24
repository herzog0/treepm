import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { curveMarkdown, doubtCurve } from "./doubt.js";
import type { GabaritoTicket, RunRecord } from "./core.js";

/** Os ids novos da raiz até o pai esperado, inclusive (`[]` = o pai esperado é a raiz). */
export function expectedPathOf(record: Pick<RunRecord, "expectedParentOldId">, tickets: readonly Pick<GabaritoTicket, "id" | "parentId">[], oldToNew: ReadonlyMap<string, string>): string[] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out: string[] = [];
  for (let at = record.expectedParentOldId; at !== null; at = byId.get(at)?.parentId ?? null) out.unshift(oldToNew.get(at) ?? `sem-id:${at}`);
  return out;
}

/** A tabela de uma rodada de tirar e recolocar (`records`, do `loo-*.jsonl`), no formato do relatório. */
export function curveOfRound(records: readonly RunRecord[], tickets: readonly GabaritoTicket[], oldToNew: ReadonlyMap<string, string>): string {
  const usable = records.filter((r) => !r.resumed && r.judgments.length > 0);
  return curveMarkdown(doubtCurve(usable.map((record) => ({ record, expectedPath: expectedPathOf(record, tickets, oldToNew) }))));
}

/** `doubt-curve --dir <pasta de uma rodada já gravada>`: recalcula a tabela dos arquivos `loo-*.jsonl`, `loo-map-*.json` e `gabarito.json`. */
export function doubtCurveCommand(dir: string, log: (line: string) => void): boolean {
  const names = readdirSync(dir);
  const loo = names.find((n) => /^loo-(?!map-|state-)[0-9a-f-]{36}\.jsonl$/.test(n));
  if (!loo) {
    log(`Nenhum loo-<projeto>.jsonl em ${dir}.`);
    return false;
  }
  const mapFile = join(dir, loo.replace(/^loo-/, "loo-map-").replace(/\.jsonl$/, ".json"));
  if (!existsSync(mapFile) || !existsSync(join(dir, "gabarito.json"))) {
    log("Faltam o loo-map-<projeto>.json ou o gabarito.json na pasta.");
    return false;
  }
  const records = readFileSync(join(dir, loo), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as RunRecord);
  const gabarito = JSON.parse(readFileSync(join(dir, "gabarito.json"), "utf8")) as { tickets: GabaritoTicket[] };
  const map = new Map(Object.entries(JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, string>));
  log(curveOfRound(records, gabarito.tickets, map));
  return true;
}

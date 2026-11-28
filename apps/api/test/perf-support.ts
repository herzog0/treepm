import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { expect } from "vitest";
import { loadBigProject, PERF_ADMIN_USER, PERF_ORG } from "../scripts/big-project/load.js";
import { planBigProject } from "../scripts/big-project/plan.js";
import type { BigProjectPlan } from "../scripts/big-project/plan.js";
import { sessionHeader } from "./helpers.js";

/** Instante fixo do projeto de teste: marcadores de IA valem 3 dias a partir dele, e o relógio da aplicação o usa. */
export const PERF_NOW = Date.UTC(2026, 10, 22, 12);
export const perfClock = { now: (): number => PERF_NOW };
export const perfSession = sessionHeader({ userId: PERF_ADMIN_USER, orgId: PERF_ORG, orgRole: "org:admin" });

const GOLDEN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "perf-equivalence");

/** A descrição de `length` pontos de código; usada nos casos de borda do trecho (600 pontos, pares substitutos, compostos). */
export const EDGE_DESCRIPTIONS: Record<string, string> = {
  p599: "a".repeat(599),
  p600: "b".repeat(600),
  p601: "c".repeat(601),
  emoji600: "😀".repeat(600),
  emoji601: "😀".repeat(601),
  emojiNoCorte: `${"d".repeat(599)}😀fim do texto`,
  emojiLogoDepois: `${"e".repeat(598)}😀😀😀 resto`,
  combinados: "é".repeat(400),
  combinados300: "à".repeat(300),
  familia: "👨‍👩‍👧‍👦".repeat(100),
  quebras: "linha um\r\nlinha dois\n\n\tlinha três\r".repeat(40),
  quebraNoCorte: `${"f".repeat(599)}\r\ng`,
  acentos: "Ação, coração, pão, é, ü, ñ, ç. ".repeat(40),
  cjk: "日本語のテキスト、これは長い説明です。".repeat(60),
  reticencias: "…".repeat(650),
  semDescricao: "",
  soEspacos: "   \n  ",
  curta: "Curta, com **markdown** e BG-3.",
};

export type PerfWorld = { plan: BigProjectPlan; edgeIds: Record<string, string> };

/** Carrega o projeto de teste (semente fixa) e troca a descrição de alguns tickets pelos casos de borda. */
export async function loadPerfWorld(pool: pg.Pool, n = 400): Promise<PerfWorld> {
  const plan = planBigProject({ n, seed: 3, key: "BG", now: PERF_NOW });
  await loadBigProject(pool, plan);
  const edgeIds: Record<string, string> = {};
  const names = Object.keys(EDGE_DESCRIPTIONS);
  // Tickets do meio do plano (fora das fixtures), de profundidades e situações variadas.
  const picks = plan.tickets.filter((t) => t.index >= 40 && !t.ideaStage).filter((_, i) => i % 7 === 0).slice(0, names.length);
  for (const [i, name] of names.entries()) {
    const ticket = picks[i];
    if (!ticket) throw new Error("plano pequeno demais para os casos de borda");
    edgeIds[name] = ticket.id;
    await pool.query("update tickets set description = $1 where id = $2", [EDGE_DESCRIPTIONS[name], ticket.id]);
  }
  return { plan, edgeIds };
}

/**
 * `dueDate` e `overdue` (ADR 0064, prazo) vieram depois das referências de ouro: nenhum ticket deste projeto tem prazo, então todo
 * `dueDate` é nulo e todo `overdue` é falso. Confere isso e tira só esses dois campos antes de comparar: nos objetos, as duas chaves;
 * no texto JSON das respostas do MCP, só os dois pares `"dueDate":null` e `"overdue":false` (o resto do texto fica byte a byte como
 * veio, sem reserializar). O mesmo para `labels` (ADR 0065, etiquetas), só quando é `[]`: nos objetos, a chave; no texto do MCP, o par
 * `"labels":[]`. As referências não são regravadas.
 *
 * A ADR 0068 mudou `blocked` (agora é o impedimento marcado, e nenhum ticket deste projeto tem um) e trouxe `place` (lugar na fila),
 * `impediment` (detalhe) e `need` (tipo de cada dependência; o gerador só cria "para começar"). Confere os valores e tira os quatro
 * campos; do lado da referência, `expectGolden` tira o `blocked` antigo (que vinha da dependência aberta).
 */
export function withoutDueDate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDueDate);
  if (typeof value === "string") {
    expect(value, "dueDate sem prazo").not.toMatch(/"dueDate":(?!null[,}])/);
    expect(value, "overdue sem prazo").not.toMatch(/"overdue":(?!false[,}])/);
    expect(value, "labels sem etiqueta").not.toMatch(/"labels":(?!\[\][,}])/);
    expect(value, "blocked sem impedimento").not.toMatch(/"blocked":(?!false[,}])/);
    expect(value, "need só para começar").not.toMatch(/"need":(?!"start"[,}])/);
    return value
      .replace(/,"dueDate":null(?=[,}])/g, "")
      .replace(/,"overdue":false(?=[,}])/g, "")
      .replace(/,"labels":\[\](?=[,}])/g, "")
      .replace(/,"blocked":false(?=[,}])/g, "")
      .replace(/,"place":(?:null|"free"|"next"|"waiting")(?=[,}])/g, "")
      .replace(/,"need":"start"(?=[,}])/g, "");
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === "dueDate") expect(inner, "dueDate sem prazo").toBeNull();
    // Etiquetas (ADR 0065) vieram depois também: nenhum ticket deste projeto tem etiqueta, então todo `labels` é `[]` e só então sai.
    // No texto das respostas do MCP (que passou a levar `labels`, só os nomes), o mesmo vale pelo par `"labels":[]` acima.
    else if (key === "labels") expect(inner, "labels sem etiqueta").toEqual([]);
    else if (key === "overdue") expect(inner, "overdue sem prazo").toBe(false);
    else if (key === "blocked") expect(inner, "blocked sem impedimento").toBe(false);
    else if (key === "impediment") expect(inner, "sem impedimento").toBeNull();
    else if (key === "need") expect(inner, "need só para começar").toBe("start");
    else if (key === "place") expect([null, "free", "next", "waiting"], "place").toContain(inner);
    else out[key] = withoutDueDate(inner);
  }
  return out;
}

/** Tira a chave `blocked` de todo objeto da referência (o texto JSON do MCP não a tinha: as listas do MCP não levam `blocked`). */
function withoutOldBlocked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOldBlocked);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "blocked").map(([key, inner]) => [key, withoutOldBlocked(inner)]));
}

/** A referência de ouro inteira, lida como está (para comparações que não são de igualdade de texto). */
export function readGolden(name: string): unknown {
  return JSON.parse(readFileSync(resolve(GOLDEN_DIR, `${name}.json`), "utf8")) as unknown;
}

/** Compara com o arquivo guardado (gerado pelo código de antes da mudança); `UPDATE_GOLDEN=1` regrava. Ordem de chaves e de listas conta. */
export function expectGolden(name: string, actual: unknown, omit: readonly string[] = []): void {
  const file = resolve(GOLDEN_DIR, `${name}.json`);
  const text = JSON.stringify(process.env["UPDATE_GOLDEN"] === "1" ? actual : withoutDueDate(actual));
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, `${text}\n`);
    return;
  }
  if (!existsSync(file)) throw new Error(`Falta o arquivo de referência ${file}; rode com UPDATE_GOLDEN=1 no código antigo.`);
  // O `blocked` da referência era o da dependência aberta (antes da ADR 0068): sai do lado da referência, como sai do lado de agora.
  const parsed = withoutOldBlocked(JSON.parse(readFileSync(file, "utf8").trimEnd())) as Record<string, unknown>;
  for (const key of omit) delete parsed[key];
  const golden = JSON.stringify(parsed);
  expect(JSON.parse(text)).toEqual(JSON.parse(golden));
  expect(text).toBe(golden);
}

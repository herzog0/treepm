import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guarda (TREEPM-253): toda consulta crua RECURSIVA sobre `tickets` repete `org_id` e `project_id` na âncora e em cada passo
// recursivo. O RLS isola as organizações, mas a consulta não pode depender só dele: um papel que o ignora (o dono, um script)
// ou uma política errada atravessaria de uma organização para outra por `id`/`parent_id`.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Os modelos de texto (crases) de cada `$queryRaw`/`$executeRaw` do arquivo. */
export function rawTemplates(text: string): string[] {
  const out: string[] = [];
  const opener = /\$(?:queryRaw|executeRaw)(?:<[^`]*?>)?\s*`/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    let at = match.index + match[0].length;
    let depth = 0;
    let body = "";
    for (; at < text.length; at += 1) {
      const char = text[at] as string;
      if (char === "$" && text[at + 1] === "{") depth += 1;
      else if (char === "}" && depth > 0) depth -= 1;
      else if (char === "`" && depth === 0) break;
      if (depth === 0 || char !== "`") body += char;
    }
    out.push(body);
  }
  return out;
}

/** Quebra uma consulta recursiva em âncora(s) e passos: cada trecho depois de um `union all`, até o `)` que fecha o CTE. */
export function recursiveParts(sql: string): { anchors: string[]; steps: string[] } {
  const pieces = sql.split(/\bunion all\b/i);
  const anchors: string[] = [];
  const steps: string[] = [];
  pieces.forEach((piece, i) => {
    // O passo termina no `)` sozinho numa linha (fim do CTE); a âncora começa no `as (` anterior.
    const end = piece.search(/\n\s*\)/);
    if (i > 0) steps.push(end < 0 ? piece : piece.slice(0, end));
    const starts = [...piece.matchAll(/\bas\s*\(/gi)];
    const start = starts.at(-1)?.index ?? 0;
    if (i < pieces.length - 1) anchors.push(piece.slice(start));
  });
  return { anchors, steps };
}

/** Uma COMPARAÇÃO com a coluna (`org_id = …`), não só a coluna na lista do `select`. */
const has = (text: string, column: "org_id" | "project_id"): boolean => new RegExp(`\\b${column}\\s*=`).test(text);

describe("consultas recursivas de tickets: org_id e project_id em toda ligação", () => {
  const found: { file: string; sql: string }[] = [];
  for (const file of sources(SRC)) {
    for (const sql of rawTemplates(readFileSync(file, "utf8"))) {
      if (/with\s+recursive/i.test(sql) && /\btickets\b/i.test(sql)) found.push({ file: relative(SRC, file), sql });
    }
  }

  it("acha as consultas recursivas conhecidas (a guarda não pode ficar cega)", () => {
    expect(found.length).toBeGreaterThanOrEqual(11);
    const files = new Set(found.map((entry) => entry.file));
    for (const expected of ["tickets/ticket-reads.ts", "tickets/idea-root.ts", "tickets/tickets.service.ts", "tickets/ideas.service.ts", "query/project-query.service.ts"]) expect(files, expected).toContain(expected);
  });

  it("o detector de modelos e de passos enxerga uma consulta sem filtro (autoteste)", () => {
    const bad = rawTemplates("tx.$queryRaw<X[]>`with recursive up as (\n select id from tickets where id = ${a}\n union all\n select t.id from tickets t join up on t.id = up.parent_id\n)\n select id from up`;");
    expect(bad).toHaveLength(1);
    const { steps } = recursiveParts(bad[0] as string);
    expect(steps).toHaveLength(1);
    expect(has(steps[0] as string, "org_id")).toBe(false);
  });

  it.each(found.map((entry) => [`${entry.file}: ${entry.sql.replace(/\s+/g, " ").trim().slice(0, 90)}`, entry.sql] as const))("%s", (_name, sql) => {
    const { anchors, steps } = recursiveParts(sql);
    expect(steps.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(has(anchor, "org_id"), `âncora sem org_id:\n${anchor}`).toBe(true);
      expect(has(anchor, "project_id"), `âncora sem project_id:\n${anchor}`).toBe(true);
    }
    for (const step of steps) {
      expect(has(step, "org_id"), `passo sem org_id:\n${step}`).toBe(true);
      expect(has(step, "project_id"), `passo sem project_id:\n${step}`).toBe(true);
    }
  });

  it("nenhuma consulta recursiva traz um limite de profundidade escrito à mão: todas usam MAX_TREE_DEPTH", () => {
    for (const entry of found) expect(entry.sql, entry.file).not.toMatch(/depth\s*<\s*\d/);
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      if (/with\s+recursive/i.test(text) && /\bdepth\b/.test(text)) expect(text, relative(SRC, file)).toMatch(/MAX_TREE_DEPTH|CONVERSATION_TECHNICAL_MAX_DEPTH/);
    }
  });
});

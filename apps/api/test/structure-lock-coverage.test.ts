import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guarda de cobertura da ADR 0045: todo arquivo que grava o pai de um ticket, a ideia de um ticket, ou cria ou remove ticket
 * tem de passar pela função da trava de estrutura (`lockProjectStructure`, ou `lockStructure` dos serviços). É uma guarda
 * por arquivo: ela impede o arquivo novo que escreve na árvore sem trava e o caminho que perde a trava; a ordem dentro do
 * arquivo (trava antes das conferências) é coberta pelos testes de corrida de `structure-lock.test.ts`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCAN = ["apps/api/src", "apps/api/scripts", "packages/db/src", "packages/domain/src", "packages/engine/src"];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "dist" && name !== "generated") out.push(...sources(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** O texto da chamada que abre em `open` (parênteses balanceados). */
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** Os pontos do texto que gravam estrutura da árvore de tickets. */
export function structureWrites(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\.ticket\.(create|createMany|upsert|delete|deleteMany)\(/g)) found.push(m[0]);
  for (const m of text.matchAll(/\.ticket\.(update|updateMany)\(/g)) {
    const call = callText(text, m.index + m[0].length - 1);
    if (/\b(parentId|ideaStage)\b/.test(call)) found.push(`${m[0]} com pai ou ideia`);
  }
  for (const m of text.matchAll(/insert\s+into\s+tickets\b|delete\s+from\s+tickets\b|update\s+tickets\s+set[^;`]*\b(parent_id|idea_stage)\b/gi)) found.push(m[0]);
  return found;
}

export const takesLock = (text: string): boolean => /\blockProjectStructure\(|\.lockStructure\(/.test(text);

/** Arquivos que gravam estrutura sem passar pela trava. */
export function unlockedWriters(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, text]) => !path.endsWith("structure-lock.ts") && structureWrites(text).length > 0 && !takesLock(text))
    .map(([path]) => path)
    .sort();
}

describe("guarda: toda gravação de estrutura da árvore passa pela trava do projeto (ADR 0045)", () => {
  it("o detector enxerga cada tipo de gravação e a trava (autoteste)", () => {
    expect(structureWrites("await tx.ticket.create({ data })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.createMany({ data })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.delete({ where })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { parentId: x } })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { ideaStage: 'new' } })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { status: 'todo' } })")).toHaveLength(0);
    expect(structureWrites("await tx.$executeRaw`update tickets set parent_id = ${x} where id = ${y}`")).toHaveLength(1);
    expect(structureWrites("await tx.$executeRaw`delete from tickets where id = ${y}`")).toHaveLength(1);
    expect(unlockedWriters({ "a.ts": "await tx.ticket.delete({})", "b.ts": "await lockProjectStructure(tx, p); await tx.ticket.delete({})", "c.ts": "tx.ticket.findMany()" })).toEqual(["a.ts"]);
  });

  it("nenhum arquivo do código-fonte grava estrutura fora de um caminho que pega a trava", () => {
    const files: Record<string, string> = {};
    for (const dir of SCAN) for (const path of sources(join(ROOT, dir))) files[relative(ROOT, path)] = readFileSync(path, "utf8");
    expect(Object.keys(files).length).toBeGreaterThan(50);
    expect(unlockedWriters(files)).toEqual([]);
  });

  it("os caminhos conhecidos continuam pegando a trava (mínimo de chamadas por arquivo)", () => {
    const calls = (file: string) => (readFileSync(join(ROOT, file), "utf8").match(/\blockProjectStructure\(|\.lockStructure\(/g) ?? []).length;
    expect(calls("apps/api/src/tickets/tickets.service.ts")).toBeGreaterThanOrEqual(4); // trocar pai, criar, criar pai e mover, a função de repasse
    expect(calls("apps/api/src/tickets/tickets.controller.ts")).toBeGreaterThanOrEqual(2); // importar, remover
    expect(calls("apps/api/src/tickets/ideas.service.ts")).toBeGreaterThanOrEqual(1); // transformar, aceitar, descartar
    expect(calls("apps/api/src/assistant/conversations.controller.ts")).toBeGreaterThanOrEqual(1); // criar pela conversa
  });
});

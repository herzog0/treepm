import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guarda de cobertura da ADR 0045 (revisão 1). Duas conferências sobre o código-fonte, sem comentários:
 *  1. por arquivo: todo arquivo que grava estrutura (pai, estágio de ideia, criar ou remover ticket, escrita aninhada) chama a trava;
 *  2. por método, nos arquivos principais: todo método que grava estrutura chama a trava ou um método do mesmo arquivo que a chama,
 *     e os métodos listados em REQUIRED continuam pegando a trava.
 * O que a guarda enxerga: `ticket.create/createMany/upsert/delete/deleteMany`; `ticket.update/updateMany` com `parentId`, `ideaStage`,
 * `parent:`/`children:` aninhados, ou `data` em variável (não dá para saber o que tem); SQL cru `insert into`/`delete from`/`update ... set
 * parent_id|idea_stage` em `tickets` (com aspas ou apelido).
 * O que NÃO enxerga: escrita feita por outro módulo que receba o `tx` e chame o Prisma por nome dinâmico, SQL montado por pedaços de
 * texto, e a ORDEM das chamadas dentro de um método (a trava antes das conferências), que os testes de corrida cobrem. O método que
 * chama um auxiliar do mesmo arquivo conta como travado só se o auxiliar tem a chamada direta; auxiliares de outro arquivo não valem.
 * Auxiliares de gravação sem trava própria ficam em HELPERS, com o motivo.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCAN = ["apps/api/src", "apps/api/scripts", "packages/db/src", "packages/domain/src", "packages/engine/src"];
const REQUIRED: Record<string, string[]> = {
  "apps/api/src/tickets/tickets.service.ts": ["updateTicket", "create", "createParentAndMove"],
  "apps/api/src/tickets/tickets.controller.ts": ["import", "remove"],
  "apps/api/src/tickets/ideas.service.ts": ["transform", "accept", "discard"],
  "apps/api/src/assistant/conversations.controller.ts": ["createTicket"],
};
/** Gravam, mas só são chamados por métodos de REQUIRED (que travam) ou não mexem na estrutura. */
const HELPERS: Record<string, string> = {
  "apps/api/src/tickets/ideas.service.ts#setStage": "chamado por accept, discard e transform (travam) e por changeStage, que só troca o estágio entre new, refining e ready",
};

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

/** O código sem comentários (de linha e de bloco), respeitando textos entre aspas e modelos de texto. */
export function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
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
export function structureWrites(raw: string): string[] {
  const text = stripComments(raw);
  const found: string[] = [];
  for (const m of text.matchAll(/\.ticket\.(create|createMany|upsert|delete|deleteMany)\(/g)) found.push(m[0]);
  for (const m of text.matchAll(/\.ticket\.(update|updateMany)\(/g)) {
    const call = callText(text, m.index + m[0].length - 1);
    const dataVariable = /\bdata\s*[,}]|\bdata\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]/.test(call);
    if (/\b(parentId|ideaStage)\b|\bparent\s*:|\bchildren\s*:|\bconnect\b|\bdisconnect\b/.test(call) || dataVariable) found.push(`${m[0]} com pai, ideia ou data em variável`);
  }
  const sql = /insert\s+into\s+"?tickets"?\b|delete\s+from\s+"?tickets"?\b|update\s+"?tickets"?(\s+(as\s+)?\w+)?\s+set[^;`]*\b(parent_id|idea_stage)\b/gi;
  for (const m of text.matchAll(sql)) found.push(m[0]);
  return found;
}

const LOCK_CALL = /\blockProjectStructure\(|\.lockStructure\(/;
export const takesLock = (raw: string): boolean => LOCK_CALL.test(stripComments(raw));

/** Arquivos que gravam estrutura sem passar pela trava. */
export function unlockedWriters(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path, text]) => !path.endsWith("structure-lock.ts") && structureWrites(text).length > 0 && !takesLock(text))
    .map(([path]) => path)
    .sort();
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "throw", "else", "constructor", "super"]);
/** Os membros de classe do arquivo (cabeçalho com dois espaços de recuo até o próximo), por nome. */
export function methodsOf(raw: string): Map<string, string> {
  const text = stripComments(raw);
  const header = /^ {2}(?:(?:public|private|protected|static|async|readonly)\s+)*([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\(/gm;
  const heads = [...text.matchAll(header)].filter((m) => !KEYWORDS.has(m[1] as string));
  const out = new Map<string, string>();
  heads.forEach((m, i) => out.set(m[1] as string, text.slice(m.index, heads[i + 1]?.index ?? text.length)));
  return out;
}

/** Métodos que gravam estrutura sem a trava (própria ou de um auxiliar do mesmo arquivo que a chama direto). */
export function unlockedMethods(raw: string): string[] {
  const methods = methodsOf(raw);
  const direct = new Set([...methods].filter(([, body]) => LOCK_CALL.test(body)).map(([name]) => name));
  const locking = new Set(direct);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of methods) {
      if (locking.has(name)) continue;
      for (const helper of direct) {
        if (!new RegExp(`\\.${helper}\\(`).test(body)) continue;
        locking.add(name);
        changed = true;
      }
    }
  }
  return [...methods].filter(([name, body]) => structureWrites(body).length > 0 && !locking.has(name)).map(([name]) => name);
}

describe("guarda: toda gravação de estrutura da árvore passa pela trava do projeto (ADR 0045)", () => {
  it("o detector enxerga cada tipo de gravação (autoteste)", () => {
    expect(structureWrites("await tx.ticket.create({ data })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.createMany({ data })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.delete({ where })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { parentId: x } })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { ideaStage: 'new' } })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data })")).toHaveLength(1); // data em variável
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: payload })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { parent: { connect: { id } } } })")).toHaveLength(1); // aninhada
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { children: { create: [] } } })")).toHaveLength(1);
    expect(structureWrites("await tx.ticket.update({ where: { id }, data: { status: 'todo' } })")).toHaveLength(0);
    expect(structureWrites("await tx.$executeRaw`update tickets set parent_id = ${x} where id = ${y}`")).toHaveLength(1);
    expect(structureWrites('await tx.$executeRaw`update "tickets" t set idea_stage = null where t.id = ${y}`')).toHaveLength(1);
    expect(structureWrites("await tx.$executeRaw`delete from tickets where id = ${y}`")).toHaveLength(1);
    expect(structureWrites('await tx.$executeRaw`insert into "tickets" (id) values (1)`')).toHaveLength(1);
    expect(structureWrites("// await tx.ticket.delete({})\n/* tx.ticket.create({}) */")).toHaveLength(0); // comentário não é gravação
  });

  it("comentário não conta como chamar a trava, e a trava de um arquivo não cobre o outro", () => {
    const comment = "// await lockProjectStructure(tx, p)\nawait tx.ticket.delete({})";
    expect(unlockedWriters({ "a.ts": comment })).toEqual(["a.ts"]);
    expect(unlockedWriters({ "b.ts": "/* lockProjectStructure( */ await tx.ticket.delete({})" })).toEqual(["b.ts"]);
    expect(unlockedWriters({ "c.ts": "await lockProjectStructure(tx, p); await tx.ticket.delete({})", "d.ts": "tx.ticket.findMany()" })).toEqual([]);
  });

  it("por método: função nova sem trava no mesmo arquivo é pega; auxiliar que trava vale; comentário não vale", () => {
    const file = [
      "class S {",
      "  async travado(tx) {",
      "    await this.lockStructure(tx, p);",
      "    await tx.ticket.delete({ where });",
      "  }",
      "  async novo(tx) {",
      "    await tx.ticket.delete({ where });",
      "  }",
      "  async viaAuxiliar(tx) {",
      "    await this.travado(tx);",
      "    await tx.ticket.update({ where, data });",
      "  }",
      "  async comentado(tx) {",
      "    // this.lockStructure(tx, p)",
      "    await tx.ticket.create({ data });",
      "  }",
      "}",
    ].join("\n");
    expect(unlockedMethods(file).sort()).toEqual(["comentado", "novo"]);
  });

  it("nenhum arquivo do código-fonte grava estrutura fora de um caminho que pega a trava", () => {
    const files: Record<string, string> = {};
    for (const dir of SCAN) for (const path of sources(join(ROOT, dir))) files[relative(ROOT, path)] = readFileSync(path, "utf8");
    expect(Object.keys(files).length).toBeGreaterThan(50);
    expect(unlockedWriters(files)).toEqual([]);
  });

  it("nos arquivos principais, cada método que grava estrutura trava, e os métodos de REQUIRED continuam travando", () => {
    for (const [file, required] of Object.entries(REQUIRED)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const methods = methodsOf(text);
      for (const name of required) expect(methods.has(name), `${file} perdeu o método ${name}`).toBe(true);
      const unlocked = unlockedMethods(text).filter((name) => !(`${file}#${name}` in HELPERS));
      expect(unlocked, `${file}: método que grava estrutura sem trava`).toEqual([]);
      const direct = new Set([...methods].filter(([, body]) => LOCK_CALL.test(body)).map(([name]) => name));
      for (const name of required) {
        const body = methods.get(name) as string;
        const locks = direct.has(name) || [...direct].some((helper) => new RegExp(`\\.${helper}\\(`).test(body));
        expect(locks, `${file}#${name} deixou de pegar a trava`).toBe(true);
      }
    }
  });
});

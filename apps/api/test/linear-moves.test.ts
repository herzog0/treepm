import { withTenant } from "@treepm/db";
import type { PrismaClient, TenantClient } from "@treepm/db";
import { describe, expect, it } from "vitest";
import { PRISMA } from "../src/db/prisma.provider.js";
import { applyParentMoves, isParentCycleError } from "../src/linear/linear-moves.js";
import { useLinearHarness } from "./linear-support.js";
import { ORG } from "./world.js";

const { h } = useLinearHarness();

/** Uma transação falsa que grava o texto de cada comando e falha onde o teste manda. */
function fakeTx(failOn: (sql: string) => Error | null) {
  const log: string[] = [];
  const run = (strings: TemplateStringsArray): Promise<number> => {
    const sql = strings.join("?").replace(/\s+/g, " ").trim();
    log.push(sql);
    const error = failOn(sql);
    return error ? Promise.reject(error) : Promise.resolve(1);
  };
  return { tx: { $executeRaw: run } as unknown as TenantClient, log };
}

const MOVES = [
  { id: "00000000-0000-0000-0000-00000000000a", parentId: "00000000-0000-0000-0000-00000000000b" },
  { id: "00000000-0000-0000-0000-00000000000c", parentId: "00000000-0000-0000-0000-00000000000a" },
];
const cycleError = () => Object.assign(new Error("ticket_parent_cycle: o pai escolhido é o próprio ticket ou um descendente dele"), { code: "P2010", meta: { code: "23514" } });

describe("applyParentMoves (L7: o catch só engole o erro do gatilho de ciclo)", () => {
  it("lote que passa: um UPDATE, sem refazer um a um", async () => {
    const { tx, log } = fakeTx(() => null);
    expect(await applyParentMoves(tx, ORG, MOVES)).toEqual({ usedFallback: false, skipped: [] });
    expect(log.filter((sql) => /^update tickets t set parent_id = m\.p/.test(sql))).toHaveLength(1);
    expect(log.some((sql) => /^update tickets set parent_id/.test(sql))).toBe(false);
    expect(log.some((sql) => /rollback to savepoint/.test(sql))).toBe(false);
    expect(log.some((sql) => /^update ticket_external_refs/.test(sql))).toBe(true);
  });

  it("o gatilho de ciclo recusa o lote: volta ao SAVEPOINT e refaz um a um, na ordem do plano", async () => {
    let first = true;
    const { tx, log } = fakeTx((sql) => {
      if (first && /^update tickets t set parent_id = m\.p/.test(sql)) {
        first = false;
        return cycleError();
      }
      return null;
    });
    expect(await applyParentMoves(tx, ORG, MOVES)).toEqual({ usedFallback: true, skipped: [] });
    const at = (pattern: RegExp) => log.findIndex((sql) => pattern.test(sql));
    expect(at(/^savepoint/)).toBeGreaterThanOrEqual(0);
    expect(at(/rollback to savepoint/)).toBeGreaterThan(at(/^update tickets t set parent_id = m\.p/));
    expect(log.filter((sql) => /^update tickets set parent_id/.test(sql))).toHaveLength(MOVES.length);
    expect(at(/^update ticket_external_refs/)).toBeGreaterThan(at(/rollback to savepoint/));
  });

  it("L9: ticket_parent_cycle num item do fallback deixa SÓ esse item onde está (skipped) e os outros andam, o retrato só dos que andaram", async () => {
    let batchFailed = false;
    const { tx, log } = fakeTx((sql) => {
      if (!batchFailed && /^update tickets t set parent_id = m\.p/.test(sql)) {
        batchFailed = true;
        return cycleError();
      }
      return /^update tickets set parent_id/.test(sql) && sql === log.filter((line) => /^update tickets set parent_id/.test(line))[0] && log.filter((line) => /^update tickets set parent_id/.test(line)).length === 1 ? cycleError() : null;
    });
    const result = await applyParentMoves(tx, ORG, MOVES);
    expect(result).toEqual({ usedFallback: true, skipped: [MOVES[0]!.id] });
    expect(log.filter((sql) => /^rollback to savepoint link_one/.test(sql))).toHaveLength(1);
    expect(log.filter((sql) => /^update ticket_external_refs/.test(sql))).toHaveLength(1);
  });

  it("qualquer outro erro do lote (queda, permissão, tipo) PROPAGA, sem refazer um a um", async () => {
    const boom = new Error("connection terminated");
    const { tx, log } = fakeTx((sql) => (/^update tickets t set parent_id = m\.p/.test(sql) ? boom : null));
    await expect(applyParentMoves(tx, ORG, MOVES)).rejects.toBe(boom);
    expect(log.some((sql) => /^update tickets set parent_id/.test(sql))).toBe(false);
  });

  it("o erro de um passo individual do fallback também propaga", async () => {
    let batchFailed = false;
    const boom = new Error("falha no individual");
    const { tx } = fakeTx((sql) => {
      if (!batchFailed && /^update tickets t set parent_id = m\.p/.test(sql)) {
        batchFailed = true;
        return cycleError();
      }
      return /^update tickets set parent_id/.test(sql) ? boom : null;
    });
    await expect(applyParentMoves(tx, ORG, MOVES)).rejects.toBe(boom);
  });
});

describe("applyParentMoves no banco de verdade", () => {
  async function tree() {
    const org = h.world().projects.org;
    const make = async (n: number, parent: string | null) => {
      const row = await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, parent_id, created_by_person_id) values ($1,$2::uuid,$3,$4,$5::uuid,$6::uuid) returning id", [ORG, org, 900 + n, `t${n}`, parent, h.world().people.admin]);
      return row.rows[0]!.id;
    };
    const a = await make(1, null);
    const b = await make(2, a);
    const r = await make(3, null);
    return { a, b, r };
  }
  const parentOf = async (id: string) => (await h.pool.query<{ parent_id: string | null }>("select parent_id from tickets where id = $1::uuid", [id])).rows[0]!.parent_id;

  it("reconhece o erro REAL do gatilho e não confunde com outro erro", async () => {
    const { a, b } = await tree();
    const prisma = h.app().get<PrismaClient>(PRISMA);
    const cycle = await withTenant(prisma, { orgId: ORG, userId: "u_admin" }, (tx) => tx.$executeRaw`update tickets set parent_id = ${b}::uuid where org_id = ${ORG} and id = ${a}::uuid`).catch((error: unknown) => error);
    expect(isParentCycleError(cycle)).toBe(true);
    const other = await withTenant(prisma, { orgId: ORG, userId: "u_admin" }, (tx) => tx.$executeRaw`update tickets set parent_id = 'nao-e-uuid'::uuid where org_id = ${ORG} and id = ${a}::uuid`).catch((error: unknown) => error);
    expect(isParentCycleError(other)).toBe(false);
  });

  it("a ordem do plano que só fecha em sequência (R→B→A, com B hoje sob A) passa pelo FALLBACK e termina certa", async () => {
    const { a, b, r } = await tree();
    const prisma = h.app().get<PrismaClient>(PRISMA);
    const result = await withTenant(prisma, { orgId: ORG, userId: "u_admin" }, (tx) =>
      applyParentMoves(tx, ORG, [
        { id: b, parentId: r },
        { id: a, parentId: b },
      ]),
    );
    expect(result).toEqual({ usedFallback: true, skipped: [] });
    expect(await parentOf(b)).toBe(r);
    expect(await parentOf(a)).toBe(b);
  });

  it("L9: com um item que o gatilho recusa de verdade, o fallback o pula e a transação continua utilizável", async () => {
    const { a, b, r } = await tree();
    const prisma = h.app().get<PrismaClient>(PRISMA);
    // a→b é ciclo (b está sob a) e nada em tickets o desfaz antes; r→a é válido.
    const result = await withTenant(prisma, { orgId: ORG, userId: "u_admin" }, async (tx) => {
      const moved = await applyParentMoves(tx, ORG, [
        { id: a, parentId: b },
        { id: r, parentId: a },
      ]);
      await tx.$executeRaw`select 1`; // a transação não ficou abortada
      return moved;
    });
    expect(result.skipped).toEqual([a]);
    expect(await parentOf(a)).toBeNull();
    expect(await parentOf(r)).toBe(a);
  });
});

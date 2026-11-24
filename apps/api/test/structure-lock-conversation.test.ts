import { afterEach, describe, expect, it } from "vitest";
import { structureLock } from "../src/tickets/structure-lock.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

/** ADR 0045: criar a partir da conversa (pai, filhos, agrupador) também espera a trava de estrutura do projeto. */
const h = useHarness(AI_CONFIG);
const P = () => h.world().projects.priv;
const original = structureLock.timeoutMs;
afterEach(() => {
  structureLock.timeoutMs = original;
});

describe("criar a partir da conversa", () => {
  it("com a trava de estrutura ocupada: 409 structure_busy e nada é criado", async () => {
    const open = await h.call("POST", `/api/projects/${P()}/ticket-conversations`, as("contributor"), { message: "Preciso de uma tela de login" });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    const before = (await h.pool.query("select count(*)::int as n from tickets")).rows[0].n as number;
    structureLock.timeoutMs = 300;
    const owner = await h.pool.connect();
    try {
      await owner.query("begin");
      await owner.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${P()}`]);
      const res = await h.call("POST", `/api/ticket-conversations/${open.body.id}/ticket`, as("contributor"), { placedBy: "map", parentId: null });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("structure_busy");
      await owner.query("commit");
    } finally {
      owner.release();
    }
    expect((await h.pool.query("select count(*)::int as n from tickets")).rows[0].n).toBe(before);
  });
});

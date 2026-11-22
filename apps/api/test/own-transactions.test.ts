import { Controller, Post } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OwnTransactions, Tenant } from "../src/db/own-transactions.js";
import type { TenantRunner } from "../src/db/own-transactions.js";
import { Tx } from "../src/db/tx.decorator.js";
import { createTestApp, ownerPoolWithCleanup, truncateAll, openApiTransactions } from "./helpers.js";
import { as, seedWorld } from "./world.js";
import type { World } from "./world.js";

const pool = ownerPoolWithCleanup();

/** O que o "provedor" faz quando é chamado (definido por cada teste). */
const provider: { onCall: () => Promise<void> } = { onCall: async () => undefined };

@Controller("probe")
class ProbeController {
  /** Rota comum: o handler inteiro roda na transação do interceptor. */
  @Post("plain")
  async plain(@Tx() tx: TenantClient) {
    await tx.team.count();
    return { openDuring: await openApiTransactions(pool) };
  }

  /** Rota que cuida das próprias transações: leitura curta, "provedor", escrita curta. */
  @Post("own")
  @OwnTransactions()
  async own(@Tenant() tenant: TenantRunner) {
    const read = await tenant.run(async (tx, principal) => ({
      teams: await tx.team.count(),
      clerkRole: principal.actor.clerkRole,
      projects: [...principal.actor.projectRoles.values()],
    }));
    const openDuring = await openApiTransactions(pool);
    await provider.onCall();
    const write = await tenant.run(async (_tx, principal) => ({ projects: [...principal.actor.projectRoles.values()] }));
    return { read, openDuring, write };
  }

  /** O erro dentro da transação curta desfaz só ela e chega ao cliente. */
  @Post("rollback")
  @OwnTransactions()
  async rollback(@Tenant() tenant: TenantRunner) {
    await tenant.run(async (tx) => {
      await tx.area.create({ data: { orgId: "org_A", name: "Não deve ficar" } });
      throw new Error("falha");
    });
  }
}

let app: INestApplication;
let world: World;

beforeAll(async () => {
  ({ app } = await createTestApp([ProbeController]));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  world = await seedWorld(pool);
  provider.onCall = async () => undefined;
});

const post = (path: string, session: string) => request(app.getHttpServer()).post(path).set("x-test-session", session);

describe("@OwnTransactions", () => {
  it("controle: na rota comum há uma transação aberta durante o handler", async () => {
    const res = await post("/api/probe/plain", as("manager"));
    expect(res.status).toBe(201);
    expect(res.body.openDuring).toBeGreaterThanOrEqual(1);
  });

  it("na rota declarada, não há transação aberta enquanto o provedor responde", async () => {
    let openInsideProvider = -1;
    provider.onCall = async () => {
      openInsideProvider = await openApiTransactions(pool);
    };
    const res = await post("/api/probe/own", as("manager"));
    expect(res.status).toBe(201);
    expect(res.body.openDuring).toBe(0);
    expect(openInsideProvider).toBe(0);
  });

  it("as transações curtas têm o contexto de tenant (RLS) e o Principal resolvido", async () => {
    const res = await post("/api/probe/own", as("manager"));
    expect(res.body.read).toEqual({ teams: 2, clerkRole: "member", projects: ["manager"] });
    const other = await post("/api/probe/own", as("outsider", "org_B"));
    expect(other.body.read).toEqual({ teams: 1, clerkRole: "member", projects: [] });
  });

  it("a escrita curta enxerga o que mudou durante a chamada ao provedor (papéis recarregados)", async () => {
    provider.onCall = async () => {
      await pool.query("delete from project_memberships where person_id = $1", [world.people.manager]);
    };
    const res = await post("/api/probe/own", as("manager"));
    expect(res.body.read.projects).toEqual(["manager"]);
    expect(res.body.write.projects).toEqual([]);
  });

  it("um erro na transação curta desfaz só ela e vira resposta de erro", async () => {
    const res = await post("/api/probe/rollback", as("admin"));
    expect(res.status).toBe(500);
    expect((await pool.query("select 1 from areas")).rowCount).toBe(0);
  });
});

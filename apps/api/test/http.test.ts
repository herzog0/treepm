import { Body, Controller, Post } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Tx } from "../src/db/tx.decorator.js";
import type { TenantClient } from "@treepm/db";
import { createTestApp, ownerPoolWithCleanup, sessionHeader, truncateAll } from "./helpers.js";
import type { FakeDirectory } from "./helpers.js";

@Controller("boom")
class BoomController {
  @Post()
  async boom(@Tx() tx: TenantClient, @Body() body: { orgId: string }) {
    await tx.organization.create({ data: { orgId: body.orgId, name: "x", slug: "x" } });
    throw new Error("falha interna com segredo postgres://user:senha@host");
  }
}

const pool = ownerPoolWithCleanup();
let app: INestApplication;
let directory: FakeDirectory;

beforeAll(async () => {
  ({ app, directory } = await createTestApp([BoomController]));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
});
afterEach(() => {
  directory.calls.users.length = 0;
  directory.calls.organizations.length = 0;
});

const http = () => request(app.getHttpServer());
const as = (userId: string, orgId: string | null, orgRole: string | null = "org:member", sessionStatus = "active") =>
  sessionHeader({ userId, orgId, orgRole, sessionStatus });

describe("autenticação (guard global)", () => {
  it("GET /api/health responde sem sessão", async () => {
    const res = await http().get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("outra rota sem sessão responde 401 no formato de erro", async () => {
    const res = await http().get("/api/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: "unauthenticated", message: expect.any(String) } });
  });

  it("sessão pendente responde 403", async () => {
    const res = await http().get("/api/me").set("x-test-session", as("user_1", "org_1", "org:admin", "pending"));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("sessão sem organização ativa responde 403", async () => {
    const res = await http().get("/api/me").set("x-test-session", as("user_1", null, null));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("rota desconhecida responde 404 no formato de erro", async () => {
    const res = await http().get("/api/nao-existe");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });
});

describe("GET /api/me", () => {
  it("cria organização e pessoa na primeira chamada, com dados do diretório", async () => {
    const res = await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:admin"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      actingAs: null,
      person: {
        id: expect.any(String),
        displayName: "Nome de user_1",
        email: "user_1@exemplo.test",
        avatarUrl: "https://img.test/user_1.png",
      },
      organization: { orgId: "org_A", name: "Organização org_A", slug: "org_a" },
      roles: { clerk: "admin", teams: [], projects: [] },
      assistant: { configured: false, consent: false, enabled: false },
      github: { enabled: false },
      mcp: { enabled: false, writeEnabled: false },
    });
    const people = await pool.query("select org_id, clerk_user_id, clerk_role, active from people");
    expect(people.rows).toEqual([{ org_id: "org_A", clerk_user_id: "user_1", clerk_role: "admin", active: true }]);
    expect((await pool.query("select 1 from organizations")).rowCount).toBe(1);
  });

  it("é idempotente na segunda chamada", async () => {
    const h = as("user_1", "org_A", "org:member");
    const first = await http().get("/api/me").set("x-test-session", h);
    const second = await http().get("/api/me").set("x-test-session", h);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect((await pool.query("select 1 from people")).rowCount).toBe(1);
    expect((await pool.query("select 1 from organizations")).rowCount).toBe(1);
  });

  it("atualiza clerk_role quando o papel muda e reativa a pessoa", async () => {
    await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:member"));
    await pool.query("update people set active = false");
    const res = await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:admin"));
    expect(res.status).toBe(200);
    expect(res.body.roles.clerk).toBe("admin");
    const row = await pool.query("select clerk_role, active from people");
    expect(row.rows).toEqual([{ clerk_role: "admin", active: true }]);
  });

  it("monta os papéis de time e projeto a partir das memberships", async () => {
    const first = await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:member"));
    const personId = first.body.person.id as string;
    const team = await pool.query<{ id: string }>("insert into teams (org_id, name) values ('org_A','T') returning id");
    const project = await pool.query<{ id: string }>("insert into projects (org_id, name, key) values ('org_A','P','KEY') returning id");
    await pool.query("insert into team_memberships (org_id, team_id, person_id, role) values ('org_A',$1,$2,'admin')", [team.rows[0]?.id, personId]);
    await pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ('org_A',$1,$2,'reader')", [project.rows[0]?.id, personId]);
    const res = await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:member"));
    expect(res.body.roles).toEqual({
      clerk: "member",
      teams: [{ teamId: team.rows[0]?.id, role: "admin" }],
      projects: [{ projectId: project.rows[0]?.id, role: "reader" }],
    });
  });

  it("papel Clerk desconhecido responde 403", async () => {
    const res = await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:billing"));
    expect(res.status).toBe(403);
  });
});

describe("isolamento ponta a ponta", () => {
  it("o mesmo usuário em duas organizações tem duas pessoas independentes", async () => {
    const a = await http().get("/api/me").set("x-test-session", as("user_1", "org_A", "org:admin"));
    const b = await http().get("/api/me").set("x-test-session", as("user_1", "org_B", "org:member"));
    expect(a.body.organization.orgId).toBe("org_A");
    expect(b.body.organization.orgId).toBe("org_B");
    expect(a.body.person.id).not.toBe(b.body.person.id);
    expect(a.body.roles.clerk).toBe("admin");
    expect(b.body.roles.clerk).toBe("member");
    // Asserção com conexão de dono; a app conecta como treepm_app.
    const rows = await pool.query("select org_id, clerk_user_id, clerk_role from people order by org_id");
    expect(rows.rows).toEqual([
      { org_id: "org_A", clerk_user_id: "user_1", clerk_role: "admin" },
      { org_id: "org_B", clerk_user_id: "user_1", clerk_role: "member" },
    ]);
  });
});

describe("transação por requisição", () => {
  it("erro no handler faz rollback da escrita e não vaza detalhes", async () => {
    const res = await http().post("/api/boom").set("x-test-session", as("user_1", "org_A", "org:admin")).send({ orgId: "org_A" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain("senha");
    expect((await pool.query("select 1 from organizations")).rowCount).toBe(0);
  });
});

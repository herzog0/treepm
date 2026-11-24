import { describe, expect, it } from "vitest";
import { TEST_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { actAs, createTestPerson, seedTestPerson, sessionAs } from "./act-as-support.js";
import { ORG, OTHER_ORG, as } from "./world.js";

// ADR 0057: pessoas de teste. Só administrador cria e desativa; nunca mexe em pessoa de verdade.
const h = useHarness(TEST_CONFIG);
const code = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

describe("POST /api/people/test", () => {
  it("o administrador cria uma pessoa de teste com identificador sintético, e-mail inválido e papel de membro", async () => {
    const res = await h.call("POST", "/api/people/test", as("admin"), { displayName: "  Bia  " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ displayName: "Bia", clerkRole: "member", active: true, isTest: true, avatarUrl: null });
    const row = (await h.pool.query("select * from people where id = $1::uuid", [res.body.id])).rows[0];
    expect(row).toMatchObject({ org_id: ORG, is_test: true, active: true, clerk_role: "member" });
    expect(row.clerk_user_id).toMatch(/^treepm_test_[0-9a-f-]{36}$/);
    expect(row.email).toMatch(/\.invalid$/);
  });

  it("não cria duas com o mesmo identificador", async () => {
    const a = await createTestPerson(h, "A");
    const b = await createTestPerson(h, "B");
    expect(a.clerkUserId).not.toBe(b.clerkUserId);
  });

  it.each([["vazio", ""], ["só espaços", "   "], ["longo demais", "x".repeat(81)]])("recusa nome %s", async (_n, displayName) => {
    expect((await h.call("POST", "/api/people/test", as("admin"), { displayName })).status).toBe(400);
  });
  it("recusa corpo sem nome e campos a mais", async () => {
    expect((await h.call("POST", "/api/people/test", as("admin"), {})).status).toBe(400);
    expect((await h.call("POST", "/api/people/test", as("admin"), { displayName: "X", isTest: false, clerkRole: "admin" })).status).toBe(400);
  });
  it("aceita 80 caracteres", async () => {
    expect((await h.call("POST", "/api/people/test", as("admin"), { displayName: "x".repeat(80) })).status).toBe(201);
  });

  it.each(["teamAdmin", "manager", "contributor", "reader", "plain"] as const)("%s (membro) recebe 403", async (who) => {
    const res = await h.call("POST", "/api/people/test", as(who), { displayName: "Bia" });
    expect(res.status).toBe(403);
    expect((await h.pool.query("select count(*)::int as n from people where is_test")).rows[0].n).toBe(0);
  });
  it("sem sessão: 401", async () => {
    const res = await h.call("POST", "/api/people/test", "{}", { displayName: "Bia" });
    expect([401, 403]).toContain(res.status);
  });

  it("no máximo 20 pessoas de teste ativas por organização; desativar libera vaga; a outra organização não conta", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await h.call("POST", "/api/people/test", as("admin"), { displayName: `P${i}` })).body.id as string);
    const over = await h.call("POST", "/api/people/test", as("admin"), { displayName: "P20" });
    expect(over.status).toBe(409);
    expect(code(over)).toBe("test_people_limit");
    expect((await h.call("POST", `/api/people/${ids[0]}/deactivate`, as("admin"))).status).toBe(200);
    expect((await h.call("POST", "/api/people/test", as("admin"), { displayName: "P20" })).status).toBe(201);
    // reativar além do limite também é recusado
    const back = await h.call("POST", `/api/people/${ids[0]}/reactivate`, as("admin"));
    expect(back.status).toBe(409);
    // a outra organização tem a própria cota
    expect((await h.call("POST", "/api/people/test", sessionAs("u_outsider", OTHER_ORG, "org:admin"), { displayName: "Z" })).status).toBe(201);
  });
});

describe("nome da pessoa de teste (revisão 1)", () => {
  it.each([
    ["espaço de largura zero (U+200B)", "Bia\u200b"],
    ["só invisível no meio", "Bi\u200ba"],
    ["marca de direção (U+202E)", "\u202eaiB"],
    ["tabulação", "Bia\tX"],
    ["espaço sem quebra (U+00A0)", "Bia\u00a0X"],
    ["nova linha", "Bia\nX"],
  ])("recusa caractere invisível ou de controle: %s", async (_n, displayName) => {
    const res = await h.call("POST", "/api/people/test", as("admin"), { displayName });
    expect(res.status).toBe(400);
    expect(code(res)).toBe("invalid_display_name");
    expect((await h.pool.query("select count(*)::int as n from people where is_test")).rows[0].n).toBe(0);
  });

  it("recusa nome igual ao de uma pessoa ativa, sem diferenciar maiúsculas, acentos nem espaços repetidos", async () => {
    await h.pool.query("update people set display_name = 'Ana Luísa' where clerk_user_id = 'u_plain'");
    for (const name of ["Ana Luísa", "ana luisa", "ANA  LUÍSA"]) {
      const res = await h.call("POST", "/api/people/test", as("admin"), { displayName: name });
      expect(res.status).toBe(409);
      expect(code(res)).toBe("display_name_taken");
    }
    // igual a outra pessoa de teste ativa também
    await createTestPerson(h, "Bia");
    expect(code(await h.call("POST", "/api/people/test", as("admin"), { displayName: "bia" }))).toBe("display_name_taken");
  });

  it("nome de pessoa inativa ou de outra organização não impede", async () => {
    const { id } = await createTestPerson(h, "Caio");
    await h.call("POST", `/api/people/${id}/deactivate`, as("admin"));
    expect((await h.call("POST", "/api/people/test", as("admin"), { displayName: "Caio" })).status).toBe(201);
    expect((await h.call("POST", "/api/people/test", sessionAs("u_outsider", OTHER_ORG, "org:admin"), { displayName: "Nome admin" })).status).toBe(201);
  });
});

describe("teto total de pessoas de teste (revisão 1)", () => {
  it("100 por organização, contando as desativadas: a 101ª é recusada com erro próprio, ativas ou não", async () => {
    for (let i = 0; i < 100; i++) await seedTestPerson(h.pool, ORG, `Antiga ${i}`, false);
    const res = await h.call("POST", "/api/people/test", as("admin"), { displayName: "Nova" });
    expect(res.status).toBe(409);
    expect(code(res)).toBe("test_people_total_limit");
    // a outra organização tem o próprio teto
    expect((await h.call("POST", "/api/people/test", sessionAs("u_outsider", OTHER_ORG, "org:admin"), { displayName: "Z" })).status).toBe(201);
  });
});

describe("desativar e reativar", () => {
  it("desativa e reativa pessoa de teste (idempotente)", async () => {
    const { id } = await createTestPerson(h);
    const off = await h.call("POST", `/api/people/${id}/deactivate`, as("admin"));
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id, active: false, isTest: true });
    expect((await h.call("POST", `/api/people/${id}/deactivate`, as("admin"))).status).toBe(200);
    const on = await h.call("POST", `/api/people/${id}/reactivate`, as("admin"));
    expect(on.body).toMatchObject({ id, active: true });
  });

  it("pessoa de verdade, inexistente e de outra organização: o mesmo 404", async () => {
    const other = await seedTestPerson(h.pool, OTHER_ORG, "Fora");
    const bodies = [];
    for (const id of [h.world().people.reader, h.world().people.admin, "00000000-0000-4000-8000-000000000000", other, "nao-e-uuid"]) {
      for (const verb of ["deactivate", "reactivate"]) {
        const res = await h.call("POST", `/api/people/${id}/${verb}`, as("admin"));
        expect([404, 400]).toContain(res.status);
        if (id !== "nao-e-uuid") {
          expect(res.status).toBe(404);
          bodies.push(JSON.stringify(res.body));
        }
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await h.pool.query("select active from people where id = $1::uuid", [h.world().people.reader])).rows[0].active).toBe(true);
    expect((await h.pool.query("select active from people where id = $1::uuid", [other])).rows[0].active).toBe(true);
  });

  it("membro recebe 403", async () => {
    const { id } = await createTestPerson(h);
    expect((await h.call("POST", `/api/people/${id}/deactivate`, as("manager"))).status).toBe(403);
    expect((await h.call("POST", `/api/people/${id}/reactivate`, as("manager"))).status).toBe(403);
  });

  it("agindo como outra pessoa: not_while_acting_as", async () => {
    const { id } = await createTestPerson(h);
    for (const [method, path, body] of [["POST", "/api/people/test", { displayName: "X" }], ["POST", `/api/people/${id}/deactivate`, undefined], ["POST", `/api/people/${id}/reactivate`, undefined]] as const) {
      const res = await h.call(method, path, as("admin"), body, actAs(id));
      expect(res.status).toBe(403);
      expect(code(res)).toBe("not_while_acting_as");
    }
    expect((await h.pool.query("select active from people where id = $1::uuid", [id])).rows[0].active).toBe(true);
  });
});

describe("GET /api/people", () => {
  it("devolve isTest em cada pessoa", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const res = await h.call("GET", "/api/people", as("manager"));
    expect(res.status).toBe(200);
    const byId = new Map((res.body as { id: string; isTest: boolean }[]).map((p) => [p.id, p.isTest]));
    expect(byId.get(id)).toBe(true);
    expect(byId.get(h.world().people.reader)).toBe(false);
    expect([...byId.values()].every((v) => typeof v === "boolean")).toBe(true);
  });
});

describe("provisionamento do primeiro acesso", () => {
  it("nunca toca numa pessoa de teste nem a adota, mesmo com o identificador igual", async () => {
    const { id, clerkUserId } = await createTestPerson(h, "Bia");
    const before = (await h.pool.query("select * from people where id = $1::uuid", [id])).rows[0];
    const res = await h.call("GET", "/api/me", sessionAs(clerkUserId, ORG, "org:admin"));
    expect(res.status).toBe(403);
    const after = (await h.pool.query("select * from people where id = $1::uuid", [id])).rows[0];
    expect(after).toEqual(before);
  });

  it("um usuário de verdade comum continua sendo provisionado", async () => {
    const res = await h.call("GET", "/api/me", sessionAs("user_novo", ORG, "org:member"));
    expect(res.status).toBe(200);
    expect((await h.pool.query("select is_test from people where clerk_user_id = 'user_novo'")).rows[0].is_test).toBe(false);
  });
});

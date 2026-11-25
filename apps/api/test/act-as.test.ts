import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { IS_PUBLIC } from "../src/auth/public.decorator.js";
import { AI_CONFIG, GITHUB_CONFIG, LINEAR_KEY_BASE64 } from "./helpers.js";
import { useHarness } from "./harness.js";
import { ACT_AS, actAs, createTestPerson, seedTestPerson, snapshot } from "./act-as-support.js";
import { errorCode, openGeneral, openTicket, post, seedChatTickets, view } from "./chat-support.js";
import { ForbiddenException } from "@nestjs/common";
import { withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { PRISMA } from "../src/db/prisma.provider.js";
import { Reflector } from "@nestjs/core";
import { AuthorizationService } from "../src/access/authorization.service.js";
import { IdentityService } from "../src/access/identity.service.js";
import { TenantInterceptor } from "../src/db/tenant.interceptor.js";
import { PrincipalService } from "../src/access/principal.service.js";
import { Logger } from "@nestjs/common";
import { vi } from "vitest";
import { ORG, OTHER_ORG, as } from "./world.js";

// ADR 0057: "entrar como" vale só para pessoa de teste. O servidor confere (quem pede é administrador e ativo; o alvo é de teste, ativo
// e da mesma organização); qualquer falha é 403 `act_as_not_allowed` com o mesmo corpo, e a requisição NÃO é atendida como o administrador.
const h = useHarness({ ...GITHUB_CONFIG, CREDENTIALS_ENCRYPTION_KEY: LINEAR_KEY_BASE64, ANTHROPIC_API_KEY: AI_CONFIG.ANTHROPIC_API_KEY, TYPESAFE_API_KEY: AI_CONFIG.TYPESAFE_API_KEY });
/** Rotas autenticadas da API hoje; muda junto com os controladores. */
const EXPECTED_ROUTES = 112;
const UUID = "0190c0de-0000-7000-8000-000000000001";

/** Todas as rotas autenticadas de todos os controladores da aplicação (método e caminho com os parâmetros trocados por um uuid). */
export function allRoutes(app: INestApplication): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const ctrl of mod.controllers.values()) {
      const type = ctrl.metatype as (new () => object) | null;
      if (!type) continue;
      const classPublic = Reflect.getMetadata(IS_PUBLIC, type) === true;
      const base = (Reflect.getMetadata(PATH_METADATA, type) as string) ?? "";
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const fn = (type.prototype as Record<string, unknown>)[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
        if (method === undefined) continue;
        if (classPublic || Reflect.getMetadata(IS_PUBLIC, fn) === true) continue;
        const path = [base, Reflect.getMetadata(PATH_METADATA, fn) as string].filter(Boolean).join("/");
        out.push({ method: RequestMethod[method] as string, path: `/api/${path.replace(/\/+/g, "/").replace(/^\//, "").replace(/\/$/, "").replace(/:[A-Za-z]+/g, UUID)}` });
      }
    }
  }
  return out.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

type Case = { name: string; session: () => string; header: () => string; setup?: () => Promise<void> };

describe("toda rota recusa 'entrar como' fora da regra, sem efeito", () => {
  it("enumera as rotas da aplicação (sanidade)", () => {
    const routes = allRoutes(h.app());
    // A contagem é exata de propósito: rota nova (ou sumida) obriga a reler esta matriz e decidir se ela precisa de caso próprio.
    expect(routes.length).toBe(EXPECTED_ROUTES);
    expect(routes.some((r) => r.method === "GET" && r.path === "/api/me")).toBe(true);
    expect(routes.some((r) => r.method === "POST" && r.path === "/api/people/test")).toBe(true);
  });

  const cases: Case[] = [
    { name: "alvo é pessoa de verdade", session: () => as("admin"), header: () => h.world().people.reader },
    { name: "alvo é o próprio administrador", session: () => as("admin"), header: () => h.world().people.admin },
    { name: "alvo é pessoa de teste de outra organização", session: () => as("admin"), header: () => other },
    { name: "alvo de teste inativo", session: () => as("admin"), header: () => inactive },
    { name: "alvo inexistente", session: () => as("admin"), header: () => "0190c0de-0000-7000-8000-0000000000ff" },
    { name: "quem pede é membro", session: () => as("manager"), header: () => active },
    // O cenário de verdade: a linha no banco diz 'admin', mas a sessão (o Clerk) diz membro. Vale a sessão.
    { name: "membro no Clerk e administrador só no banco", session: () => as("contributor"), header: () => active, setup: async () => void (await h.pool.query("update people set clerk_role = 'admin' where id = $1::uuid", [h.world().people.contributor])) },
    { name: "quem pede está inativo", session: () => as("admin"), header: () => active, setup: async () => void (await h.pool.query("update people set active = false where id = $1::uuid", [h.world().people.admin])) },
    { name: "cabeçalho malformado", session: () => as("admin"), header: () => "não-é-um-uuid" },
    { name: "cabeçalho vazio", session: () => as("admin"), header: () => "" },
    { name: "cabeçalho repetido", session: () => as("admin"), header: () => `${active}, ${active}` },
    { name: "cabeçalho com espaços e lixo", session: () => as("admin"), header: () => ` ${active};x` },
  ];
  let active = "";
  let inactive = "";
  let other = "";

  it.each(cases)("$name: 403 igual para todos os motivos, em toda rota, sem efeito", async (c) => {
    active = (await createTestPerson(h, "Ativa")).id;
    inactive = await seedTestPerson(h.pool, ORG, "Inativa", false);
    other = await seedTestPerson(h.pool, OTHER_ORG, "Fora");
    await c.setup?.();
    const before = await snapshot(h.pool);
    const bodies = new Set<string>();
    const wrong: string[] = [];
    for (const route of allRoutes(h.app())) {
      const body = route.method === "GET" || route.method === "DELETE" ? undefined : {};
      const res = await h.call(route.method, route.path, c.session(), body, { [ACT_AS]: c.header() });
      if (res.status !== 403 || errorCode(res) !== "act_as_not_allowed") wrong.push(`${route.method} ${route.path} -> ${res.status} ${errorCode(res)}`);
      bodies.add(JSON.stringify(res.body));
    }
    expect(wrong).toEqual([]);
    expect(bodies.size).toBe(1);
    expect(await snapshot(h.pool)).toEqual(before);
  });

  it("todas as recusas têm exatamente o mesmo corpo (não revelam o motivo)", async () => {
    active = (await createTestPerson(h, "Ativa")).id;
    const reasons = [h.world().people.reader, "0190c0de-0000-7000-8000-0000000000ff", "lixo", ""];
    const bodies = new Set<string>();
    for (const value of reasons) bodies.add(JSON.stringify((await h.call("GET", "/api/me", as("admin"), undefined, { [ACT_AS]: value })).body));
    bodies.add(JSON.stringify((await h.call("GET", "/api/me", as("manager"), undefined, actAs(active))).body));
    expect(bodies.size).toBe(1);
  });

  it("sem o cabeçalho nada muda: o administrador segue sendo atendido como ele mesmo", async () => {
    const res = await h.call("GET", "/api/me", as("admin"));
    expect(res.status).toBe(200);
    expect(res.body.person.id).toBe(h.world().people.admin);
    expect(res.body.actingAs).toBeNull();
  });
});

describe("com uma pessoa de teste válida como alvo", () => {
  it("a rota de identidade devolve a pessoa de teste, o papel de membro e quem é a pessoa de verdade", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const res = await h.call("GET", "/api/me", as("admin"), undefined, actAs(id));
    expect(res.status).toBe(200);
    expect(res.body.person).toMatchObject({ id, displayName: "Bia" });
    expect(res.body.roles.clerk).toBe("member");
    expect(res.body.actingAs).toEqual({ realDisplayName: "Nome de u_admin" });
    // o organization e o isolamento continuam os da sessão
    expect(res.body.organization.orgId).toBe(ORG);
  });

  it("não escreve nada na pessoa de verdade nem na de teste só por ler a identidade", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const before = (await h.pool.query("select * from people where id = $1::uuid", [id])).rows[0];
    await h.call("GET", "/api/me", as("admin"), undefined, actAs(id));
    expect((await h.pool.query("select * from people where id = $1::uuid", [id])).rows[0]).toEqual(before);
  });

  it("os papéis de time e de projeto são os dela, não os do administrador", async () => {
    const { id } = await createTestPerson(h, "Bia");
    await h.pool.query("insert into team_memberships (org_id, team_id, person_id, role) values ($1,$2,$3,'admin')", [ORG, h.world().teams.t2, id]);
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'reader')", [ORG, h.world().projects.priv, id]);
    const res = await h.call("GET", "/api/me", as("admin"), undefined, actAs(id));
    expect(res.body.roles.teams).toEqual([{ teamId: h.world().teams.t2, role: "admin" }]);
    expect(res.body.roles.projects).toEqual([{ projectId: h.world().projects.priv, role: "reader" }]);
    const mine = await h.call("GET", "/api/me", as("admin"));
    expect(mine.body.roles.clerk).toBe("admin");
    expect(mine.body.roles.teams).toEqual([]);
  });

  it("uma rota só de administrador responde como para membro (aceite de IA)", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const asAdmin = await h.call("GET", "/api/organization/ai-consent", as("admin"));
    expect(asAdmin.status).toBe(200);
    const asBia = await h.call("PUT", "/api/organization/ai-consent/assistant", as("admin"), { version: "rascunho-2" }, actAs(id));
    expect(asBia.status).toBe(403);
    expect(errorCode(asBia)).not.toBe("act_as_not_allowed");
  });

  it("chaves de acesso e as rotas de pessoa de teste dão not_while_acting_as", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const attempts = [
      h.call("POST", "/api/access-tokens", as("admin"), { projectId: h.world().projects.priv, name: "x", expiresInDays: 30 }, actAs(id)),
      h.call("DELETE", `/api/access-tokens/${UUID}`, as("admin"), undefined, actAs(id)),
      h.call("PATCH", "/api/organization", as("admin"), { mcpEnabled: true }, actAs(id)),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe("not_while_acting_as");
    }
  });

  it("GET /api/linear/connection agindo como outra pessoa: 200 com actingAs true e nenhuma conexão (a web mostra a frase própria)", async () => {
    const { id } = await createTestPerson(h, "Bia");
    await h.pool.query(
      `insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
       values ('org_A', $1::uuid, 'linear', $2, $3, 1, 'ws-1', 'Acme', 'abcd')`,
      [h.world().people.admin, Buffer.from("cifrado-0123456789ab"), Buffer.alloc(12, 3)],
    );
    const own = await h.call("GET", "/api/linear/connection", as("admin"));
    expect(own.body.connection).toMatchObject({ workspace: { id: "ws-1", name: "Acme" }, hint: "abcd" });
    expect(own.body.actingAs).toBeUndefined();
    const res = await h.call("GET", "/api/linear/connection", as("admin"), undefined, actAs(id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, connection: null, actingAs: true });
    expect(h.linear().calls).toHaveLength(0);
  });

  it("as seis rotas do Linear: a leitura da conexão responde (actingAs) e as outras cinco dão not_while_acting_as, sem chamar o Linear e sem gravar", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const before = await snapshot(h.pool);
    const project = h.world().projects.priv;
    const attempts = [
      h.call("PUT", "/api/linear/connection", as("admin"), { apiKey: "lin_api_x" }, actAs(id)),
      h.call("DELETE", "/api/linear/connection", as("admin"), undefined, actAs(id)),
      h.call("GET", "/api/linear/teams", as("admin"), undefined, actAs(id)),
      h.call("GET", `/api/projects/${project}/linear`, as("admin"), undefined, actAs(id)),
      h.call("POST", `/api/projects/${project}/linear`, as("admin"), { teamId: "t", confirmTeamKey: "ENG" }, actAs(id)),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(errorCode(res)).toBe("not_while_acting_as");
    }
    const read = await h.call("GET", "/api/linear/connection", as("admin"), undefined, actAs(id));
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ configured: true, connection: null, actingAs: true });
    expect(h.linear().calls).toHaveLength(0);
    expect(await snapshot(h.pool)).toEqual(before);
  });

  it("o isolamento por organização continua o da sessão: a pessoa de teste não vê a outra organização", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const people = await h.call("GET", "/api/people", as("admin"), undefined, actAs(id));
    expect(people.status).toBe(200);
    expect(people.body.some((p: { id: string }) => p.id === h.world().other.person)).toBe(false);
  });

  it("o chat geral do administrador não é lido pela pessoa de teste, e o dela não é lido por ele", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const mine = await openGeneral(h, "admin");
    const hers = (await h.call("POST", "/api/conversations/general", as("admin"), undefined, actAs(id))).body.id as string;
    expect(hers).not.toBe(mine);
    expect((await h.call("GET", `/api/conversations/${mine}`, as("admin"), undefined, actAs(id))).status).toBe(404);
    expect((await h.call("GET", `/api/conversations/${hers}`, as("admin"))).status).toBe(404);
    expect((await h.call("GET", `/api/conversations/${hers}`, as("admin"), undefined, actAs(id))).status).toBe(200);
    expect((await h.call("GET", `/api/conversations/${mine}`, as("admin"))).status).toBe(200);
  });

  it("marcada numa thread, a pessoa de teste vê a thread e responde; a mensagem fica registrada como dela", async () => {
    const { id } = await createTestPerson(h, "Bia");
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'contributor')", [ORG, h.world().projects.priv, id]);
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const opened = await post(h, "manager", main, "Bia, olha isto", [id]);
    expect(opened.status).toBe(201);
    const thread = opened.body.thread.id as string;
    expect((await view(h, "reader", thread)).status).toBe(404);
    const seen = await h.call("GET", `/api/conversations/${thread}`, as("admin"), undefined, actAs(id));
    expect(seen.status).toBe(200);
    const sent = await h.call("POST", `/api/conversations/${thread}/messages`, as("admin"), { body: "Oi, cheguei" }, actAs(id));
    expect(sent.status).toBe(201);
    const row = (await h.pool.query("select author_person_id from conversation_messages where body = 'Oi, cheguei'")).rows[0];
    expect(row.author_person_id).toBe(id);
    // o administrador (sem agir como ela) não lê a thread: não está nela
    expect((await h.call("GET", `/api/conversations/${thread}`, as("admin"))).status).toBe(404);
  });

  it("a conferência é refeita a cada requisição: pessoa desativada no meio perde o acesso", async () => {
    const { id } = await createTestPerson(h, "Bia");
    expect((await h.call("GET", "/api/me", as("admin"), undefined, actAs(id))).status).toBe(200);
    await h.call("POST", `/api/people/${id}/deactivate`, as("admin"));
    const res = await h.call("GET", "/api/me", as("admin"), undefined, actAs(id));
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("act_as_not_allowed");
  });
});

describe("rastro de quem agiu (revisão 1)", () => {
  const warnings = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.startsWith("act-as refused"));

  it("toda recusa é registrada no servidor com o motivo em código e só ids (nada de nome nem e-mail)", async () => {
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { id } = await createTestPerson(h, "Bia");
      const inactiveId = await seedTestPerson(h.pool, ORG, "Dormindo", false);
      const reasons: [string, () => Promise<unknown>][] = [
        ["target_real_person", () => h.call("GET", "/api/me", as("admin"), undefined, actAs(h.world().people.reader))],
        ["target_not_found", () => h.call("GET", "/api/me", as("admin"), undefined, actAs("0190c0de-0000-7000-8000-0000000000ff"))],
        ["target_inactive", () => h.call("GET", "/api/me", as("admin"), undefined, actAs(inactiveId))],
        ["malformed_header", () => h.call("GET", "/api/me", as("admin"), undefined, { [ACT_AS]: "lixo" })],
        ["requester_not_admin", () => h.call("GET", "/api/me", as("manager"), undefined, actAs(id))],
      ];
      for (const [reason, run] of reasons) {
        spy.mockClear();
        await run();
        const lines = warnings(spy);
        expect(lines, reason).toHaveLength(1);
        expect(lines[0]).toContain(`reason=${reason}`);
        expect(lines[0]).toContain(`org=${ORG}`);
        expect(lines[0]).not.toMatch(/Bia|Nome |@/);
      }
      spy.mockClear();
      await h.call("GET", "/api/me", as("admin"), undefined, actAs(h.world().people.reader));
      expect(warnings(spy)[0]).toContain(`real=${h.world().people.admin} target=${h.world().people.reader}`);
    } finally {
      spy.mockRestore();
    }
  });

  it("o pedido atendido não gera aviso de recusa", async () => {
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const { id } = await createTestPerson(h, "Bia");
      expect((await h.call("GET", "/api/me", as("admin"), undefined, actAs(id))).status).toBe(200);
      expect(warnings(spy)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a escrita agindo como outra pessoa leva 'act-as' e a pessoa de verdade, no evento de atividade e no comentário", async () => {
    const { id } = await createTestPerson(h, "Bia");
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'contributor')", [ORG, h.world().projects.priv, id]);
    const created = await h.call("POST", `/api/projects/${h.world().projects.priv}/tickets`, as("admin"), { title: "Do administrador" });
    expect(created.status).toBe(201);
    const ticketId = created.body.id as string;
    const commented = await h.call("POST", `/api/tickets/${ticketId}/comments`, as("admin"), { body: "Oi da Bia" }, actAs(id));
    expect(commented.status).toBe(201);
    const comment = (await h.pool.query("select author_person_id, via, via_person_id from ticket_comments where ticket_id = $1::uuid", [ticketId])).rows[0];
    expect(comment).toEqual({ author_person_id: id, via: "act-as", via_person_id: h.world().people.admin });
    const events = (await h.pool.query("select actor_person_id, payload from activity_events where kind = 'ticket.comment_added' and subject_id = $1", [ticketId])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].actor_person_id).toBe(id);
    expect(events[0].payload).toMatchObject({ via: "act-as", realPersonId: h.world().people.admin });
    // escrita feita como o próprio administrador não leva a marca
    await h.call("POST", `/api/tickets/${ticketId}/comments`, as("admin"), { body: "Meu" });
    expect((await h.pool.query("select count(*)::int as n from ticket_comments where ticket_id = $1::uuid and via is null and via_person_id is null", [ticketId])).rows[0].n).toBe(1);
    expect((await h.pool.query("select count(*)::int as n from activity_events where subject_id = $1 and payload ? 'realPersonId'", [ticketId])).rows[0].n).toBe(1);
  });

  it("a leitura pública (atividade do ticket) não expõe a pessoa de verdade nem o tipo 'act-as'", async () => {
    const { id } = await createTestPerson(h, "Bia");
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'contributor')", [ORG, h.world().projects.priv, id]);
    const created = await h.call("POST", `/api/projects/${h.world().projects.priv}/tickets`, as("manager"), { title: "T" }); // quem criou o ticket é outra pessoa: o id do administrador só aparece se vazar
    const ticketId = created.body.id as string;
    await h.call("POST", `/api/tickets/${ticketId}/comments`, as("admin"), { body: "Oi" }, actAs(id));
    for (const session of [as("admin"), as("manager")]) {
      const feed = await h.call("GET", `/api/tickets/${ticketId}/activity`, session);
      expect(feed.status).toBe(200);
      const text = JSON.stringify(feed.body);
      expect(text).toContain("Oi");
      expect(text).not.toContain(h.world().people.admin);
      expect(text).not.toContain("act-as");
      expect(text).not.toContain("realPersonId");
    }
    const asBia = await h.call("GET", `/api/tickets/${ticketId}/activity`, as("admin"), undefined, actAs(id));
    expect(JSON.stringify(asBia.body)).not.toContain(h.world().people.admin);
  });
});

describe("rota com várias transações reconfere o alvo (revisão 1, item 11)", () => {
  it("cada transação do executor refaz a conferência: pessoa de teste desativada entre as transações perde a segunda", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const principals = h.app().get(PrincipalService);
    const prisma = h.app().get<PrismaClient>(PRISMA);
    const tenant = { orgId: ORG, userId: "u_admin" };
    const session = { userId: "u_admin", orgId: ORG, orgRole: "org:admin" } as never;
    const principal = await withTenant(prisma, tenant, (tx) => principals.load(tx, session, "admin", null, { requested: true, personId: id }));
    expect(principal.via?.kind).toBe("act-as");
    // primeira transação: vale
    await withTenant(prisma, tenant, (tx) => principals.recheckActAs(tx, principal));
    await h.call("POST", `/api/people/${id}/deactivate`, as("admin"));
    // segunda: o alvo mudou, a recusa é a mesma de sempre
    await expect(withTenant(prisma, tenant, (tx) => principals.recheckActAs(tx, principal))).rejects.toBeInstanceOf(ForbiddenException);
    // sem "entrar como" a reconferência não faz nada
    const plain = await withTenant(prisma, tenant, (tx) => principals.load(tx, session, "admin", null));
    await withTenant(prisma, tenant, (tx) => principals.recheckActAs(tx, plain));
  });

  it("o executor de transações do interceptor (o que as rotas @OwnTransactions usam) chama a reconferência a cada transação", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const principals = h.app().get(PrincipalService);
    const prisma = h.app().get<PrismaClient>(PRISMA);
    const interceptor = new TenantInterceptor(prisma, h.app().get(Reflector), h.app().get(IdentityService), h.app().get(AuthorizationService), principals) as unknown as { runner: (tenant: { orgId: string; userId: string }, principal: unknown) => { run: <T>(fn: () => Promise<T>) => Promise<T> } };
    const tenant = { orgId: ORG, userId: "u_admin" };
    const session = { userId: "u_admin", orgId: ORG, orgRole: "org:admin" } as never;
    const principal = await withTenant(prisma, tenant, (tx) => principals.load(tx, session, "admin", null, { requested: true, personId: id }));
    const runner = interceptor.runner(tenant, principal);
    expect(await runner.run(async () => "primeira")).toBe("primeira");
    await h.call("POST", `/api/people/${id}/deactivate`, as("admin"));
    const ran = vi.fn(async () => "segunda");
    await expect(runner.run(ran)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ran).not.toHaveBeenCalled();
  });

  it("e o administrador que pede: se ficou inativo entre as transações, a seguinte é recusada", async () => {
    const { id } = await createTestPerson(h, "Bia");
    const principals = h.app().get(PrincipalService);
    const prisma = h.app().get<PrismaClient>(PRISMA);
    const tenant = { orgId: ORG, userId: "u_admin" };
    const session = { userId: "u_admin", orgId: ORG, orgRole: "org:admin" } as never;
    const principal = await withTenant(prisma, tenant, (tx) => principals.load(tx, session, "admin", null, { requested: true, personId: id }));
    await h.pool.query("update people set active = false where id = $1::uuid", [h.world().people.admin]);
    await expect(withTenant(prisma, tenant, (tx) => principals.recheckActAs(tx, principal))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

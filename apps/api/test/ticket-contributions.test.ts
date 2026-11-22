import { describe, expect, it } from "vitest";
import { APP_URL } from "@treepm/db/testing";
import { createPrismaClient, withTenant } from "@treepm/db";
import type { TenantClient } from "@treepm/db";
import { buildActor } from "../src/access/actor.js";
import { TicketActivityService } from "../src/tickets/ticket-activity.service.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0041, fatia 1: contribuições por área no ticket.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const MIN = 60_000;
const BASE = Date.parse("2026-11-01T12:00:00Z");
type Body = Record<string, unknown>;
type Reader = Who | "outsider";
type Person = { id: string; displayName: string; avatarUrl: string | null };
type Contribution = { id: string; area: { id: string; name: string }; text: string; status: string; people: Person[] };
type Entry = { id: string; type: string; occurredAt: string; actor: Person | null; [k: string]: unknown };
type Page = { entries: Entry[]; before: string | null; canComment: boolean };

const personId = (who: Who | "target") => h.world().people[who];
const add = async (body: Body = {}, project = priv()): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${project}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
let areaCounter = 0;
const area = async (name = `Área ${++areaCounter}`): Promise<{ id: string; name: string }> => {
  const res = await h.call("POST", "/api/areas", as("admin"), { name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; name: string };
};
const create = (ticketId: string, areaId: string, who: Reader = "contributor", org = "org_A") => h.call("POST", `/api/tickets/${ticketId}/contributions`, as(who, org), { areaId });
const update = (id: string, body: unknown, who: Reader = "contributor", org = "org_A") => h.call("PATCH", `/api/contributions/${id}`, as(who, org), body);
const drop = (id: string, who: Reader = "contributor", org = "org_A") => h.call("DELETE", `/api/contributions/${id}`, as(who, org));
const put = (id: string, person: string, who: Reader = "contributor", org = "org_A") => h.call("PUT", `/api/contributions/${id}/people/${person}`, as(who, org));
const unput = (id: string, person: string, who: Reader = "contributor", org = "org_A") => h.call("DELETE", `/api/contributions/${id}/people/${person}`, as(who, org));
const made = async (ticketId: string, areaId?: string, who: Who = "contributor"): Promise<Contribution> => {
  const res = await create(ticketId, areaId ?? (await area()).id, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Contribution;
};
const detail = async (id: string, who: Reader = "admin") => {
  const res = await h.call("GET", `/api/tickets/${id}`, as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { contributions: Contribution[]; canEditContributions: boolean; status: string; progress: unknown } & Body;
};
const feed = async (id: string, query = "", who: Who = "admin"): Promise<Page> => {
  const res = await h.call("GET", `/api/tickets/${id}/activity${query}`, as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
};
const row = async (id: string) => (await h.pool.query("select * from ticket_contributions where id = $1", [id])).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await h.pool.query(sql, params)).rows[0].count);
const cEvents = async () => (await h.pool.query("select * from activity_events where kind like 'ticket.contribution_%' order by occurred_at, id")).rows;
const placeCEvents = async (minutes: number[]) => {
  for (const [i, r] of (await cEvents()).entries()) await h.pool.query("update activity_events set occurred_at = $1 where id = $2", [new Date(BASE + (minutes[i] ?? 0) * MIN), r.id]);
};

describe("criar: POST tickets/:id/contributions", () => {
  it("gestor, colaborador e administrador criam; a resposta é a contribuição", async () => {
    const t = await add();
    for (const who of ["manager", "contributor", "admin"] as Who[]) {
      const a = await area();
      const res = await create(t.id, a.id, who);
      expect(res.status, who).toBe(201);
      expect(res.body).toEqual({ id: expect.any(String), area: { id: a.id, name: a.name }, text: "", status: "todo", people: [], commentCount: 0 });
      expect(await row((res.body as Contribution).id)).toMatchObject({ project_id: priv(), ticket_id: t.id, area_id: a.id, created_by_person_id: personId(who), text: "", status: "todo" });
    }
  });

  it("leitor recebe 403; sem acesso, ticket inexistente e outra organização recebem 404, sem gravar", async () => {
    const t = await add();
    const a = await area();
    expect((await create(t.id, a.id, "reader")).status).toBe(403);
    const denied = await create(t.id, a.id, "plain");
    const unknown = await create(UNKNOWN_ID, a.id);
    const other = await create(t.id, a.id, "outsider", "org_B");
    expect([denied.status, unknown.status, other.status]).toEqual([404, 404, 404]);
    expect(denied.body).toEqual(unknown.body);
    expect(await count("select count(*) from ticket_contributions")).toBe(0);
    expect(await cEvents()).toHaveLength(0);
  });

  it("área inexistente ou de outra organização: 404; corpo inválido: 400", async () => {
    const t = await add();
    expect((await create(t.id, UNKNOWN_ID)).status).toBe(404);
    const foreign = await h.pool.query("insert into areas (org_id, name) values ('org_B', 'De B') returning id");
    expect((await create(t.id, foreign.rows[0].id)).status).toBe(404);
    for (const bad of [{}, { areaId: 7 }, { areaId: "nao-uuid" }, { areaId: UNKNOWN_ID, extra: 1 }]) {
      expect((await h.call("POST", `/api/tickets/${t.id}/contributions`, as("contributor"), bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await count("select count(*) from ticket_contributions")).toBe(0);
  });

  it("área já usada no ticket: 409 com código próprio; em outro ticket, vale", async () => {
    const t = await add();
    const a = await area();
    expect((await create(t.id, a.id)).status).toBe(201);
    const dup = await create(t.id, a.id, "manager");
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: { code: "contribution_area_taken" } });
    expect(await count("select count(*) from ticket_contributions")).toBe(1);
    expect(await count("select count(*) from activity_events where kind = 'ticket.contribution_added'")).toBe(1);
    expect((await create((await add()).id, a.id)).status).toBe(201);
  });

  it("duas criações simultâneas da mesma área: uma 201 e uma 409", async () => {
    const t = await add();
    const a = await area();
    const [x, y] = await Promise.all([create(t.id, a.id), create(t.id, a.id, "manager")]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await count("select count(*) from ticket_contributions")).toBe(1);
  });

  it("projeto arquivado recusa criar, editar, remover e mexer nas pessoas", async () => {
    const t = await add();
    const c = await made(t.id);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("manager"), { title: "x" })).status).toBe(409);
    for (const res of [await create(t.id, (await area()).id), await update(c.id, { text: "y" }), await drop(c.id), await put(c.id, personId("manager")), await unput(c.id, personId("manager"))]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "project_archived" } });
    }
    expect((await row(c.id)).text).toBe("");
  });
});

describe("editar: PATCH contributions/:id", () => {
  it("muda o texto e a situação; devolve a contribuição", async () => {
    const t = await add();
    const c = await made(t.id);
    const res = await update(c.id, { text: "## Entrega\n\nTela nova ver " + t.key, status: "in_progress" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: c.id, text: "## Entrega\n\nTela nova ver " + t.key, status: "in_progress" });
    expect(await row(c.id)).toMatchObject({ text: "## Entrega\n\nTela nova ver " + t.key, status: "in_progress" });
    expect((await update(c.id, { status: "done" }, "manager")).status).toBe(200);
    expect((await row(c.id)).text).toBe("## Entrega\n\nTela nova ver " + t.key);
    expect((await update(c.id, { text: "" })).status).toBe(200);
    expect((await row(c.id)).text).toBe("");
  });

  it("leitor 403; sem acesso, inexistente e outra organização o mesmo 404; corpo inválido 400", async () => {
    const t = await add();
    const c = await made(t.id);
    expect((await update(c.id, { text: "x" }, "reader")).status).toBe(403);
    const denied = await update(c.id, { text: "x" }, "plain");
    const unknown = await update(UNKNOWN_ID, { text: "x" });
    const other = await update(c.id, { text: "x" }, "outsider", "org_B");
    expect([denied.status, unknown.status, other.status]).toEqual([404, 404, 404]);
    expect(denied.body).toEqual(unknown.body);
    for (const bad of [{}, { text: 7 }, { status: "blocked" }, { text: "a".repeat(20_001) }, { text: "x", extra: 1 }, { areaId: UNKNOWN_ID }]) {
      expect((await update(c.id, bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await update("nao-uuid", { text: "x" })).status).toBe(400);
    expect((await row(c.id)).text).toBe("");
  });

  it("o texto vai de 0 a 20.000 caracteres, sem aparar", async () => {
    const t = await add();
    const c = await made(t.id);
    expect((await update(c.id, { text: "a".repeat(20_000) })).status).toBe(200);
    expect((await update(c.id, { text: "  com espaços \n" })).status).toBe(200);
    expect((await row(c.id)).text).toBe("  com espaços \n");
  });

  it("sem mudança não grava nada nem evento", async () => {
    const t = await add();
    const c = await made(t.id);
    await update(c.id, { text: "igual", status: "in_progress" });
    const before = await count("select count(*) from activity_events");
    expect((await update(c.id, { text: "igual" })).status).toBe(200);
    expect((await update(c.id, { status: "in_progress" })).status).toBe(200);
    expect((await update(c.id, { text: "igual", status: "in_progress" })).status).toBe(200);
    expect(await count("select count(*) from activity_events")).toBe(before);
  });

  it("não mexe na situação do ticket, no progresso nem em ligações", async () => {
    const target = await add({ title: "Alvo" });
    const parent = await add({ title: "Pai" });
    const t = await add({ title: "Filho", parentId: parent.id });
    const relations = async () => JSON.stringify((await h.pool.query("select * from ticket_relations order by id")).rows);
    const before = { ticket: await detail(t.id), parent: await detail(parent.id), relations: await relations() };
    const c = await made(t.id);
    await update(c.id, { text: `Depende de ${target.key} e ${t.key}.`, status: "done" });
    const after = { ticket: await detail(t.id), parent: await detail(parent.id), relations: await relations() };
    expect(after.ticket.status).toBe(before.ticket.status);
    expect(after.parent.progress).toEqual(before.parent.progress);
    expect(after.parent.status).toBe(before.parent.status);
    expect(after.relations).toBe(before.relations);
    expect((await h.pool.query("select count(*) from ticket_relations")).rows[0].count).toBe("0");
  });

  it("concluir um ticket com contribuição a fazer continua permitido", async () => {
    const t = await add();
    await made(t.id);
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("manager"), { status: "done" })).status).toBe(200);
    expect((await detail(t.id)).contributions.map((c) => c.status)).toEqual(["todo"]);
  });
});

describe("remover: DELETE contributions/:id", () => {
  it("apaga a contribuição, o texto e as pessoas de verdade", async () => {
    const t = await add();
    const c = await made(t.id);
    await update(c.id, { text: "segredo-da-area" });
    await put(c.id, personId("manager"));
    const res = await drop(c.id, "manager");
    expect(res.status).toBe(204);
    expect(await count("select count(*) from ticket_contributions")).toBe(0);
    expect(await count("select count(*) from ticket_contribution_people")).toBe(0);
    expect((await detail(t.id)).contributions).toEqual([]);
  });

  it("leitor 403; outros o mesmo 404; repetir é inócuo (404, sem segundo evento)", async () => {
    const t = await add();
    const c = await made(t.id);
    expect((await drop(c.id, "reader")).status).toBe(403);
    expect((await drop(c.id, "plain")).status).toBe(404);
    expect((await drop(c.id, "outsider", "org_B")).status).toBe(404);
    expect((await drop(UNKNOWN_ID)).status).toBe(404);
    expect(await count("select count(*) from ticket_contributions")).toBe(1);
    expect((await drop(c.id)).status).toBe(204);
    const events = await count("select count(*) from activity_events where kind = 'ticket.contribution_removed'");
    expect((await drop(c.id)).status).toBe(404);
    expect(await count("select count(*) from activity_events where kind = 'ticket.contribution_removed'")).toBe(events);
  });

  it("depois de removida, a área pode ser usada de novo e apagada", async () => {
    const t = await add();
    const a = await area();
    const c = await made(t.id, a.id);
    await drop(c.id);
    expect((await create(t.id, a.id)).status).toBe(201);
  });
});

describe("pessoas: PUT e DELETE contributions/:id/people/:personId", () => {
  it("acrescenta e tira, de forma idempotente, sem tocar em 'Pessoas' do ticket", async () => {
    const t = await add();
    const c = await made(t.id);
    const res = await put(c.id, personId("manager"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as Contribution).people).toEqual([{ id: personId("manager"), displayName: "Nome manager", avatarUrl: null }]);
    const events = await count("select count(*) from activity_events where kind = 'ticket.contribution_person_added'");
    expect((await put(c.id, personId("manager"), "admin")).status).toBe(200);
    expect(await count("select count(*) from activity_events where kind = 'ticket.contribution_person_added'")).toBe(events);
    expect(await count("select count(*) from ticket_contribution_people")).toBe(1);
    expect(await count("select count(*) from ticket_assignees")).toBe(0);
    expect((await unput(c.id, personId("manager"))).status).toBe(204);
    expect((await unput(c.id, personId("manager"))).status).toBe(204);
    expect(await count("select count(*) from activity_events where kind = 'ticket.contribution_person_removed'")).toBe(1);
    expect(await count("select count(*) from ticket_contribution_people")).toBe(0);
  });

  it("a mesma regra de quem pode ser responsável: sem acesso ao projeto 409, inexistente 404, inativa 409", async () => {
    const t = await add();
    const c = await made(t.id);
    const noAccess = await put(c.id, personId("plain"));
    expect(noAccess.status).toBe(409);
    expect(noAccess.body).toMatchObject({ error: { code: "person_without_project_access" } });
    expect((await put(c.id, UNKNOWN_ID)).status).toBe(404);
    await h.pool.query("update people set active = false where id = $1", [personId("reader")]);
    const inactive = await put(c.id, personId("reader"));
    expect(inactive.status).toBe(409);
    expect(inactive.body).toMatchObject({ error: { code: "person_inactive" } });
    expect((await put(c.id, personId("target"))).status).toBe(200);
    expect(await count("select count(*) from ticket_contribution_people")).toBe(1);
  });

  it("papéis e visibilidade: leitor 403; os outros o mesmo 404", async () => {
    const t = await add();
    const c = await made(t.id);
    expect((await put(c.id, personId("manager"), "reader")).status).toBe(403);
    expect((await unput(c.id, personId("manager"), "reader")).status).toBe(403);
    for (const call of [put, unput]) {
      expect((await call(c.id, personId("manager"), "plain")).status).toBe(404);
      expect((await call(c.id, personId("manager"), "outsider", "org_B")).status).toBe(404);
      expect((await call(UNKNOWN_ID, personId("manager"))).status).toBe(404);
    }
    expect((await put(c.id, "nao-uuid")).status).toBe(400);
  });
});

describe("leitura: GET tickets/:id", () => {
  it("devolve as contribuições na ordem de criação, com área e pessoas, e canEditContributions", async () => {
    const t = await add();
    const one = await made(t.id);
    const two = await made(t.id);
    await put(two.id, personId("manager"));
    await put(two.id, personId("admin"));
    await update(one.id, { text: "Texto um", status: "done" });
    const d = await detail(t.id);
    expect(d.contributions.map((c) => c.id)).toEqual([one.id, two.id]);
    expect(d.contributions[0]).toEqual({ id: one.id, area: one.area, text: "Texto um", status: "done", people: [], commentCount: 0 });
    expect(d.contributions[1]?.people.map((p) => p.displayName)).toEqual(["Nome admin", "Nome manager"]);
    expect(d.canEditContributions).toBe(true);
  });

  it("canEditContributions: verdadeiro para quem edita, falso para leitor e em projeto arquivado", async () => {
    const t = await add();
    await made(t.id);
    expect((await detail(t.id, "manager")).canEditContributions).toBe(true);
    expect((await detail(t.id, "contributor")).canEditContributions).toBe(true);
    expect((await detail(t.id, "reader")).canEditContributions).toBe(false);
    expect((await detail(t.id, "reader")).contributions).toHaveLength(1);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await detail(t.id, "manager")).canEditContributions).toBe(false);
    expect((await detail(t.id, "admin")).contributions).toHaveLength(1);
  });

  it("ticket sem contribuições devolve lista vazia; as respostas que devolvem o ticket trazem os mesmos campos", async () => {
    const t = await add();
    expect((await detail(t.id)).contributions).toEqual([]);
    await made(t.id);
    const patched = await h.call("PATCH", `/api/tickets/${t.id}`, as("manager"), { title: "novo" });
    expect((patched.body as { contributions: unknown[] }).contributions).toHaveLength(1);
    const assigned = await h.call("PUT", `/api/tickets/${t.id}/assignees/${personId("manager")}`, as("manager"));
    expect((assigned.body as { contributions: unknown[]; canEditContributions: boolean }).canEditContributions).toBe(true);
    const created = await h.call("POST", `/api/projects/${priv()}/tickets`, as("manager"), { title: "Novo" });
    expect(created.body).toMatchObject({ contributions: [], canEditContributions: true });
  });

  it("a lista de tickets não muda: nenhuma chave nova", async () => {
    const t = await add();
    await made(t.id);
    const list = await h.call("GET", `/api/projects/${priv()}/tickets`, as("admin"));
    expect(Object.keys((list.body as Body[])[0] as Body).sort()).toEqual(["assigneeIds", "descriptionExcerpt", "id", "idea", "key", "number", "parentId", "progress", "projectId", "status", "title"]);
    expect(JSON.stringify(list.body)).not.toMatch(/contribution/i);
  });

  it("o custo do detalhe não cresce com o número de contribuições", async () => {
    const t = await add();
    const queriesOf = async (): Promise<number> => {
      const prisma = createPrismaClient(APP_URL);
      try {
        return await withTenant(prisma, { orgId: "org_A", userId: "u_admin" }, async (tx) => {
          const project = await tx.project.findFirstOrThrow({ where: { id: priv() } });
          let queries = 0;
          const counting = new Proxy(tx, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver) as unknown;
              if (prop === "$queryRaw" || prop === "$executeRaw") return (...args: unknown[]) => { queries += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
              if (typeof prop === "string" && !prop.startsWith("$") && typeof value === "object" && value !== null) {
                return new Proxy(value, {
                  get(model, method) {
                    const fn = Reflect.get(model, method) as unknown;
                    return typeof fn === "function" ? (...args: unknown[]) => { queries += 1; return (fn as (...a: unknown[]) => unknown).apply(model, args); } : fn;
                  },
                });
              }
              return value;
            },
          }) as TenantClient;
          const { TicketsService } = await import("../src/tickets/tickets.service.js");
          const service = Object.create(TicketsService.prototype) as InstanceType<typeof TicketsService>;
          const viewer = { personId: personId("manager"), actor: buildActor("member", [], [{ projectId: project.id, role: "manager" }]) };
          const page = await service.detailFor(counting, project, t.id, viewer);
          expect(page.contributions.length).toBeGreaterThanOrEqual(0);
          return queries;
        });
      } finally {
        await prisma.$disconnect();
      }
    };
    const none = await queriesOf();
    const one = await made(t.id);
    await put(one.id, personId("manager"));
    const some = await queriesOf();
    for (let i = 0; i < 5; i++) {
      const c = await made(t.id);
      await put(c.id, personId("manager"));
      await put(c.id, personId("admin"));
    }
    const many = await queriesOf();
    expect(many).toBe(some);
    expect(some - none).toBeLessThanOrEqual(2);
  });
});

describe("áreas: apagar", () => {
  it("área com contribuição: 409 com código próprio e a contagem de tickets; renomear continua livre", async () => {
    const a = await area("Design");
    const t1 = await add();
    const t2 = await add();
    await made(t1.id, a.id);
    await made(t2.id, a.id);
    const res = await h.call("DELETE", `/api/areas/${a.id}`, as("admin"));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "area_in_use", details: { ticketCount: 2 } } });
    expect(await count("select count(*) from areas where id = $1", [a.id])).toBe(1);
    expect(await count("select count(*) from activity_events where kind = 'area.deleted'")).toBe(0);
    expect((await h.call("PATCH", `/api/areas/${a.id}`, as("admin"), { name: "Design 2" })).status).toBe(200);
    expect((await detail(t1.id)).contributions[0]?.area.name).toBe("Design 2");
  });

  it("área sem contribuição continua sendo apagada; depois de remover a contribuição também", async () => {
    const free = await area();
    expect((await h.call("DELETE", `/api/areas/${free.id}`, as("admin"))).status).toBe(204);
    const used = await area();
    const c = await made((await add()).id, used.id);
    await drop(c.id);
    expect((await h.call("DELETE", `/api/areas/${used.id}`, as("admin"))).status).toBe(204);
  });

  it("quem não administra continua sem apagar (403), com ou sem contribuição", async () => {
    const a = await area();
    await made((await add()).id, a.id);
    expect((await h.call("DELETE", `/api/areas/${a.id}`, as("manager"))).status).toBe(403);
  });
});

describe("eventos: payload exato e sem texto", () => {
  it("added, updated, person_added, person_removed e removed no assunto ticket", async () => {
    const t = await add();
    const a = await area("Dados");
    const c = await made(t.id, a.id, "contributor");
    await update(c.id, { text: "texto-secreto-ABC", status: "in_progress" }, "manager");
    await put(c.id, personId("manager"));
    await unput(c.id, personId("manager"));
    await update(c.id, { status: "done" });
    await update(c.id, { text: "outro-texto-secreto-DEF" });
    await drop(c.id, "manager");
    const rows = await cEvents();
    expect(rows.map((r) => r.kind)).toEqual([
      "ticket.contribution_added",
      "ticket.contribution_updated",
      "ticket.contribution_person_added",
      "ticket.contribution_person_removed",
      "ticket.contribution_updated",
      "ticket.contribution_updated",
      "ticket.contribution_removed",
    ]);
    for (const r of rows) {
      expect(r.subject_type).toBe("ticket");
      expect(r.subject_id).toBe(t.id);
    }
    const base = { key: t.key, contributionId: c.id, areaId: a.id };
    expect(rows.map((r) => r.payload)).toEqual([
      base,
      { ...base, fields: ["text", "status"], status: { from: "todo", to: "in_progress" } },
      { ...base, personId: personId("manager") },
      { ...base, personId: personId("manager") },
      { ...base, fields: ["status"], status: { from: "in_progress", to: "done" } },
      { ...base, fields: ["text"] },
      { ...base, areaName: "Dados", commentsKept: 0 },
    ]);
    expect(rows.map((r) => r.actor_person_id)).toEqual([personId("contributor"), personId("manager"), personId("contributor"), personId("contributor"), personId("contributor"), personId("contributor"), personId("manager")]);
    const all = JSON.stringify((await h.pool.query("select * from activity_events")).rows);
    expect(all).not.toContain("secreto");
  });
});

describe("a atividade", () => {
  it("cada entrada nova, com a área de hoje", async () => {
    const t = await add();
    const a = await area("Design");
    const c = await made(t.id, a.id, "contributor");
    await update(c.id, { text: "x" });
    await update(c.id, { status: "in_progress" });
    await put(c.id, personId("manager"));
    await unput(c.id, personId("manager"));
    await drop(c.id, "manager");
    await placeCEvents([1, 2, 3, 4, 5, 6]);
    await h.pool.query("update activity_events set occurred_at = $1 where kind = 'ticket.created' and subject_id = $2", [new Date(BASE), t.id]);
    const p = await feed(t.id);
    const types = p.entries.map((e) => e.type);
    expect(types).toEqual([
      "contribution_removed",
      "contribution_person_removed",
      "contribution_person_added",
      "contribution_status_changed",
      "contribution_text_changed",
      "contribution_added",
      "created",
    ]);
    const area0 = { id: a.id, name: "Design" };
    expect(p.entries[0]).toMatchObject({ area: area0, actor: { id: personId("manager") } });
    expect(p.entries[1]).toMatchObject({ area: area0, person: { id: personId("manager"), displayName: "Nome manager" } });
    expect(p.entries[3]).toMatchObject({ area: area0, from: "todo", to: "in_progress" });
    expect(p.entries[4]).toMatchObject({ area: area0, actor: { id: personId("contributor") } });
    expect(JSON.stringify(p)).not.toContain('"text":"x"');
  });

  it("área renomeada depois: entradas antigas mostram o nome de hoje; removida e área apagada: nome guardado", async () => {
    const t = await add();
    const a = await area("Antigo");
    const c = await made(t.id, a.id);
    await h.call("PATCH", `/api/areas/${a.id}`, as("admin"), { name: "Novo" });
    expect((await feed(t.id)).entries.find((e) => e.type === "contribution_added")).toMatchObject({ area: { id: a.id, name: "Novo" } });
    await drop(c.id);
    expect((await feed(t.id)).entries.find((e) => e.type === "contribution_removed")).toMatchObject({ area: { id: a.id, name: "Novo" } });
    await h.call("DELETE", `/api/areas/${a.id}`, as("admin"));
    const p = await feed(t.id);
    expect(p.entries.find((e) => e.type === "contribution_removed")).toMatchObject({ area: { id: a.id, name: "Novo" } });
    expect(p.entries.find((e) => e.type === "contribution_added")).toMatchObject({ area: null });
  });

  it("removida com o nome guardado no evento quando a área foi renomeada e apagada depois", async () => {
    const t = await add();
    const a = await area("Nome na remoção");
    const c = await made(t.id, a.id);
    await drop(c.id);
    await h.call("PATCH", `/api/areas/${a.id}`, as("admin"), { name: "Depois" });
    await h.call("DELETE", `/api/areas/${a.id}`, as("admin"));
    expect((await feed(t.id)).entries.find((e) => e.type === "contribution_removed")).toMatchObject({ area: { id: a.id, name: "Nome na remoção" } });
  });

  it("edições seguidas do texto da mesma contribuição pela mesma pessoa viram uma entrada; outra contribuição ou a descrição no meio não junta", async () => {
    const t = await add();
    const c1 = await made(t.id);
    const c2 = await made(t.id);
    await update(c1.id, { text: "a" });
    await update(c1.id, { text: "b" });
    await update(c2.id, { text: "c" });
    await update(c1.id, { text: "d" });
    await h.call("PATCH", `/api/tickets/${t.id}`, as("contributor"), { description: "desc" });
    await update(c1.id, { text: "e" });
    const all = await cEvents();
    const kinds = all.map((r) => `${r.kind}:${(r.payload as { contributionId: string }).contributionId === c1.id ? 1 : 2}`);
    expect(kinds).toEqual(["ticket.contribution_added:1", "ticket.contribution_added:2", ...Array(2).fill("ticket.contribution_updated:1"), "ticket.contribution_updated:2", "ticket.contribution_updated:1", "ticket.contribution_updated:1"]);
    const [, , a, b, c, d, e] = all;
    const desc = (await h.pool.query("select id from activity_events where subject_id = $1 and kind = 'ticket.updated' order by occurred_at desc, id desc limit 1", [t.id])).rows[0];
    const at = async (id: string, minutes: number) => h.pool.query("update activity_events set occurred_at = $1 where id = $2", [new Date(BASE + minutes * MIN), id]);
    await at(a.id, 1);
    await at(b.id, 3);
    await at(c.id, 4);
    await at(d.id, 5);
    await at(desc.id, 6);
    await at(e.id, 7);
    const texts = (await feed(t.id)).entries.filter((x) => x.type === "contribution_text_changed");
    // c1 a+b juntas; c2 sozinha; c1 d sozinha (c2 no meio); c1 e sozinha (a descrição no meio)
    expect(texts).toHaveLength(4);
    expect(texts.map((x) => (x["area"] as { id: string }).id)).toEqual([c1.area.id, c1.area.id, c2.area.id, c1.area.id]);
    expect(texts[3]?.id).toBe(`${a.id}:text`);
    expect(Date.parse(texts[3]?.occurredAt as string)).toBe(BASE + 3 * MIN);
  });

  it("a paginação dá o mesmo resultado para qualquer limit, com contribuições no meio", async () => {
    const t = await add();
    const cs: Contribution[] = [];
    for (let i = 0; i < 3; i++) cs.push(await made(t.id));
    for (let i = 0; i < 4; i++) {
      for (const c of cs) await update(c.id, { text: `v${i}` });
      await put((cs[0] as Contribution).id, i % 2 === 0 ? personId("manager") : personId("admin"));
      await update((cs[1] as Contribution).id, { status: i % 2 === 0 ? "in_progress" : "todo" });
    }
    const evs = await cEvents();
    await placeCEvents(evs.map((_, i) => 1 + Math.floor(i / 2) * 3));
    const whole = await feed(t.id, "?limit=100");
    expect(whole.before).toBeNull();
    expect(whole.entries.length).toBeGreaterThan(10);
    for (const limit of [1, 2, 3, 4, 5, 7]) {
      const seen: Entry[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const p: Page = await feed(t.id, `?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        expect(p.entries.length).toBeLessThanOrEqual(limit);
        seen.push(...p.entries);
        before = p.before;
        pages += 1;
      } while (before && pages < 80);
      expect(seen, `limit ${limit}`).toEqual(whole.entries);
    }
  });

  it("a quantidade de consultas da rota não cresce com as entradas de contribuição", async () => {
    const queriesOf = async (ticketId: string): Promise<{ queries: number; entries: number }> => {
      const prisma = createPrismaClient(APP_URL);
      try {
        return await withTenant(prisma, { orgId: "org_A", userId: "u_admin" }, async (tx) => {
          const ticket = await tx.ticket.findFirstOrThrow({ where: { id: ticketId } });
          const project = await tx.project.findFirstOrThrow({ where: { id: ticket.projectId } });
          let queries = 0;
          const counting = new Proxy(tx, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver) as unknown;
              if (prop === "$queryRaw" || prop === "$executeRaw") return (...args: unknown[]) => { queries += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
              if (typeof prop === "string" && !prop.startsWith("$") && typeof value === "object" && value !== null) {
                return new Proxy(value, {
                  get(model, method) {
                    const fn = Reflect.get(model, method) as unknown;
                    return typeof fn === "function" ? (...args: unknown[]) => { queries += 1; return (fn as (...a: unknown[]) => unknown).apply(model, args); } : fn;
                  },
                });
              }
              return value;
            },
          }) as TenantClient;
          const viewer = { personId: personId("manager"), actor: buildActor("member", [], [{ projectId: project.id, role: "manager" }]) };
          const result = await new TicketActivityService().read(counting, project, ticket, { limit: 30 }, viewer);
          return { queries, entries: result.entries.length };
        });
      } finally {
        await prisma.$disconnect();
      }
    };
    const t = await add();
    const c = await made(t.id);
    await put(c.id, personId("manager"));
    const few = await queriesOf(t.id);
    for (let i = 0; i < 6; i++) {
      const more = await made(t.id);
      await put(more.id, i % 2 === 0 ? personId("admin") : personId("manager"));
      await update(more.id, { status: "done" });
    }
    const many = await queriesOf(t.id);
    expect(many.entries).toBeGreaterThan(few.entries);
    expect(many.queries).toBe(few.queries);
    expect(many.queries).toBeLessThanOrEqual(5);
  });
});

describe("chave de ticket no texto não grava ligação", () => {
  it("nenhuma linha em ticket_relations, ao editar nem ao criar", async () => {
    const target = await add({ title: "Alvo" });
    const t = await add({ title: "Origem" });
    const c = await made(t.id);
    await update(c.id, { text: `Depende de ${target.key}, ${target.key.toLowerCase()} e ${t.key}.` });
    expect(await count("select count(*) from ticket_relations")).toBe(0);
    const detailOfTarget = await h.call("GET", `/api/tickets/${target.id}`, as("admin"));
    expect((detailOfTarget.body as { mentionedBy: unknown[] }).mentionedBy).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { APP_URL } from "@treepm/db/testing";
import { createPrismaClient, withTenant } from "@treepm/db";
import type { TenantClient } from "@treepm/db";
import { buildActor } from "../src/access/actor.js";
import { TicketActivityService } from "../src/tickets/ticket-activity.service.js";
import { AI_CONFIG, sessionHeader } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0041, fatia 2: comentários por área. Contextual, não privado: quem vê o ticket vê todos os comentários.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
type Body = Record<string, unknown>;
type Reader = Who | "outsider";
type Person = { id: string; displayName: string; avatarUrl: string | null };
type AreaRef = { id: string | null; name: string } | null;
type Entry = { id: string; type: string; occurredAt: string; actor: Person | null; area?: AreaRef; body?: string | null; [k: string]: unknown };
type Page = { entries: Entry[]; before: string | null; canComment: boolean };
type Contribution = { id: string; area: { id: string; name: string }; commentCount: number; [k: string]: unknown };

const personId = (who: Who) => h.world().people[who];
const add = async (body: Body = {}): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
let areaCounter = 0;
const made = async (ticketId: string, name = `Área ${++areaCounter}`): Promise<Contribution> => {
  const a = await h.call("POST", "/api/areas", as("admin"), { name });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const res = await h.call("POST", `/api/tickets/${ticketId}/contributions`, as("contributor"), { areaId: (a.body as { id: string }).id });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Contribution;
};
const post = (ticketId: string, body: unknown, who: Reader = "contributor", org = "org_A") => h.call("POST", `/api/tickets/${ticketId}/comments`, as(who, org), body);
const say = async (ticketId: string, text: string, contributionId?: string, who: Who = "contributor"): Promise<Entry> => {
  const res = await post(ticketId, contributionId ? { body: text, contributionId } : { body: text }, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Entry;
};
const edit = (id: string, body: unknown, who: Reader = "contributor") => h.call("PATCH", `/api/comments/${id}`, as(who), body);
const remove = (id: string, who: Reader = "contributor") => h.call("DELETE", `/api/comments/${id}`, as(who));
const dropContribution = (id: string, who: Reader = "contributor") => h.call("DELETE", `/api/contributions/${id}`, as(who));
const feed = (id: string, query = "", who: Reader = "admin", org = "org_A") => h.call("GET", `/api/tickets/${id}/activity${query}`, as(who, org));
const page = async (id: string, query = "", who: Reader = "admin"): Promise<Page> => {
  const res = await feed(id, query, who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
};
const detail = async (id: string, who: Reader = "admin") => {
  const res = await h.call("GET", `/api/tickets/${id}`, as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { contributions: Contribution[] };
};
const row = async (id: string) => (await h.pool.query("select * from ticket_comments where id = $1", [id])).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await h.pool.query(sql, params)).rows[0].count);
const kindEvents = async (like: string) => (await h.pool.query("select * from activity_events where kind like $1 order by occurred_at, id", [like])).rows;

describe("comentar numa área: POST tickets/:id/comments com contributionId", () => {
  it("gestor, colaborador e administrador comentam; a entrada traz area { id da contribuição, nome da área }", async () => {
    const t = await add();
    const c = await made(t.id, "Segurança");
    for (const who of ["manager", "contributor", "admin"] as Who[]) {
      const res = await post(t.id, { body: `de ${who}`, contributionId: c.id }, who);
      expect(res.status, who).toBe(201);
      const entry = res.body as Entry;
      expect(entry).toMatchObject({ type: "comment", body: `de ${who}`, area: { id: c.id, name: "Segurança" }, canEdit: true, canRemove: true });
      expect(await row(entry.id)).toMatchObject({ contribution_id: c.id, ticket_id: t.id, area_name: null });
    }
  });

  it("comentário do ticket (sem contributionId) tem area nula", async () => {
    const t = await add();
    expect(await say(t.id, "do ticket")).toMatchObject({ area: null });
  });

  it("leitor recebe 403; sem acesso ao projeto, 404; sem gravar", async () => {
    const t = await add();
    const c = await made(t.id);
    expect((await post(t.id, { body: "x", contributionId: c.id }, "reader")).status).toBe(403);
    expect((await post(t.id, { body: "x", contributionId: c.id }, "plain")).status).toBe(404);
    expect(await count("select count(*) from ticket_comments")).toBe(0);
  });

  it("contribuição de outro ticket, inexistente ou de outra organização: o mesmo 404, sem gravar", async () => {
    const t1 = await add();
    const t2 = await add();
    const other = await made(t2.id);
    const unknown = await post(t1.id, { body: "x", contributionId: UNKNOWN_ID });
    const wrongTicket = await post(t1.id, { body: "x", contributionId: other.id });
    expect([unknown.status, wrongTicket.status]).toEqual([404, 404]);
    expect(unknown.body).toEqual(wrongTicket.body);
    // de outra organização: um ticket de org_B comentado com a contribuição de org_A
    await h.pool.query("insert into projects (org_id, name, key, visibility) values ('org_B', 'PB', 'PB', 'organization') on conflict do nothing");
    const pb = (await h.pool.query("select id from projects where org_id = 'org_B' and key = 'PB'")).rows[0].id;
    const person = (await h.pool.query("select id from people where org_id = 'org_B' limit 1")).rows[0].id;
    {
      const tb = (await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_B', $1, 1, 'B', $2) returning id", [pb, person])).rows[0].id;
      const cross = await h.call("POST", `/api/tickets/${tb}/comments`, sessionHeader({ userId: "u_outsider", orgId: "org_B", orgRole: "org:admin" }), { body: "x", contributionId: other.id });
      expect(cross.status).toBe(404);
    }
    expect(await count("select count(*) from ticket_comments")).toBe(0);
  });

  it("contributionId inválido: 400", async () => {
    const t = await add();
    for (const bad of ["x", 7, null, ""]) expect((await post(t.id, { body: "x", contributionId: bad })).status, String(bad)).toBe(400);
  });

  it("projeto arquivado recusa; o evento leva o id da contribuição e nunca o corpo", async () => {
    const t = await add();
    const c = await made(t.id);
    const entry = await say(t.id, "segredo-de-area-XYZ", c.id);
    await edit(entry.id, { body: "segredo-de-area-editado" });
    await remove(entry.id);
    const rows = await kindEvents("ticket.comment_%");
    expect(rows.map((r) => r.payload)).toEqual([
      { key: t.key, commentId: entry.id, contributionId: c.id },
      { key: t.key, commentId: entry.id, contributionId: c.id },
      { key: t.key, commentId: entry.id, contributionId: c.id },
    ]);
    expect(JSON.stringify((await h.pool.query("select * from activity_events")).rows)).not.toContain("segredo-de-area");
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await post(t.id, { body: "x", contributionId: c.id }, "manager")).status).toBe(409);
  });

  it("editar e remover não mudam: a resposta de editar traz a mesma area", async () => {
    const t = await add();
    const c = await made(t.id, "Dados");
    const entry = await say(t.id, "um", c.id);
    const edited = await edit(entry.id, { body: "dois" });
    expect(edited.status).toBe(200);
    expect((edited.body as Entry).area).toEqual({ id: c.id, name: "Dados" });
    expect((await remove(entry.id)).status).toBe(204);
    const p = await page(t.id);
    expect(p.entries.find((e) => e.id === entry.id)).toMatchObject({ removed: true, body: null, area: { id: c.id, name: "Dados" } });
  });
});

describe("a atividade mostra a área de cada comentário", () => {
  it("viva, removida (nome guardado) e sem área", async () => {
    const t = await add();
    const live = await made(t.id, "Viva");
    const gone = await made(t.id, "Será removida");
    const a = await say(t.id, "na viva", live.id);
    const b = await say(t.id, "na que sairá", gone.id);
    const c = await say(t.id, "do ticket");
    expect((await dropContribution(gone.id)).status).toBe(204);
    const p = await page(t.id);
    const by = (id: string) => p.entries.find((e) => e.id === id);
    expect(by(a.id)).toMatchObject({ body: "na viva", area: { id: live.id, name: "Viva" } });
    expect(by(b.id)).toMatchObject({ body: "na que sairá", area: { id: null, name: "Será removida" } });
    expect(by(c.id)).toMatchObject({ body: "do ticket", area: null });
    expect(await row(b.id)).toMatchObject({ contribution_id: null, area_name: "Será removida" });
  });

  it("renomear a área muda o nome mostrado nos comentários vivos", async () => {
    const t = await add();
    const c = await made(t.id, "Antes");
    const entry = await say(t.id, "x", c.id);
    await h.pool.query("update areas set name = 'Depois' where id = $1", [c.area.id]);
    expect((await page(t.id)).entries.find((e) => e.id === entry.id)).toMatchObject({ area: { id: c.id, name: "Depois" } });
  });

  it("a rota continua devolvendo todos os comentários, do ticket e das áreas, em ordem de tempo", async () => {
    const t = await add();
    const c = await made(t.id);
    const one = await say(t.id, "1");
    const two = await say(t.id, "2", c.id);
    const three = await say(t.id, "3");
    const ids = (await page(t.id)).entries.filter((e) => e.type === "comment").map((e) => e.id);
    expect(ids).toEqual([three.id, two.id, one.id]);
  });
});

describe("GET tickets/:id/activity?contribution=<id>", () => {
  it("devolve só os comentários daquela contribuição, sem mudanças, no mesmo formato", async () => {
    const t = await add();
    const c1 = await made(t.id);
    const c2 = await made(t.id);
    await say(t.id, "do ticket");
    const a = await say(t.id, "a", c1.id);
    await say(t.id, "de outra", c2.id);
    const b = await say(t.id, "b", c1.id);
    const p = await page(t.id, `?contribution=${c1.id}`);
    expect(p.entries.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(p.entries.every((e) => e.type === "comment")).toBe(true);
    expect(p.entries[0]).toMatchObject({ body: "b", area: { id: c1.id, name: c1.area.name }, canEdit: false, canRemove: true });
    expect(p.before).toBeNull();
    expect(p.canComment).toBe(true);
  });

  it("não inventa a entrada created nem em ticket sem evento de criação", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets/import`, as("manager"), { items: [{ title: "Importado" }] });
    const id = (res.body as { id: string }[])[0]?.id as string;
    const c = await made(id);
    await say(id, "um", c.id);
    expect((await page(id, `?contribution=${c.id}`)).entries.map((e) => e.type)).toEqual(["comment"]);
  });

  it("pagina com o mesmo resultado para qualquer limit", async () => {
    const t = await add();
    const c = await made(t.id);
    for (let i = 0; i < 7; i++) await say(t.id, `c${i}`, c.id);
    const whole = await page(t.id, `?contribution=${c.id}&limit=100`);
    expect(whole.entries).toHaveLength(7);
    for (const limit of [1, 2, 3, 7]) {
      const seen: Entry[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const p: Page = await page(t.id, `?contribution=${c.id}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        expect(p.entries.length).toBeLessThanOrEqual(limit);
        seen.push(...p.entries);
        before = p.before;
        pages += 1;
      } while (before && pages < 30);
      expect(seen, `limit ${limit}`).toEqual(whole.entries);
    }
  });

  it("contribuição de outro ticket, inexistente ou de outra organização: 404; sem acesso ao ticket: 404; inválida: 400", async () => {
    const t1 = await add();
    const t2 = await add();
    const other = await made(t2.id);
    expect((await feed(t1.id, `?contribution=${other.id}`)).status).toBe(404);
    expect((await feed(t1.id, `?contribution=${UNKNOWN_ID}`)).status).toBe(404);
    expect((await feed(t2.id, `?contribution=${other.id}`, "outsider", "org_B")).status).toBe(404);
    expect((await feed(t2.id, `?contribution=${other.id}`, "plain")).status).toBe(404);
    expect((await feed(t1.id, "?contribution=abc")).status).toBe(400);
  });

  it("o leitor lê; projeto arquivado lê sem ações", async () => {
    const t = await add();
    const c = await made(t.id);
    await say(t.id, "lido", c.id);
    const asReader = await page(t.id, `?contribution=${c.id}`, "reader");
    expect(asReader.canComment).toBe(false); // ADR 0040, adendo: o leitor comenta no ticket, não na área
    expect(asReader.entries[0]).toMatchObject({ body: "lido", canEdit: false, canRemove: false });
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await page(t.id, `?contribution=${c.id}`, "manager")).entries[0]).toMatchObject({ canEdit: false, canRemove: false });
  });
});

describe("commentCount no detalhe do ticket", () => {
  it("conta os comentários vivos de cada contribuição, e remover um comentário desconta", async () => {
    const t = await add();
    const c1 = await made(t.id);
    const c2 = await made(t.id);
    const c3 = await made(t.id);
    await say(t.id, "x", c1.id);
    const gone = await say(t.id, "y", c1.id);
    await say(t.id, "z", c2.id);
    await say(t.id, "do ticket");
    await remove(gone.id);
    const counts = Object.fromEntries((await detail(t.id)).contributions.map((c) => [c.id, c.commentCount]));
    expect(counts).toEqual({ [c1.id]: 1, [c2.id]: 1, [c3.id]: 0 });
  });

  it("a contribuição recém-criada e as respostas das contribuições trazem commentCount", async () => {
    const t = await add();
    const c = await made(t.id);
    expect(c.commentCount).toBe(0);
    await say(t.id, "x", c.id);
    const res = await h.call("PATCH", `/api/contributions/${c.id}`, as("contributor"), { text: "t" });
    expect((res.body as Contribution).commentCount).toBe(1);
  });
});

describe("remover a contribuição com comentários", () => {
  it("os comentários ficam no ticket, sem área, com o nome guardado; o evento guarda só o número", async () => {
    const t = await add();
    const c = await made(t.id, "Infra");
    const removedOne = await say(t.id, "vai sumir", c.id);
    await say(t.id, "fica 1", c.id);
    await say(t.id, "fica 2", c.id, "manager");
    await remove(removedOne.id);
    expect((await dropContribution(c.id)).status).toBe(204);
    expect(await count("select count(*) from ticket_comments where ticket_id = $1", [t.id])).toBe(3);
    expect(await count("select count(*) from ticket_comments where contribution_id is not null")).toBe(0);
    expect(await count("select count(*) from ticket_comments where area_name = 'Infra'")).toBe(3);
    const [ev] = await kindEvents("ticket.contribution_removed");
    expect(ev.payload).toMatchObject({ contributionId: c.id, areaName: "Infra", commentsKept: 2 });
    expect(JSON.stringify(ev.payload)).not.toContain("fica");
    const p = await page(t.id);
    expect(p.entries.filter((e) => e.type === "comment").map((e) => e.area)).toEqual([
      { id: null, name: "Infra" },
      { id: null, name: "Infra" },
      { id: null, name: "Infra" },
    ]);
  });

  it("sem comentários, commentsKept é 0; recriar a área dá uma contribuição nova sem os comentários antigos", async () => {
    const t = await add();
    const c = await made(t.id, "Zero");
    expect((await dropContribution(c.id)).status).toBe(204);
    expect((await kindEvents("ticket.contribution_removed"))[0].payload).toMatchObject({ commentsKept: 0 });
    const again = await h.call("POST", `/api/tickets/${t.id}/contributions`, as("contributor"), { areaId: c.area.id });
    expect((again.body as Contribution).commentCount).toBe(0);
  });

  it("excluir o ticket exclui contribuições e comentários", async () => {
    const t = await add();
    const c = await made(t.id);
    await say(t.id, "x", c.id);
    expect((await h.call("DELETE", `/api/tickets/${t.id}`, as("manager"))).status).toBe(204);
    expect(await count("select count(*) from ticket_comments")).toBe(0);
  });
});

describe("custo da leitura com comentários de área", () => {
  const queriesOf = async (ticketId: string, contribution?: string): Promise<number> => {
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
        await new TicketActivityService().read(counting, project, ticket, { limit: 30, ...(contribution ? { contribution } : {}) }, viewer);
        return queries;
      });
    } finally {
      await prisma.$disconnect();
    }
  };

  it("a atividade não faz mais consultas com mais áreas e comentários de área", async () => {
    const t = await add();
    const first = await made(t.id);
    await say(t.id, "um", first.id);
    const few = await queriesOf(t.id);
    for (let i = 0; i < 5; i++) {
      const c = await made(t.id);
      await say(t.id, `a${i}`, c.id);
      await say(t.id, `b${i}`, c.id, "manager");
    }
    const many = await queriesOf(t.id);
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(4);
  });

  it("o filtro por contribuição também tem número fixo de consultas", async () => {
    const t = await add();
    const c = await made(t.id);
    await say(t.id, "um", c.id);
    const few = await queriesOf(t.id, c.id);
    for (let i = 0; i < 12; i++) await say(t.id, `m${i}`, c.id);
    const many = await queriesOf(t.id, c.id);
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(3);
  });

  it("o detalhe do ticket não faz mais consultas com mais contribuições", async () => {
    const t = await add();
    await made(t.id);
    const prisma = createPrismaClient(APP_URL);
    const measure = async () =>
      withTenant(prisma, { orgId: "org_A", userId: "u_admin" }, async (tx) => {
        let queries = 0;
        const counting = new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
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
        const { readContributions } = await import("../src/tickets/ticket-contributions.read.js");
        await readContributions(counting, t.id);
        return queries;
      });
    try {
      const few = await measure();
      for (let i = 0; i < 6; i++) await say(t.id, `c${i}`, (await made(t.id)).id);
      expect(await measure()).toBe(few);
    } finally {
      await prisma.$disconnect();
    }
  });
});

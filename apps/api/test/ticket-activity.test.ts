import { describe, expect, it } from "vitest";
import { APP_URL } from "@treepm/db/testing";
import { createPrismaClient, withTenant } from "@treepm/db";
import type { TenantClient } from "@treepm/db";
import { TicketActivityService } from "../src/tickets/ticket-activity.service.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0040, fatia 1: GET tickets/:id/activity devolve o histórico já resolvido, da entrada mais recente para a mais antiga.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
type Body = Record<string, unknown>;
type Person = { id: string; displayName: string; avatarUrl: string | null };
type Entry = { id: string; type: string; occurredAt: string; actor: Person | null; [k: string]: unknown };
type Page = { entries: Entry[]; before: string | null };
const MIN = 60_000;

const add = async (body: Body = {}, project = priv(), who: Who = "admin"): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${project}/tickets`, as(who), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
const patch = async (id: string, body: Body, who: Who = "admin") => {
  const res = await h.call("PATCH", `/api/tickets/${id}`, as(who), body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
const feed = (id: string, query = "", who: Who | "outsider" = "admin", org = "org_A") => h.call("GET", `/api/tickets/${id}/activity${query}`, as(who, org));
const page = async (id: string, query = "", who: Who | "outsider" = "admin"): Promise<Page> => {
  const res = await feed(id, query, who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
};
const types = (p: Page) => p.entries.map((e) => e.type);
const find = (p: Page, type: string): Entry => {
  const entry = p.entries.find((e) => e.type === type);
  expect(entry, `entrada ${type}`).toBeDefined();
  return entry as Entry;
};
const personId = (who: Who) => h.world().people[who];
const count = async (sql: string) => Number((await h.pool.query(sql)).rows[0].count);
const events = async (id: string) => (await h.pool.query("select * from activity_events where subject_id = $1 order by occurred_at, id", [id])).rows;
/** Põe todos os eventos do ticket em instantes conhecidos: `minutes[i]` para o i-ésimo na ordem de gravação. */
const place = async (id: string, minutes: number[]): Promise<void> => {
  const rows = await events(id);
  const base = Date.parse("2026-11-01T12:00:00Z");
  for (const [i, row] of rows.entries()) {
    await h.pool.query("update activity_events set occurred_at = $1 where id = $2", [new Date(base + (minutes[i] ?? 0) * MIN), row.id]);
  }
};
const insertEvent = (id: string, kind: string, payload: unknown, actor: string | null = personId("admin")) =>
  h.pool.query("insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id, payload) values ('org_A', $1, $2, 'ticket', $3, $4)", [actor, kind, id, JSON.stringify(payload)]);

describe("cada tipo de entrada, provocado pela rota", () => {
  it("created: quem criou, sem dados", async () => {
    const t = await add({}, priv(), "manager");
    const p = await page(t.id);
    expect(p.before).toBeNull();
    expect(p.entries).toHaveLength(1);
    const created = p.entries[0] as Entry;
    expect(created).toMatchObject({ type: "created", actor: { id: personId("manager"), displayName: "Nome manager" } });
    expect(typeof created.occurredAt).toBe("string");
    expect(Object.keys(created).sort()).toEqual(["actor", "id", "occurredAt", "type"]);
  });

  it("title_changed e description_changed", async () => {
    const t = await add({ title: "Antes" });
    await patch(t.id, { title: "Depois" });
    await patch(t.id, { description: "texto novo" });
    const p = await page(t.id);
    expect(types(p)).toEqual(["description_changed", "title_changed", "created"]);
    expect(find(p, "title_changed")).toMatchObject({ from: "Antes", to: "Depois" });
    expect(Object.keys(find(p, "description_changed")).sort()).toEqual(["actor", "id", "occurredAt", "type"]);
  });

  it("status_changed manual: de, para, sem automático nem causa", async () => {
    const t = await add();
    await patch(t.id, { status: "in_progress" });
    const e = find(await page(t.id), "status_changed");
    expect(e).toMatchObject({ from: "todo", to: "in_progress", automatic: false, causedBy: null });
  });

  it("status_changed automático: causedBy resolve a chave para o ticket de hoje", async () => {
    const parent = await add({ title: "Pai" });
    await patch(parent.id, { status: "done" });
    const kid = await add({ title: "Filho", parentId: parent.id });
    const e = find(await page(parent.id), "status_changed");
    expect(e).toMatchObject({ from: "done", to: "todo", automatic: true, causedBy: { id: kid.id, key: kid.key, title: "Filho" } });
    const manual = (await page(parent.id)).entries.filter((x) => x.type === "status_changed");
    expect(manual).toHaveLength(2);
  });

  it("status_changed automático: causa que não existe mais vira referência sem id, com a chave", async () => {
    const parent = await add({ title: "Pai" });
    await patch(parent.id, { status: "done" });
    const kid = await add({ parentId: parent.id });
    await h.call("DELETE", `/api/tickets/${kid.id}`, as("admin"));
    const auto = (await page(parent.id)).entries.find((x) => x.type === "status_changed" && x.automatic === true) as Entry;
    expect(auto.causedBy).toEqual({ id: null, key: kid.key, title: null });
  });

  it("parent_changed: o pai de antes e o de depois, e sem pai", async () => {
    const a = await add({ title: "A" });
    const b = await add({ title: "B" });
    const t = await add({ title: "T" });
    await patch(t.id, { parentId: a.id });
    await patch(t.id, { parentId: b.id });
    await patch(t.id, { parentId: null });
    const entries = (await page(t.id)).entries.filter((e) => e.type === "parent_changed");
    expect(entries.map((e) => [e.from, e.to])).toEqual([
      [{ id: b.id, key: b.key, title: "B" }, null],
      [{ id: a.id, key: a.key, title: "A" }, { id: b.id, key: b.key, title: "B" }],
      [null, { id: a.id, key: a.key, title: "A" }],
    ]);
  });

  it("parent_changed: pai removido depois vira referência sem id (a chave não foi guardada)", async () => {
    const a = await add({ title: "A" });
    const t = await add({});
    await patch(t.id, { parentId: a.id });
    await patch(t.id, { parentId: null });
    await h.call("DELETE", `/api/tickets/${a.id}`, as("admin"));
    const entries = (await page(t.id)).entries.filter((e) => e.type === "parent_changed");
    expect(entries.map((e) => [e.from, e.to])).toEqual([
      [{ id: null, key: null, title: null }, null],
      [null, { id: null, key: null, title: null }],
    ]);
  });

  it("assignee_added e assignee_removed", async () => {
    const t = await add();
    await h.call("PUT", `/api/tickets/${t.id}/assignees/${personId("contributor")}`, as("admin"));
    await h.call("DELETE", `/api/tickets/${t.id}/assignees/${personId("contributor")}`, as("admin"));
    const p = await page(t.id);
    expect(types(p)).toEqual(["assignee_removed", "assignee_added", "created"]);
    const expected = { id: personId("contributor"), displayName: "Nome contributor", avatarUrl: null };
    expect(find(p, "assignee_added").person).toEqual(expected);
    expect(find(p, "assignee_removed").person).toEqual(expected);
  });

  it("assignee: pessoa inativa aparece pelo nome; pessoa que não existe mais vira null", async () => {
    const t = await add();
    await h.call("PUT", `/api/tickets/${t.id}/assignees/${personId("contributor")}`, as("admin"));
    await h.pool.query("update people set active = false where id = $1", [personId("contributor")]);
    expect(find(await page(t.id), "assignee_added").person).toMatchObject({ displayName: "Nome contributor" });
    await insertEvent(t.id, "ticket.assignee_added", { personId: UNKNOWN_ID });
    const people = (await page(t.id)).entries.filter((e) => e.type === "assignee_added").map((e) => e.person);
    expect(people).toContainEqual(null);
  });

  it("actor: pessoa inativa continua com nome; sem pessoa vira null", async () => {
    const t = await add({}, priv(), "manager");
    await h.pool.query("update people set active = false where id = $1", [personId("manager")]);
    expect((await page(t.id)).entries[0]?.actor).toMatchObject({ displayName: "Nome manager" });
    await insertEvent(t.id, "ticket.updated", { fields: ["title"], title: { from: "a", to: "b" } }, null);
    expect(find(await page(t.id), "title_changed").actor).toBeNull();
  });

  it("dependency_added e dependency_removed, e o outro ticket removido depois", async () => {
    const t = await add({});
    const other = await add({ title: "Outro" });
    const gone = await add({ title: "Some" });
    await h.call("POST", `/api/tickets/${t.id}/dependencies`, as("admin"), { ticketId: other.id });
    await h.call("POST", `/api/tickets/${t.id}/dependencies`, as("admin"), { ticketId: gone.id });
    await h.call("DELETE", `/api/tickets/${t.id}/dependencies/${other.id}`, as("admin"));
    await h.call("DELETE", `/api/tickets/${t.id}/dependencies/${gone.id}`, as("admin"));
    await h.call("DELETE", `/api/tickets/${gone.id}`, as("admin"));
    const p = await page(t.id);
    expect(types(p)).toEqual(["dependency_removed", "dependency_removed", "dependency_added", "dependency_added", "created"]);
    const refs = p.entries.filter((e) => e.type === "dependency_added").map((e) => e.ticket);
    expect(refs).toEqual([
      { id: null, key: gone.key, title: null },
      { id: other.id, key: other.key, title: "Outro" },
    ]);
  });

  it("summary_updated: a origem", async () => {
    const parent = await add({ title: "Pai" });
    await add({ parentId: parent.id });
    const res = await h.call("PUT", `/api/tickets/${parent.id}/summary`, as("admin"), { text: "Resumo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(find(await page(parent.id), "summary_updated")).toMatchObject({ source: "person", actor: { id: personId("admin") } });
  });

  it("um ticket.updated com vários campos vira uma entrada por campo, na ordem fixa, com o mesmo autor e instante", async () => {
    const parent = await add({ title: "P" });
    const t = await add({ title: "Antes" });
    await patch(t.id, { parentId: parent.id, status: "in_review", description: "d", title: "Depois" });
    const p = await page(t.id);
    expect(types(p)).toEqual(["parent_changed", "status_changed", "description_changed", "title_changed", "created"]);
    const four = p.entries.slice(0, 4);
    expect(new Set(four.map((e) => e.occurredAt)).size).toBe(1);
    expect(new Set(four.map((e) => e.actor?.id)).size).toBe(1);
    expect(new Set(p.entries.map((e) => e.id)).size).toBe(p.entries.length);
    const again = await page(t.id);
    expect(again.entries.map((e) => e.id)).toEqual(p.entries.map((e) => e.id));
  });
});

describe("ticket sem evento de criação, e eventos que não valem", () => {
  it("importado: a entrada created sai do próprio ticket e é a mais antiga", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets/import`, as("manager"), { items: [{ title: "Importado" }] });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }[])[0]?.id as string;
    await patch(id, { title: "Renomeado" });
    const p = await page(id);
    expect(types(p)).toEqual(["title_changed", "created"]);
    const created = p.entries[1] as Entry;
    expect(created.actor).toMatchObject({ id: personId("manager") });
    const row = (await h.pool.query("select created_at from tickets where id = $1", [id])).rows[0];
    expect(Date.parse(created.occurredAt)).toBe(row.created_at.getTime());
    expect(created.id).toBe(`created:${id}`);
  });

  it("tipo desconhecido, ticket.comment_* e payload fora do esperado são ignorados", async () => {
    const t = await add();
    await insertEvent(t.id, "ticket.something_new", { a: 1 });
    await insertEvent(t.id, "ticket.comment_created", { commentId: UNKNOWN_ID });
    await insertEvent(t.id, "ticket.updated", "isto não é objeto");
    await insertEvent(t.id, "ticket.updated", { fields: ["status"], status: { from: "x", to: "y" } });
    await insertEvent(t.id, "ticket.updated", { fields: ["title"], title: { from: 1, to: 2 } });
    await insertEvent(t.id, "ticket.updated", { fields: ["parentId"], parentId: { from: "não-uuid", to: null } });
    await insertEvent(t.id, "ticket.assignee_added", { personId: "não-uuid" });
    await insertEvent(t.id, "ticket.dependency_added", {});
    await insertEvent(t.id, "ticket.summary_updated", { source: 7 });
    await insertEvent(t.id, "ticket.updated", { fields: ["status"], status: { from: "todo", to: "done" }, automatic: true, causedBy: 12 });
    const res = await feed(t.id);
    expect(res.status).toBe(200);
    expect(types(res.body as Page)).toEqual(["created"]);
  });

  it("campo desconhecido dentro de um ticket.updated é ignorado e os outros ficam", async () => {
    const t = await add({ title: "A" });
    await insertEvent(t.id, "ticket.updated", { fields: ["title", "colour"], title: { from: "A", to: "B" }, colour: { from: 1, to: 2 } });
    expect(types(await page(t.id))).toEqual(["title_changed", "created"]);
  });

  it("eventos de outro ticket e de outro assunto não aparecem", async () => {
    const t = await add({ title: "Um" });
    const o = await add({ title: "Dois" });
    await patch(o.id, { title: "Dois!" });
    await insertEvent(t.id, "ticket.updated", { fields: ["title"], title: { from: "x", to: "y" } });
    await h.pool.query("update activity_events set subject_type = 'project' where subject_id = $1 and kind = 'ticket.updated'", [t.id]);
    expect(types(await page(t.id))).toEqual(["created"]);
    expect(types(await page(o.id))).toEqual(["title_changed", "created"]);
  });
});

describe("edições seguidas da descrição", () => {
  const edits = async (minutes: number[], who: Who = "admin") => {
    const t = await add({});
    for (const i of minutes.keys()) await patch(t.id, { description: `v${i}` }, who);
    await place(t.id, [0, ...minutes.map((m) => m + 1)]);
    return t;
  };

  it("viram uma entrada, com o instante da última e o id da primeira", async () => {
    const t = await edits([0, 4, 8]);
    const rows = await events(t.id);
    const p = await page(t.id);
    expect(types(p)).toEqual(["description_changed", "created"]);
    expect(Date.parse(p.entries[0]?.occurredAt as string)).toBe(Date.parse("2026-11-01T12:09:00Z"));
    expect(p.entries[0]?.id).toBe(`${rows[1].id}:description`);
  });

  it("outra pessoa, ou a diferença de dez minutos exatos, não junta", async () => {
    const t = await add({});
    await patch(t.id, { description: "a" }, "admin");
    await patch(t.id, { description: "b" }, "manager");
    await patch(t.id, { description: "c" }, "manager");
    await place(t.id, [0, 1, 2, 12]);
    expect(types(await page(t.id))).toEqual(["description_changed", "description_changed", "description_changed", "created"]);
  });

  it("outra entrada no meio desfaz a sequência", async () => {
    const t = await add({});
    await patch(t.id, { description: "a" });
    await patch(t.id, { title: "novo" });
    await patch(t.id, { description: "b" });
    await place(t.id, [0, 1, 2, 3]);
    expect(types(await page(t.id))).toEqual(["description_changed", "title_changed", "description_changed", "created"]);
  });

  it("a junção não depende de onde a página corta", async () => {
    const t = await add({});
    for (let i = 0; i < 12; i++) await patch(t.id, { description: `v${i}` });
    await patch(t.id, { status: "in_progress" });
    for (let i = 0; i < 5; i++) await patch(t.id, { description: `w${i}` });
    await place(t.id, [0, ...Array.from({ length: 12 }, (_, i) => 1 + i * 3), 40, ...Array.from({ length: 5 }, (_, i) => 41 + i * 2)]);
    const whole = await page(t.id, "?limit=100");
    expect(types(whole)).toEqual(["description_changed", "status_changed", "description_changed", "created"]);
    for (const limit of [1, 2, 3]) {
      const seen: Entry[] = [];
      let before: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const p: Page = await page(t.id, `?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        seen.push(...p.entries);
        before = p.before;
        if (!before) break;
      }
      expect(seen, `limit ${limit}`).toEqual(whole.entries);
    }
  });
});

describe("paginação", () => {
  const busy = async (n: number) => {
    const t = await add({});
    for (let i = 0; i < n; i++) await patch(t.id, { title: `T${i}` });
    return t;
  };

  it("página a página, até o fim, sem repetir nem perder entrada, também com instantes iguais", async () => {
    const t = await busy(7);
    await h.pool.query("update activity_events set occurred_at = '2026-11-01T12:00:00Z' where subject_id = $1", [t.id]);
    const whole = await page(t.id, "?limit=100");
    expect(whole.entries).toHaveLength(8);
    expect(whole.before).toBeNull();
    for (const limit of [1, 2, 3, 7, 8]) {
      const seen: Entry[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const p: Page = await page(t.id, `?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        expect(p.entries.length).toBeLessThanOrEqual(limit);
        expect(p.entries.length).toBeGreaterThan(0);
        seen.push(...p.entries);
        before = p.before;
        pages += 1;
      } while (before && pages < 20);
      expect(seen.map((e) => e.id), `limit ${limit}`).toEqual(whole.entries.map((e) => e.id));
      expect(pages).toBe(Math.ceil(8 / limit));
    }
  });

  it("vários campos de um evento atravessam o corte sem se perder", async () => {
    const parent = await add({ title: "P" });
    const t = await add({ title: "A" });
    await patch(t.id, { parentId: parent.id, status: "done", description: "d", title: "B" });
    const whole = await page(t.id, "?limit=100");
    expect(whole.entries).toHaveLength(5);
    const first = await page(t.id, "?limit=2");
    const second = await page(t.id, `?limit=2&before=${encodeURIComponent(first.before as string)}`);
    const third = await page(t.id, `?limit=2&before=${encodeURIComponent(second.before as string)}`);
    expect([...first.entries, ...second.entries, ...third.entries].map((e) => e.id)).toEqual(whole.entries.map((e) => e.id));
    expect(third.before).toBeNull();
  });

  it("padrão de 30, teto de 100, e limit inválido é recusado", async () => {
    const t = await busy(104);
    expect((await page(t.id)).entries).toHaveLength(30);
    expect((await page(t.id, "?limit=100")).entries).toHaveLength(100);
    expect((await page(t.id, "?limit=100")).before).not.toBeNull();
    for (const bad of ["?limit=101", "?limit=0", "?limit=-1", "?limit=x", "?limit=1.5"]) {
      expect((await feed(t.id, bad)).status, bad).toBe(400);
    }
  });

  it("cursor inválido é 400", async () => {
    const t = await add();
    for (const bad of ["?before=", "?before=lixo", `?before=${Buffer.from("{}").toString("base64url")}`]) {
      expect((await feed(t.id, bad)).status, bad).toBe(400);
    }
  });

  it("o ticket importado fecha a lista com created na última página", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets/import`, as("admin"), { items: [{ title: "I" }] });
    const id = (res.body as { id: string }[])[0]?.id as string;
    await patch(id, { title: "I2" });
    await patch(id, { title: "I3" });
    const first = await page(id, "?limit=2");
    expect(types(first)).toEqual(["title_changed", "title_changed"]);
    expect(first.before).not.toBeNull();
    const second = await page(id, `?limit=2&before=${encodeURIComponent(first.before as string)}`);
    expect(types(second)).toEqual(["created"]);
    expect(second.before).toBeNull();
  });
});

describe("permissão, isolamento e leitura pura", () => {
  it("leitor, gestor e quem só enxerga o projeto da organização leem", async () => {
    const t = await add({ title: "X" });
    for (const who of ["reader", "contributor", "manager", "admin"] as Who[]) expect((await feed(t.id, "", who)).status, who).toBe(200);
    const open = await add({}, h.world().projects.org);
    expect((await feed(open.id, "", "plain")).status).toBe(200);
  });

  it("sem acesso ao projeto privado, inexistente e de outra organização: o mesmo 404", async () => {
    const t = await add();
    const denied = await feed(t.id, "", "plain");
    const unknown = await feed(UNKNOWN_ID, "");
    const other = await feed(t.id, "", "outsider", "org_B");
    expect(denied.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(other.status).toBe(404);
    expect(denied.body).toEqual(unknown.body);
    expect(other.body).toEqual(unknown.body);
  });

  it("id inválido é 400; sem sessão é 401", async () => {
    expect((await feed("nao-e-uuid")).status).toBe(400);
    const res = await h.call("GET", `/api/tickets/${UNKNOWN_ID}/activity`, "{}");
    expect([401, 403]).toContain(res.status);
  });

  it("projeto arquivado pode ser lido", async () => {
    const t = await add();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await feed(t.id, "", "reader")).status).toBe(200);
  });

  it("só lê: nada é gravado nem alterado", async () => {
    const t = await add({ title: "A" });
    await patch(t.id, { title: "B" });
    const snapshot = async () => ({
      events: await count("select count(*) from activity_events"),
      tickets: JSON.stringify((await h.pool.query("select * from tickets order by id")).rows),
      people: JSON.stringify((await h.pool.query("select * from people order by id")).rows),
    });
    const before = await snapshot();
    await feed(t.id);
    await feed(t.id, "?limit=1", "reader");
    await feed(t.id, "?limit=1&before=lixo");
    await feed(UNKNOWN_ID);
    expect(await snapshot()).toEqual(before);
  });

  it("ticket que o cursor aponta de outro ticket não vaza: o cursor só filtra o ticket da rota", async () => {
    const a = await add({ title: "A" });
    const b = await add({ title: "B" });
    await patch(b.id, { title: "B2" });
    const pb = await page(b.id, "?limit=1");
    const res = await page(a.id, `?limit=5&before=${encodeURIComponent(pb.before as string)}`);
    expect(res.entries.every((e) => !e.id.startsWith("created:") || e.id === `created:${a.id}`)).toBe(true);
    expect(JSON.stringify(res)).not.toContain(b.id);
  });
});

describe("custo", () => {
  /** Conta as consultas que o serviço faz: toda chamada a um método de modelo ou a `$queryRaw`/`$executeRaw` do `tx`. */
  const queriesOf = async (ticketId: string, limit: number): Promise<{ queries: number; entries: number }> => {
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
        const result = await new TicketActivityService().read(counting, project, ticket, { limit });
        return { queries, entries: result.entries.length };
      });
    } finally {
      await prisma.$disconnect();
    }
  };

  it("a quantidade de consultas não cresce com as entradas (eventos, tickets e pessoas em lote)", async () => {
    const parent = await add({ title: "P" });
    const other = await add({ title: "O" });
    const t = await add({});
    const round = async (i: number) => {
      await patch(t.id, { title: `x${i}`, parentId: i % 2 === 0 ? parent.id : null, status: i % 2 === 0 ? "in_progress" : "todo" });
      await h.call("PUT", `/api/tickets/${t.id}/assignees/${personId("contributor")}`, as("admin"));
      await h.call("DELETE", `/api/tickets/${t.id}/assignees/${personId("contributor")}`, as("manager"));
      await h.call("POST", `/api/tickets/${t.id}/dependencies`, as("admin"), { ticketId: other.id });
      await h.call("DELETE", `/api/tickets/${t.id}/dependencies/${other.id}`, as("admin"));
    };
    await round(0);
    const few = await queriesOf(t.id, 30);
    for (let i = 1; i < 6; i++) await round(i);
    const many = await queriesOf(t.id, 30);
    expect(many.entries).toBeGreaterThan(few.entries);
    expect(many.entries).toBe(30);
    expect(many.queries).toBe(few.queries);
    expect(many.queries).toBeLessThanOrEqual(3);
  });
});

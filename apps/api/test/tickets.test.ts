import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness();
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

type Body = Record<string, unknown>;

const projectOf = (kind: "priv" | "org") => h.world().projects[kind];
const create = (kind: "priv" | "org", body: Body, who: Who = "admin") =>
  h.call("POST", `/api/projects/${projectOf(kind)}/tickets`, as(who), body);
const ticket = async (kind: "priv" | "org", body: Body = {}, who: Who = "admin"): Promise<Body & { id: string }> => {
  const res = await create(kind, { title: "Ticket", ...body }, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Body & { id: string };
};
const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number((await h.pool.query(sql, params)).rows[0].count);
const archive = (kind: "priv" | "org") =>
  h.pool.query("update projects set archived_at = now() where id = $1", [projectOf(kind)]);
const events = async (kind: string) =>
  (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;

describe("criação e leitura", () => {
  it("cria o ticket com número, chave e valores padrão (201)", async () => {
    const res = await create("priv", { title: "  Primeiro  " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      projectId: projectOf("priv"),
      number: 1,
      key: "PRIV-1",
      parentId: null,
      title: "Primeiro",
      status: "todo",
      progress: null,
      assigneeIds: [],
      description: "",
      createdByPersonId: h.world().people.admin,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const second = await ticket("priv");
    expect(second.number).toBe(2);
  });

  it("recusa campo desconhecido, título vazio ou longo e situação inválida (400)", async () => {
    for (const body of [
      { title: "x", extra: 1 },
      { title: "   " },
      { title: "x".repeat(201) },
      { title: "x", description: "d".repeat(20001) },
      { title: "x", status: "blocked" },
      { title: "x", parentId: "nao-e-uuid" },
      {},
    ]) {
      expect((await create("priv", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(await count("select count(*) from tickets")).toBe(0);
  });

  it("aceita descrição, situação, pai e atribuídos na criação", async () => {
    const parent = await ticket("priv");
    const res = await create("priv", {
      title: "Filho",
      description: "texto",
      status: "in_review",
      parentId: parent.id,
      assigneeIds: [h.world().people.contributor, h.world().people.manager],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ parentId: parent.id, description: "texto", status: "in_review", number: 2 });
    expect(res.body.assigneeIds).toEqual([h.world().people.contributor, h.world().people.manager].sort());
  });

  it("lista em ordem de number, sem descrição, com assigneeIds ordenados e progresso do pai", async () => {
    const root = await ticket("priv", { title: "Raiz", description: "longa" });
    await ticket("priv", { title: "A", parentId: root.id, status: "done", description: "x" });
    await ticket("priv", { title: "B", parentId: root.id, status: "cancelled" });
    const c = await ticket("priv", { title: "C", parentId: root.id, status: "in_progress" });
    const { contributor, manager } = h.world().people;
    for (const id of [contributor, manager]) {
      expect((await h.call("PUT", `/api/tickets/${c.id}/assignees/${id}`, as("admin"))).status).toBe(200);
    }
    const res = await h.call("GET", `/api/projects/${projectOf("priv")}/tickets`, as("reader"));
    expect(res.status).toBe(200);
    expect(res.body.map((t: Body) => t.number)).toEqual([1, 2, 3, 4]);
    for (const t of res.body) expect(t).not.toHaveProperty("description");
    expect(res.body[0]).toMatchObject({
      key: "PRIV-1",
      status: null,
      progress: { done: 1, total: 2, excluded: 1 },
    });
    expect(res.body[1]).toMatchObject({ status: "done", progress: null, parentId: root.id });
    expect(res.body[3].assigneeIds).toEqual([contributor, manager].sort());
  });

  it("devolve o detalhe com descrição e progresso do pai", async () => {
    const root = await ticket("priv", { description: "detalhe" });
    await ticket("priv", { parentId: root.id, status: "done" });
    const res = await h.call("GET", `/api/tickets/${root.id}`, as("reader"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: root.id,
      description: "detalhe",
      status: null,
      progress: { done: 1, total: 1, excluded: 0 },
    });
  });

  it("projeto de organização é visível a membro sem papel; números não são reutilizados", async () => {
    const a = await ticket("org");
    expect((await h.call("GET", `/api/tickets/${a.id}`, as("plain"))).status).toBe(200);
    expect((await h.call("DELETE", `/api/tickets/${a.id}`, as("admin"))).status).toBe(204);
    expect((await ticket("org")).number).toBe(2);
  });

  it("parâmetro que não é UUID devolve 400", async () => {
    expect((await h.call("GET", "/api/tickets/abc", as("admin"))).status).toBe(400);
    expect((await h.call("GET", "/api/projects/abc/tickets", as("admin"))).status).toBe(400);
  });
});

describe("404 por visibilidade e por organização", () => {
  it("projeto privado que o chamador não vê: 404 em toda rota de ticket", async () => {
    const t = await ticket("priv");
    const other = h.world().people.manager;
    const p = projectOf("priv");
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/projects/${p}/tickets`],
      ["POST", `/api/projects/${p}/tickets`, { title: "x" }],
      ["POST", `/api/projects/${p}/tickets/import`, { items: [{ title: "x" }] }],
      ["GET", `/api/tickets/${t.id}`],
      ["PATCH", `/api/tickets/${t.id}`, { title: "x" }],
      ["DELETE", `/api/tickets/${t.id}`],
      ["PUT", `/api/tickets/${t.id}/assignees/${other}`],
      ["DELETE", `/api/tickets/${t.id}/assignees/${other}`],
    ];
    for (const who of ["plain", "teamAdmin"] as const) {
      for (const [method, path, body] of calls) {
        const res = await h.call(method, path, as(who), body);
        expect(res.status, `${who} ${method} ${path}`).toBe(404);
      }
    }
    expect(await count("select count(*) from tickets")).toBe(1);
  });

  it("projeto e ticket de outra organização: 404 em toda rota, sem alterar nada", async () => {
    const w = h.world();
    const created = await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_B', $1, 1, 'B', $2) returning id",
      [w.other.project, w.other.person],
    );
    const bt = created.rows[0].id as string;
    const mine = await ticket("org");
    const p = w.other.project;
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/projects/${p}/tickets`],
      ["POST", `/api/projects/${p}/tickets`, { title: "x" }],
      ["POST", `/api/projects/${p}/tickets/import`, { items: [{ title: "x" }] }],
      ["GET", `/api/tickets/${bt}`],
      ["PATCH", `/api/tickets/${bt}`, { title: "invadido" }],
      ["DELETE", `/api/tickets/${bt}`],
      ["PUT", `/api/tickets/${bt}/assignees/${w.people.plain}`],
      ["DELETE", `/api/tickets/${bt}/assignees/${w.other.person}`],
      ["PATCH", `/api/tickets/${mine.id}`, { parentId: bt }],
      ["PUT", `/api/tickets/${mine.id}/assignees/${w.other.person}`],
    ];
    for (const [method, path, body] of calls) {
      expect((await h.call(method, path, as("admin"), body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await h.pool.query("select title from tickets where id = $1", [bt])).rows[0].title).toBe("B");
  });

  it("ticket inexistente: 404", async () => {
    expect((await h.call("GET", `/api/tickets/${UNKNOWN_ID}`, as("admin"))).status).toBe(404);
  });
});

describe("permissões", () => {
  it("leitor e membro sem papel recebem 403 nas mutações de projeto visível", async () => {
    const t = await ticket("priv");
    const o = await ticket("org");
    const who = h.world().people.manager;
    const attempts: [Who, string, string, unknown?][] = [];
    for (const [actor, tk, kind] of [["reader", t, "priv"], ["plain", o, "org"], ["teamAdmin", o, "org"]] as const) {
      attempts.push(
        [actor, "POST", `/api/projects/${projectOf(kind)}/tickets`, { title: "x" }],
        [actor, "POST", `/api/projects/${projectOf(kind)}/tickets/import`, { items: [{ title: "x" }] }],
        [actor, "PATCH", `/api/tickets/${tk.id}`, { title: "x" }],
        [actor, "DELETE", `/api/tickets/${tk.id}`],
        [actor, "PUT", `/api/tickets/${tk.id}/assignees/${who}`],
        [actor, "DELETE", `/api/tickets/${tk.id}/assignees/${who}`],
      );
    }
    for (const [actor, method, path, body] of attempts) {
      expect((await h.call(method, path, as(actor), body)).status, `${actor} ${method} ${path}`).toBe(403);
    }
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("reader"))).status).toBe(200);
  });

  it("colaborador cria, edita, atribui e importa, mas não remove", async () => {
    const t = await ticket("priv", {}, "contributor");
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("contributor"), { title: "novo" })).status).toBe(200);
    expect(
      (await h.call("PUT", `/api/tickets/${t.id}/assignees/${h.world().people.reader}`, as("contributor"))).status,
    ).toBe(200);
    expect(
      (await h.call("POST", `/api/projects/${projectOf("priv")}/tickets/import`, as("contributor"), { items: [{ title: "i" }] })).status,
    ).toBe(201);
    expect((await h.call("DELETE", `/api/tickets/${t.id}`, as("contributor"))).status).toBe(403);
  });

  it("gestor e administrador da organização removem", async () => {
    const a = await ticket("priv");
    const b = await ticket("priv");
    expect((await h.call("DELETE", `/api/tickets/${a.id}`, as("manager"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/tickets/${b.id}`, as("admin"))).status).toBe(204);
    expect(await count("select count(*) from tickets")).toBe(0);
  });

  it("papel de gestor em outro projeto não vale neste (projeto de organização)", async () => {
    expect((await create("org", { title: "x" }, "manager")).status).toBe(403);
  });
});

describe("projeto arquivado", () => {
  it("leitura funciona e toda mutação devolve 409 project_archived", async () => {
    const t = await ticket("priv");
    await h.call("PUT", `/api/tickets/${t.id}/assignees/${h.world().people.reader}`, as("admin"));
    await archive("priv");
    const p = projectOf("priv");
    expect((await h.call("GET", `/api/projects/${p}/tickets`, as("reader"))).status).toBe(200);
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("reader"))).status).toBe(200);
    const mutations: [string, string, unknown?][] = [
      ["POST", `/api/projects/${p}/tickets`, { title: "x" }],
      ["POST", `/api/projects/${p}/tickets/import`, { items: [{ title: "x" }] }],
      ["PATCH", `/api/tickets/${t.id}`, { title: "x" }],
      ["DELETE", `/api/tickets/${t.id}`],
      ["PUT", `/api/tickets/${t.id}/assignees/${h.world().people.manager}`],
      ["DELETE", `/api/tickets/${t.id}/assignees/${h.world().people.reader}`],
    ];
    for (const [method, path, body] of mutations) {
      const res = await h.call(method, path, as("admin"), body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.body.error.code).toBe("project_archived");
    }
    expect(await count("select count(*) from tickets")).toBe(1);
  });
});

describe("ticket com filhos", () => {
  it("tem status null, recusa mudar situação e remover; ao perder o último filho a situação volta", async () => {
    const parent = await ticket("priv", { status: "in_progress" });
    const child = await ticket("priv", { parentId: parent.id });
    const detail = await h.call("GET", `/api/tickets/${parent.id}`, as("admin"));
    expect(detail.body).toMatchObject({ status: null, progress: { done: 0, total: 1, excluded: 0 } });

    const patch = await h.call("PATCH", `/api/tickets/${parent.id}`, as("admin"), { status: "done" });
    expect(patch.status).toBe(409);
    expect(patch.body.error.code).toBe("ticket_has_children");
    const del = await h.call("DELETE", `/api/tickets/${parent.id}`, as("admin"));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("ticket_has_children");
    expect((await h.call("PATCH", `/api/tickets/${parent.id}`, as("admin"), { title: "Renomeado" })).status).toBe(200);

    expect((await h.call("DELETE", `/api/tickets/${child.id}`, as("admin"))).status).toBe(204);
    const back = await h.call("GET", `/api/tickets/${parent.id}`, as("admin"));
    expect(back.body).toMatchObject({ status: "in_progress", progress: null });
  });

  it("mover o último filho para outro pai devolve a situação guardada ao antigo", async () => {
    const a = await ticket("priv", { status: "in_review" });
    const b = await ticket("priv");
    const c = await ticket("priv", { parentId: a.id });
    const res = await h.call("PATCH", `/api/tickets/${c.id}`, as("admin"), { parentId: b.id });
    expect(res.status).toBe(200);
    expect(res.body.parentId).toBe(b.id);
    expect((await h.call("GET", `/api/tickets/${a.id}`, as("admin"))).body.status).toBe("in_review");
  });
});

describe("PATCH e parentesco", () => {
  it("altera título, descrição e situação de uma folha; exige ao menos um campo", async () => {
    const t = await ticket("priv");
    const res = await h.call("PATCH", `/api/tickets/${t.id}`, as("admin"), {
      title: " Novo ",
      description: "desc",
      status: "done",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "Novo", description: "desc", status: "done" });
    for (const body of [{}, { number: 3 }, { title: "" }, { status: "x" }, { parentId: 5 }]) {
      expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("admin"), body)).status).toBe(400);
    }
  });

  it("ciclo: o próprio ticket ou um descendente como pai devolve 409 ticket_cycle", async () => {
    const a = await ticket("priv");
    const b = await ticket("priv", { parentId: a.id });
    const c = await ticket("priv", { parentId: b.id });
    for (const parentId of [a.id, b.id, c.id]) {
      const res = await h.call("PATCH", `/api/tickets/${a.id}`, as("admin"), { parentId });
      expect(res.status, parentId).toBe(409);
      expect(res.body.error.code).toBe("ticket_cycle");
    }
    expect((await h.call("GET", `/api/tickets/${a.id}`, as("admin"))).body.parentId).toBeNull();
  });

  it("pai de outro projeto ou inexistente devolve 404", async () => {
    const a = await ticket("priv");
    const other = await ticket("org");
    for (const parentId of [other.id, UNKNOWN_ID]) {
      expect((await h.call("PATCH", `/api/tickets/${a.id}`, as("admin"), { parentId })).status).toBe(404);
      expect((await create("priv", { title: "x", parentId })).status).toBe(404);
    }
  });

  it("muda o pai, vira raiz com null e mantém o número", async () => {
    const a = await ticket("priv");
    const b = await ticket("priv");
    const moved = await h.call("PATCH", `/api/tickets/${b.id}`, as("admin"), { parentId: a.id });
    expect(moved.body).toMatchObject({ parentId: a.id, number: 2 });
    const root = await h.call("PATCH", `/api/tickets/${b.id}`, as("admin"), { parentId: null });
    expect(root.body).toMatchObject({ parentId: null, number: 2 });
  });
});

describe("atribuição", () => {
  it("PUT é idempotente e DELETE remove (404 se não atribuído)", async () => {
    const t = await ticket("priv");
    const person = h.world().people.reader;
    const first = await h.call("PUT", `/api/tickets/${t.id}/assignees/${person}`, as("manager"));
    const second = await h.call("PUT", `/api/tickets/${t.id}/assignees/${person}`, as("manager"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.assigneeIds).toEqual([person]);
    expect(await count("select count(*) from ticket_assignees")).toBe(1);
    expect((await h.call("DELETE", `/api/tickets/${t.id}/assignees/${person}`, as("manager"))).status).toBe(204);
    expect((await h.call("DELETE", `/api/tickets/${t.id}/assignees/${person}`, as("manager"))).status).toBe(404);
    expect(await count("select count(*) from ticket_assignees")).toBe(0);
  });

  it("pessoa inativa: 409 person_inactive (também na criação)", async () => {
    const t = await ticket("org");
    const person = h.world().people.reader;
    await h.pool.query("update people set active = false where id = $1", [person]);
    const res = await h.call("PUT", `/api/tickets/${t.id}/assignees/${person}`, as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("person_inactive");
    const created = await create("org", { title: "x", assigneeIds: [person] });
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe("person_inactive");
    expect(await count("select count(*) from tickets")).toBe(1);
  });

  it("pessoa que não vê o projeto privado: 409 person_without_project_access, sem conceder acesso", async () => {
    const t = await ticket("priv");
    const plain = h.world().people.plain;
    const res = await h.call("PUT", `/api/tickets/${t.id}/assignees/${plain}`, as("admin"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("person_without_project_access");
    const created = await create("priv", { title: "x", assigneeIds: [plain] });
    expect(created.status).toBe(409);
    expect(created.body.error.code).toBe("person_without_project_access");
    expect(await count("select count(*) from project_memberships where person_id = $1", [plain])).toBe(0);
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("plain"))).status).toBe(404);
  });

  it("administrador da organização sem papel no projeto privado pode ser atribuído; atribuir não concede acesso", async () => {
    const t = await ticket("priv");
    const admin = h.world().people.admin;
    expect((await h.call("PUT", `/api/tickets/${t.id}/assignees/${admin}`, as("manager"))).status).toBe(200);
    // Perde o acesso depois: a atribuição continua registrada.
    await h.pool.query("update projects set visibility = 'private' where id = $1", [projectOf("priv")]);
    await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.reader]);
    const detail = await h.call("GET", `/api/tickets/${t.id}`, as("manager"));
    expect(detail.body.assigneeIds).toEqual([admin]);
  });

  it("pessoa inexistente ou de outra organização: 404", async () => {
    const t = await ticket("org");
    for (const id of [UNKNOWN_ID, h.world().other.person]) {
      expect((await h.call("PUT", `/api/tickets/${t.id}/assignees/${id}`, as("admin"))).status).toBe(404);
    }
  });
});

describe("alocação de número", () => {
  it("criações simultâneas no mesmo projeto recebem números distintos e consecutivos", async () => {
    await h.call("GET", "/api/people", as("admin")); // provisiona a pessoa antes da rajada
    const total = 8;
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) => create("org", { title: `T${i}` })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(total).fill(201));
    const numbers = results.map((r) => r.body.number as number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    const next = await h.pool.query("select next_ticket_number as n from projects where id = $1", [projectOf("org")]);
    expect(next.rows[0].n).toBe(total + 1);
  });

  it("importações e criações simultâneas não repetem números", async () => {
    await h.call("GET", "/api/people", as("admin"));
    const calls = [
      ...Array.from({ length: 3 }, () =>
        h.call("POST", `/api/projects/${projectOf("org")}/tickets/import`, as("admin"), {
          items: [{ title: "a", children: [{ title: "b" }, { title: "c" }] }],
        }),
      ),
      ...Array.from({ length: 3 }, () => create("org", { title: "solto" })),
    ];
    const results = await Promise.all(calls);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    const rows = await h.pool.query("select number from tickets where project_id = $1 order by number", [projectOf("org")]);
    expect(rows.rows.map((r) => r.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describe("importação em lote", () => {
  const importTo = (body: unknown, who: Who = "admin", kind: "priv" | "org" = "priv") =>
    h.call("POST", `/api/projects/${projectOf(kind)}/tickets/import`, as(who), body);

  it("cria a árvore em pré-ordem e devolve os resumos em ordem de number", async () => {
    const res = await importTo({
      items: [
        { title: "Fase 1", description: "d1", status: "in_progress", children: [{ title: "a", status: "done" }, { title: "b", children: [{ title: "b1" }] }] },
        { title: "Fase 2" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.map((t: Body) => [t.number, t.title, t.key])).toEqual([
      [1, "Fase 1", "PRIV-1"],
      [2, "a", "PRIV-2"],
      [3, "b", "PRIV-3"],
      [4, "b1", "PRIV-4"],
      [5, "Fase 2", "PRIV-5"],
    ]);
    const byTitle = Object.fromEntries(res.body.map((t: Body) => [t.title, t]));
    expect(byTitle["a"].parentId).toBe(byTitle["Fase 1"].id);
    expect(byTitle["b1"].parentId).toBe(byTitle["b"].id);
    expect(byTitle["Fase 2"].parentId).toBeNull();
    expect(byTitle["Fase 1"]).toMatchObject({ status: null, progress: { done: 1, total: 2, excluded: 0 }, assigneeIds: [] });
    expect(byTitle["Fase 2"]).toMatchObject({ status: "todo", progress: null });
    expect(res.body[0]).not.toHaveProperty("description");
    const stored = await h.pool.query("select description, status from tickets where number = 1 and project_id = $1", [projectOf("priv")]);
    expect(stored.rows[0]).toEqual({ description: "d1", status: "in_progress" });
    const next = await h.pool.query("select next_ticket_number as n from projects where id = $1", [projectOf("priv")]);
    expect(next.rows[0].n).toBe(6);
  });

  it("importa sob um ticket existente com parentId", async () => {
    const root = await ticket("priv");
    const res = await importTo({ parentId: root.id, items: [{ title: "x" }, { title: "y" }] });
    expect(res.status).toBe(201);
    expect(res.body.map((t: Body) => t.parentId)).toEqual([root.id, root.id]);
    expect(res.body.map((t: Body) => t.number)).toEqual([2, 3]);
  });

  it("parentId de outro projeto ou inexistente: 404 e nada criado", async () => {
    const other = await ticket("org");
    for (const parentId of [other.id, UNKNOWN_ID]) {
      expect((await importTo({ parentId, items: [{ title: "x" }] })).status).toBe(404);
    }
    expect(await count("select count(*) from tickets where project_id = $1", [projectOf("priv")])).toBe(0);
  });

  it("é atômica: item inválido em qualquer profundidade devolve 400 e nada é criado", async () => {
    const invalid: unknown[] = [
      { items: [{ title: "ok" }, { title: "ok2", children: [{ title: "ok3", children: [{ title: "   " }] }] }] },
      { items: [{ title: "ok" }, { title: "x", children: [{ title: "y", status: "blocked" }] }] },
      { items: [{ title: "ok", children: [{ title: "y", extra: true }] }] },
      { items: [{ title: "ok" }], extra: 1 },
      { items: [{ title: "x".repeat(201) }] },
      { items: [{ title: "ok", description: "d".repeat(20001) }] },
      { items: [] },
      {},
      { items: [{ title: "ok", children: [] }, "texto"] },
    ];
    for (const body of invalid) {
      expect((await importTo(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await count("select count(*) from tickets")).toBe(0);
    const next = await h.pool.query("select next_ticket_number as n from projects where id = $1", [projectOf("priv")]);
    expect(next.rows[0].n).toBe(1);
    expect(await count("select count(*) from activity_events where kind = 'ticket.imported'")).toBe(0);
  });

  it("aceita 500 itens e recusa 501", async () => {
    const flat = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ title: `t${i}` })) });
    expect((await importTo(flat(501))).status).toBe(400);
    expect(await count("select count(*) from tickets")).toBe(0);
    const ok = await importTo(flat(500));
    expect(ok.status).toBe(201);
    expect(ok.body).toHaveLength(500);
    expect(ok.body[499].number).toBe(500);
  });

  it("conta itens aninhados no limite de 500", async () => {
    const nested = { items: [{ title: "r", children: Array.from({ length: 500 }, (_, i) => ({ title: `c${i}` })) }] };
    expect((await importTo(nested)).status).toBe(400);
    expect(await count("select count(*) from tickets")).toBe(0);
  });

  it("aceita profundidade 20 e recusa 21", async () => {
    const chain = (depth: number): Body => {
      let node: Body = { title: `n${depth}` };
      for (let level = depth - 1; level >= 1; level--) node = { title: `n${level}`, children: [node] };
      return node;
    };
    expect((await importTo({ items: [chain(21)] })).status).toBe(400);
    expect(await count("select count(*) from tickets")).toBe(0);
    const ok = await importTo({ items: [chain(20)] });
    expect(ok.status).toBe(201);
    expect(ok.body).toHaveLength(20);
  });

  it("importa 500 itens em árvore de profundidade variada, com números em pré-ordem e pais corretos", async () => {
    type Node = { title: string; children?: Node[] };
    const expected: { title: string; parent: string | null }[] = [];
    let seq = 0;
    // Pré-ordem determinística: cada nó tem 0 a 3 filhos conforme o contador, até 500 nós e profundidade 20.
    const build = (parent: string | null, depth: number): Node | null => {
      if (seq >= 500) return null;
      const title = `n${seq++}`;
      expected.push({ title, parent });
      const node: Node = { title };
      const kids = depth >= 20 ? 0 : (seq * 7) % 4;
      for (let i = 0; i < kids; i++) {
        const child = build(title, depth + 1);
        if (child) (node.children ??= []).push(child);
      }
      return node;
    };
    const items: Node[] = [];
    while (seq < 500) {
      const node = build(null, 1);
      if (node) items.push(node);
    }
    const res = await importTo({ items });
    expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
    expect(res.body).toHaveLength(500);
    expect(res.body.map((t: Body) => t.number)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(res.body.map((t: Body) => t.title)).toEqual(expected.map((e) => e.title));
    const idByTitle = new Map<string, string>(res.body.map((t: Body) => [t.title as string, t.id as string]));
    expect(res.body.map((t: Body) => t.parentId)).toEqual(expected.map((e) => (e.parent === null ? null : idByTitle.get(e.parent))));
    expect(expected.some((e) => e.parent !== null)).toBe(true);
    expect(await events("ticket.imported")).toHaveLength(1);
    expect(await count("select count(*) from tickets")).toBe(500);
  });

  it("usa o mesmo número de comandos SQL para 5 e para 200 itens", async () => {
    const pairs = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, children: [{ title: `c${i}` }] })) });
    const small5 = { items: [{ title: "a", children: [{ title: "a1" }] }, { title: "b", children: [{ title: "b1" }] }, { title: "c" }] };
    await importTo({ items: [{ title: "aquecimento" }] }); // identidade e diretório só custam na primeira chamada
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      expect((await importTo(small5)).status).toBe(201); // 5 itens
      const small = spy.mock.calls.length;
      spy.mockClear();
      expect((await importTo(pairs(100))).status).toBe(201); // 200 itens
      const large = spy.mock.calls.length;
      expect(small).toBeGreaterThan(0);
      expect(large).toBe(small);
    } finally {
      spy.mockRestore();
    }
  });

  it("grava um único evento ticket.imported com o projeto como assunto", async () => {
    await h.call("GET", "/api/people", as("admin"));
    await ticket("priv");
    const res = await importTo({ items: [{ title: "a", children: [{ title: "b" }] }, { title: "c" }] });
    expect(res.status).toBe(201);
    const rows = await events("ticket.imported");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_type: "project",
      subject_id: projectOf("priv"),
      actor_person_id: h.world().people.admin,
      payload: { count: 3, firstNumber: 2, lastNumber: 4 },
    });
    expect(await events("ticket.created")).toHaveLength(1);
  });
});

describe("eventos de atividade", () => {
  it("cada mutação grava um evento de ticket com o autor e o assunto", async () => {
    await h.call("GET", "/api/people", as("admin"));
    const t = await ticket("priv", { title: "Evento" });
    const created = await events("ticket.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      subject_type: "ticket",
      subject_id: t.id,
      actor_person_id: h.world().people.admin,
      org_id: "org_A",
    });
    expect(created[0].payload).toMatchObject({ key: "PRIV-1", title: "Evento" });

    const person = h.world().people.reader;
    await h.call("PUT", `/api/tickets/${t.id}/assignees/${person}`, as("admin"));
    await h.call("PUT", `/api/tickets/${t.id}/assignees/${person}`, as("admin")); // repetição não é mutação
    const added = await events("ticket.assignee_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ subject_type: "ticket", subject_id: t.id });
    expect(added[0].payload).toMatchObject({ personId: person });

    await h.call("PATCH", `/api/tickets/${t.id}`, as("admin"), { title: "Novo", status: "done" });
    const updated = await events("ticket.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].payload.fields.sort()).toEqual(["status", "title"]);

    await h.call("DELETE", `/api/tickets/${t.id}/assignees/${person}`, as("admin"));
    const removed = await events("ticket.assignee_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({ personId: person });

    await h.call("DELETE", `/api/tickets/${t.id}`, as("admin"));
    const deleted = await events("ticket.deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ subject_type: "ticket", subject_id: t.id });
    expect(deleted[0].payload).toMatchObject({ key: "PRIV-1" });
  });

  it("PATCH que não altera nada e mutações recusadas não gravam evento", async () => {
    const t = await ticket("priv", { title: "Igual" });
    const before = await count("select count(*) from activity_events");
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("admin"), { title: "Igual" })).status).toBe(200);
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("reader"), { title: "x" })).status).toBe(403);
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("plain"), { title: "x" })).status).toBe(404);
    expect((await create("priv", { title: "x", assigneeIds: [h.world().people.plain] })).status).toBe(409);
    expect(await count("select count(*) from activity_events")).toBe(before);
  });

  it("a criação com atribuídos registra os atribuídos no evento ticket.created", async () => {
    const person = h.world().people.reader;
    await ticket("priv", { assigneeIds: [person] });
    const created = await events("ticket.created");
    expect(created[0].payload.assigneeIds).toEqual([person]);
  });
});

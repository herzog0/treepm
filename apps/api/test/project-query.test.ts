import type { TenantClient } from "@treepm/db";
import { createPrismaClient, withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { APP_URL } from "@treepm/db/testing";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../src/access/authorization.service.js";
import type { Principal } from "../src/access/principal.js";
import { ProjectQueryService } from "../src/query/project-query.service.js";
import { ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import { ORG, OTHER_ORG, seedWorld } from "./world.js";
import type { Who, World } from "./world.js";

const pool: pg.Pool = ownerPoolWithCleanup();
const authorization = new AuthorizationService();
const service = new ProjectQueryService(authorization, { now: () => Date.now() });
let prisma: PrismaClient;
let world: World;

beforeAll(() => {
  prisma = createPrismaClient(APP_URL);
});
afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  world = await seedWorld(pool);
});

type Seed = { parent?: string | null; status?: string; description?: string };
const ids = new Map<string, string>();

/** Semeia um ticket pelo papel dono; `key` é `PROJETO#número` para o teste se referir a ele. */
async function ticket(projectId: string, number: number, title: string, seed: Seed = {}, orgId = ORG): Promise<string> {
  const creator = orgId === ORG ? world.people.admin : world.other.person;
  const r = await pool.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, description, status, parent_id, created_by_person_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [orgId, projectId, number, title, seed.description ?? "", seed.status ?? "todo", seed.parent ?? null, creator],
  );
  const id = r.rows[0]?.id ?? "";
  ids.set(`${projectId}#${number}`, id);
  return id;
}

async function relate(projectId: string, from: number, to: number, kind: "mentions" | "depends_on", orgId = ORG): Promise<void> {
  await pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1,$2,$3,$4,$5)", [
    orgId,
    projectId,
    ids.get(`${projectId}#${from}`),
    ids.get(`${projectId}#${to}`),
    kind,
  ]);
}

/** Roda `fn` numa transação de tenant, como a API faz, com o `Principal` de `who` carregado nela. */
async function as<T>(who: Who, fn: (tx: TenantClient, principal: Principal) => Promise<T>, orgId = ORG): Promise<T> {
  const userId = orgId === ORG ? `u_${who}` : "u_outsider";
  return withTenant(prisma, { orgId, userId }, async (tx) => {
    const person = await tx.person.findFirstOrThrow({ where: { clerkUserId: userId } });
    const actor = await authorization.loadActor(tx, person.id, person.clerkRole as "admin" | "member");
    const principal = {
      session: { userId, orgId, orgRole: person.clerkRole === "admin" ? "org:admin" : "org:member", sessionStatus: "active" },
      person,
      organization: { orgId, name: orgId, slug: orgId.toLowerCase() },
      actor,
    } as unknown as Principal;
    return fn(tx, principal);
  });
}

const nums = (list: { tickets: readonly { number: number }[] }) => list.tickets.map((entry) => entry.number);
const OPEN = () => world.projects.org;

describe("search", () => {
  it("applies the bar's rule to the tickets of the project", async () => {
    await ticket(OPEN(), 1, "Painel", { description: "Inclui o relatório mensal" });
    await ticket(OPEN(), 2, "Relatório de vendas");
    await ticket(OPEN(), 3, "Exportar relatório");
    const found = await as("reader", (tx, p) => service.search(tx, p, OPEN(), "RELATORIO"));
    expect(nums(found)).toEqual([2, 3, 1]);
    expect(found.truncated).toBe(false);
    expect(found.tickets[0]).toEqual({
      id: ids.get(`${OPEN()}#2`),
      key: "OPEN-2",
      number: 2,
      title: "Relatório de vendas",
      descriptionExcerpt: "",
      status: "todo",
      parentId: null,
      idea: null,
      agentWork: null,
    });
  });

  it("finds by key and by bare number", async () => {
    await ticket(OPEN(), 1, "A");
    await ticket(OPEN(), 47, "B");
    expect(nums(await as("reader", (tx, p) => service.search(tx, p, OPEN(), "open-47")))).toEqual([47]);
    expect(nums(await as("reader", (tx, p) => service.search(tx, p, OPEN(), "47")))).toEqual([47]);
  });

  it("is empty with no match and with blank text", async () => {
    await ticket(OPEN(), 1, "A");
    expect((await as("reader", (tx, p) => service.search(tx, p, OPEN(), "zzz"))).tickets).toEqual([]);
    expect(await as("reader", (tx, p) => service.search(tx, p, OPEN(), "  "))).toEqual({ tickets: [], truncated: false });
  });

  it("defaults to 8, honors the limit, caps at 50 and says when it cut", async () => {
    for (let n = 1; n <= 60; n += 1) await ticket(OPEN(), n, `Item ${n}`);
    const byDefault = await as("reader", (tx, p) => service.search(tx, p, OPEN(), "item"));
    expect(byDefault.tickets).toHaveLength(8);
    expect(byDefault.truncated).toBe(true);
    const three = await as("reader", (tx, p) => service.search(tx, p, OPEN(), "item", { limit: 3 }));
    expect(nums(three)).toEqual([1, 2, 3]);
    expect(three.truncated).toBe(true);
    const huge = await as("reader", (tx, p) => service.search(tx, p, OPEN(), "item", { limit: 500 }));
    expect(huge.tickets).toHaveLength(50);
    expect(huge.truncated).toBe(true);
  });

  it("is not truncated when exactly at the limit", async () => {
    for (let n = 1; n <= 3; n += 1) await ticket(OPEN(), n, `Item ${n}`);
    const found = await as("reader", (tx, p) => service.search(tx, p, OPEN(), "item", { limit: 3 }));
    expect(found.tickets).toHaveLength(3);
    expect(found.truncated).toBe(false);
  });

  it("truncates the excerpt like the rest of the API", async () => {
    await ticket(OPEN(), 1, "Longo", { description: "x".repeat(900) });
    const found = await as("reader", (tx, p) => service.search(tx, p, OPEN(), "longo"));
    expect(found.tickets[0]?.descriptionExcerpt).toBe(`${"x".repeat(600)}…`);
  });
});

describe("ticket", () => {
  it("reads title, whole description, status, key, parent, children and the path to the root", async () => {
    const root = await ticket(OPEN(), 1, "Raiz");
    const mid = await ticket(OPEN(), 2, "Meio", { parent: root });
    const leaf = await ticket(OPEN(), 3, "Folha", { parent: mid, status: "in_progress", description: "d".repeat(900) });
    await ticket(OPEN(), 5, "Filho B", { parent: leaf, status: "done" });
    await ticket(OPEN(), 4, "Filho A", { parent: leaf });
    const view = await as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 3));
    expect(view).toMatchObject({ id: leaf, key: "OPEN-3", number: 3, title: "Folha", status: "in_progress", parentId: mid });
    expect(view.description).toBe("d".repeat(900));
    expect(view.descriptionExcerpt).toBe(`${"d".repeat(600)}…`);
    expect(view.path.map((entry) => entry.number)).toEqual([1, 2]);
    expect(view.parent?.number).toBe(2);
    expect(view.children.tickets.map((entry) => entry.number)).toEqual([4, 5]);
    expect(view.children.truncated).toBe(false);
  });

  it("has no parent and an empty path at the top", async () => {
    await ticket(OPEN(), 1, "Raiz");
    const view = await as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 1));
    expect(view.parent).toBeNull();
    expect(view.path).toEqual([]);
    expect(view.children).toEqual({ tickets: [], truncated: false });
    expect(view.relations.mentions).toEqual({ outgoing: { tickets: [], truncated: false }, incoming: { tickets: [], truncated: false } });
    expect(view.relations.dependsOn).toEqual({ outgoing: { tickets: [], truncated: false }, incoming: { tickets: [], truncated: false } });
  });

  it("returns the relations in both directions, split by kind, as summaries", async () => {
    for (const n of [1, 2, 3, 4, 5]) await ticket(OPEN(), n, `T${n}`);
    await relate(OPEN(), 1, 2, "mentions"); // 1 menciona 2
    await relate(OPEN(), 3, 1, "mentions"); // 3 menciona 1
    await relate(OPEN(), 1, 4, "depends_on"); // 1 depende de 4
    await relate(OPEN(), 5, 1, "depends_on"); // 5 depende de 1
    await relate(OPEN(), 4, 3, "mentions"); // não envolve o 1
    const view = await as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 1));
    const n = (list: { tickets: readonly { number: number }[] }) => nums(list);
    expect(n(view.relations.mentions.outgoing)).toEqual([2]);
    expect(n(view.relations.mentions.incoming)).toEqual([3]);
    expect(n(view.relations.dependsOn.outgoing)).toEqual([4]);
    expect(n(view.relations.dependsOn.incoming)).toEqual([5]);
    expect(view.relations.mentions.outgoing.tickets[0]).toMatchObject({ key: "OPEN-2", title: "T2", status: "todo", parentId: null });
  });

  it("caps children and each relation list at 200 and says it was cut", async () => {
    const root = await ticket(OPEN(), 1, "Raiz");
    const values: string[] = [];
    for (let n = 2; n <= 203; n += 1) {
      const id = await ticket(OPEN(), n, `Filho ${n}`, { parent: root });
      values.push(`('${ORG}','${OPEN()}','${root}','${id}','mentions')`);
    }
    await ticket(OPEN(), 300, "Outro", { parent: root });
    await pool.query(`insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ${values.join(",")}`);
    const view = await as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 1));
    expect(view.children.tickets).toHaveLength(200);
    expect(view.children.truncated).toBe(true);
    expect(view.children.tickets[0]?.number).toBe(2);
    expect(view.relations.mentions.outgoing.tickets).toHaveLength(200);
    expect(view.relations.mentions.outgoing.truncated).toBe(true);
    expect(view.relations.mentions.incoming.truncated).toBe(false);
  });

  it("is exactly 200 children without truncation", async () => {
    const root = await ticket(OPEN(), 1, "Raiz");
    for (let n = 2; n <= 201; n += 1) await ticket(OPEN(), n, `Filho ${n}`, { parent: root });
    const view = await as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 1));
    expect(view.children.tickets).toHaveLength(200);
    expect(view.children.truncated).toBe(false);
  });

  it("answers not found for a missing number, and for the number of another project", async () => {
    await ticket(OPEN(), 1, "A");
    await ticket(world.projects.priv, 9, "Só no privado");
    await expect(as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 99))).rejects.toMatchObject({ status: 404 });
    await expect(as("reader", (tx, p) => service.ticket(tx, p, OPEN(), 9))).rejects.toMatchObject({ status: 404 });
  });

  it("does not show a related ticket of another project", async () => {
    // As chaves estrangeiras compostas já impedem a ligação entre projetos; o número de outro projeto não vaza por busca.
    await ticket(OPEN(), 1, "A");
    await ticket(world.projects.priv, 1, "Do privado");
    const view = await as("admin", (tx, p) => service.ticket(tx, p, OPEN(), 1));
    expect(view.title).toBe("A");
  });
});

describe("list", () => {
  it("lists summaries in number order", async () => {
    await ticket(OPEN(), 3, "C");
    await ticket(OPEN(), 1, "A");
    await ticket(OPEN(), 2, "B");
    const page = await as("reader", (tx, p) => service.list(tx, p, OPEN()));
    expect(nums(page)).toEqual([1, 2, 3]);
    expect(page.truncated).toBe(false);
    expect(page.after).toBeNull();
  });

  it("is empty for a project with no tickets", async () => {
    expect(await as("reader", (tx, p) => service.list(tx, p, OPEN()))).toEqual({ tickets: [], truncated: false, after: null });
  });

  it("filters by one or more statuses", async () => {
    await ticket(OPEN(), 1, "A", { status: "todo" });
    await ticket(OPEN(), 2, "B", { status: "done" });
    await ticket(OPEN(), 3, "C", { status: "in_review" });
    await ticket(OPEN(), 4, "D", { status: "cancelled" });
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN(), { status: ["done"] })))).toEqual([2]);
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN(), { status: ["todo", "in_review"] })))).toEqual([1, 3]);
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN(), { status: [] })))).toEqual([1, 2, 3, 4]);
  });

  it("pages by number: cuts at the limit, returns the cursor and continues after it", async () => {
    for (let n = 1; n <= 7; n += 1) await ticket(OPEN(), n, `T${n}`);
    const first = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { limit: 3 }));
    expect(nums(first)).toEqual([1, 2, 3]);
    expect(first.truncated).toBe(true);
    expect(first.after).toBe(3);
    const second = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { limit: 3, after: first.after ?? 0 }));
    expect(nums(second)).toEqual([4, 5, 6]);
    const last = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { limit: 3, after: second.after ?? 0 }));
    expect(nums(last)).toEqual([7]);
    expect(last.truncated).toBe(false);
    expect(last.after).toBeNull();
  });

  it("defaults to 50 and caps the limit at 200", async () => {
    const values: string[] = [];
    for (let n = 1; n <= 205; n += 1) values.push(`('${ORG}','${OPEN()}',${n},'T${n}','${world.people.admin}')`);
    await pool.query(`insert into tickets (org_id, project_id, number, title, created_by_person_id) values ${values.join(",")}`);
    const byDefault = await as("reader", (tx, p) => service.list(tx, p, OPEN()));
    expect(byDefault.tickets).toHaveLength(50);
    expect(byDefault.truncated).toBe(true);
    const huge = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { limit: 10_000 }));
    expect(huge.tickets).toHaveLength(200);
    expect(huge.after).toBe(200);
    const exact = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { limit: 200, after: 5 }));
    expect(exact.tickets).toHaveLength(200);
    expect(exact.truncated).toBe(false);
  });

  it("under: only the descendants of the ticket, at every level, not the ticket itself", async () => {
    const root = await ticket(OPEN(), 1, "Raiz");
    const a = await ticket(OPEN(), 2, "Nível 1", { parent: root });
    const b = await ticket(OPEN(), 3, "Nível 2", { parent: a });
    await ticket(OPEN(), 4, "Nível 3", { parent: b });
    await ticket(OPEN(), 5, "Irmão da raiz");
    const c = await ticket(OPEN(), 6, "Outro filho da raiz", { parent: root });
    await ticket(OPEN(), 7, "Neto pelo outro", { parent: c });
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN(), { under: 1 })))).toEqual([2, 3, 4, 6, 7]);
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN(), { under: 2 })))).toEqual([3, 4]);
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN(), { under: 4 })))).toEqual([]);
  });

  it("under combines with status and paging", async () => {
    const root = await ticket(OPEN(), 1, "Raiz");
    const a = await ticket(OPEN(), 2, "A", { parent: root, status: "done" });
    await ticket(OPEN(), 3, "B", { parent: a, status: "done" });
    await ticket(OPEN(), 4, "C", { parent: a });
    await ticket(OPEN(), 5, "D", { parent: root, status: "done" });
    const page = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { under: 1, status: ["done"], limit: 2 }));
    expect(nums(page)).toEqual([2, 3]);
    expect(page.truncated).toBe(true);
    const next = await as("reader", (tx, p) => service.list(tx, p, OPEN(), { under: 1, status: ["done"], limit: 2, after: page.after ?? 0 }));
    expect(nums(next)).toEqual([5]);
  });

  it("under a ticket that does not exist, or of another project, is not found", async () => {
    await ticket(OPEN(), 1, "A");
    await ticket(world.projects.priv, 9, "Do privado");
    await expect(as("admin", (tx, p) => service.list(tx, p, OPEN(), { under: 99 }))).rejects.toMatchObject({ status: 404 });
    await expect(as("admin", (tx, p) => service.list(tx, p, OPEN(), { under: 9 }))).rejects.toMatchObject({ status: 404 });
  });
});

describe("overview", () => {
  it("counts the tickets by status and shows the top tickets with progress", async () => {
    const top = await ticket(OPEN(), 1, "Exportação", { description: "Tudo da exportação" });
    const a = await ticket(OPEN(), 2, "CSV", { parent: top, status: "done" });
    await ticket(OPEN(), 3, "Cabeçalho", { parent: a, status: "done" });
    await ticket(OPEN(), 4, "PDF", { parent: top });
    await ticket(OPEN(), 5, "Cancelado", { parent: top, status: "cancelled" });
    await ticket(OPEN(), 6, "Solto", { status: "in_progress" });
    const view = await as("reader", (tx, p) => service.overview(tx, p, OPEN()));
    expect(view.projectKey).toBe("OPEN");
    expect(view.total).toBe(6);
    expect(view.byStatus).toEqual({ todo: 2, in_progress: 1, in_review: 0, done: 2, cancelled: 1 });
    expect(view.top.tickets.map((entry) => entry.number)).toEqual([1, 6]);
    expect(view.top.truncated).toBe(false);
    expect(view.top.tickets[0]).toMatchObject({ key: "OPEN-1", status: "todo", progress: { done: 2, total: 3, excluded: 1 }, descriptionExcerpt: "Tudo da exportação" });
    expect(view.top.tickets[1]?.progress).toBeNull();
  });

  it("com uma ideia no projeto: o progresso do pai não a conta e ideas vale 1 (ADR 0042)", async () => {
    const top = await ticket(OPEN(), 1, "Exportação");
    await ticket(OPEN(), 2, "CSV", { parent: top, status: "done" });
    await ticket(OPEN(), 3, "PDF", { parent: top });
    const idea = await ticket(OPEN(), 4, "Ideia de exportação", { parent: top });
    await ticket(OPEN(), 5, "Dentro da ideia", { parent: idea });
    await pool.query("update tickets set idea_stage = 'new' where id = $1", [idea]);
    const view = await as("reader", (tx, p) => service.overview(tx, p, OPEN()));
    expect(view.top.tickets[0]?.progress).toEqual({ done: 1, total: 2, excluded: 0, ideas: 1 });
  });

  it("is zeroed for an empty project", async () => {
    const view = await as("reader", (tx, p) => service.overview(tx, p, OPEN()));
    expect(view.total).toBe(0);
    expect(view.byStatus).toEqual({ todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 });
    expect(view.top).toEqual({ tickets: [], truncated: false });
  });

  it("caps the top tickets at 200", async () => {
    const values: string[] = [];
    for (let n = 1; n <= 201; n += 1) values.push(`('${ORG}','${OPEN()}',${n},'T${n}','${world.people.admin}')`);
    await pool.query(`insert into tickets (org_id, project_id, number, title, created_by_person_id) values ${values.join(",")}`);
    const view = await as("reader", (tx, p) => service.overview(tx, p, OPEN()));
    expect(view.total).toBe(201);
    expect(view.top.tickets).toHaveLength(200);
    expect(view.top.truncated).toBe(true);
  });
});

describe("permission and isolation", () => {
  const all = (who: Who, projectId: string) => [
    () => as(who, (tx, p) => service.search(tx, p, projectId, "x")),
    () => as(who, (tx, p) => service.ticket(tx, p, projectId, 1)),
    () => as(who, (tx, p) => service.list(tx, p, projectId)),
    () => as(who, (tx, p) => service.overview(tx, p, projectId)),
  ];

  it("a person without access to a private project gets the same not found as a missing project", async () => {
    await ticket(world.projects.priv, 1, "Segredo");
    for (const call of all("plain", world.projects.priv)) await expect(call()).rejects.toMatchObject({ status: 404, message: "Projeto não encontrado." });
    const missing = "00000000-0000-4000-8000-000000000000";
    for (const call of all("plain", missing)) await expect(call()).rejects.toMatchObject({ status: 404, message: "Projeto não encontrado." });
    for (const call of all("admin", missing)) await expect(call()).rejects.toMatchObject({ status: 404, message: "Projeto não encontrado." });
  });

  it("a member of a private project reads it; an organization admin too", async () => {
    await ticket(world.projects.priv, 1, "Segredo");
    for (const who of ["reader", "contributor", "manager", "admin"] as const) {
      expect((await as(who, (tx, p) => service.ticket(tx, p, world.projects.priv, 1))).title).toBe("Segredo");
    }
  });

  it("an archived project can be read", async () => {
    await ticket(OPEN(), 1, "Antigo");
    await pool.query("update projects set archived_at = now() where id = $1", [OPEN()]);
    expect((await as("reader", (tx, p) => service.overview(tx, p, OPEN()))).total).toBe(1);
    expect(nums(await as("reader", (tx, p) => service.list(tx, p, OPEN())))).toEqual([1]);
  });

  it("another organization's project is not found, with the same error, even for its admin", async () => {
    await ticket(world.other.project, 1, "De B", {}, OTHER_ORG);
    for (const call of all("admin", world.other.project)) await expect(call()).rejects.toMatchObject({ status: 404, message: "Projeto não encontrado." });
    // E o inverso: o admin de B não enxerga o projeto aberto de A.
    await ticket(OPEN(), 1, "De A");
    await expect(as("admin", (tx, p) => service.ticket(tx, p, OPEN(), 1), OTHER_ORG)).rejects.toMatchObject({ status: 404 });
  });

  it("the same ticket numbers in two projects never mix", async () => {
    await ticket(OPEN(), 1, "Do aberto");
    await ticket(world.projects.priv, 1, "Do privado");
    expect((await as("admin", (tx, p) => service.ticket(tx, p, OPEN(), 1))).title).toBe("Do aberto");
    expect((await as("admin", (tx, p) => service.ticket(tx, p, world.projects.priv, 1))).title).toBe("Do privado");
    expect(nums(await as("admin", (tx, p) => service.search(tx, p, OPEN(), "privado")))).toEqual([]);
  });
});

describe("only reads", () => {
  it("changes no ticket, relation or event when the four operations run", async () => {
    const root = await ticket(OPEN(), 1, "Raiz");
    await ticket(OPEN(), 2, "Filho", { parent: root });
    await relate(OPEN(), 1, 2, "mentions");
    await relate(OPEN(), 2, 1, "depends_on");
    const snapshot = async () => {
      const counts = await pool.query(
        `select (select count(*) from tickets) as tickets, (select count(*) from ticket_relations) as relations,
                (select count(*) from activity_events) as events,
                (select max(updated_at) from tickets) as ticket_updated, (select max(updated_at) from projects) as project_updated`,
      );
      return counts.rows[0];
    };
    const before = await snapshot();
    await as("contributor", async (tx, p) => {
      await service.search(tx, p, OPEN(), "raiz");
      await service.ticket(tx, p, OPEN(), 1);
      await service.list(tx, p, OPEN(), { under: 1 });
      await service.overview(tx, p, OPEN());
    });
    expect(await snapshot()).toEqual(before);
  });
});

describe("cost", () => {
  /** Conta as operações do Prisma numa transação de tenant (cada `$queryRaw` e cada `find*`/`count` é uma). */
  async function operations(run: (tx: TenantClient, principal: Principal) => Promise<unknown>): Promise<number> {
    let count = 0;
    const counting = prisma.$extends({
      query: {
        $allOperations({ args, query }) {
          count += 1;
          return query(args);
        },
      },
    });
    await withTenant(counting as unknown as PrismaClient, { orgId: ORG, userId: "u_admin" }, async (tx) => {
      const person = await tx.person.findFirstOrThrow({ where: { clerkUserId: "u_admin" } });
      const actor = await authorization.loadActor(tx, person.id, "admin");
      count = 0;
      await run(tx, { session: {}, person, organization: {}, actor } as unknown as Principal);
    });
    return count;
  }

  async function grow(size: number): Promise<void> {
    const root = await ticket(OPEN(), 1, "Raiz");
    let parent = root;
    for (let n = 2; n <= size; n += 1) {
      parent = await ticket(OPEN(), n, `Item ${n}`, { parent: n % 3 === 0 ? root : parent });
      await relate(OPEN(), n, 1, "mentions");
    }
  }
  const measure = () =>
    Promise.all([
      operations((tx, p) => service.search(tx, p, OPEN(), "item")),
      operations((tx, p) => service.ticket(tx, p, OPEN(), 5)),
      operations((tx, p) => service.list(tx, p, OPEN(), { under: 1, status: ["todo"] })),
      operations((tx, p) => service.overview(tx, p, OPEN())),
    ]);

  it("makes a fixed number of queries, however many tickets the project has", async () => {
    await grow(8);
    const small = await measure();
    await truncateAll(pool);
    world = await seedWorld(pool);
    ids.clear();
    await grow(80);
    const large = await measure();
    expect(large).toEqual(small);
    expect(small).toEqual([3, 9, 4, 3]);
  });
});

describe("no person data", () => {
  it("never returns an assignee, an author, a name or an e-mail", async () => {
    const root = await ticket(OPEN(), 1, "Raiz", { description: "Descrição" });
    await ticket(OPEN(), 2, "Filho", { parent: root });
    await relate(OPEN(), 2, 1, "mentions");
    await pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ($1,$2,$3)", [ORG, root, world.people.manager]);
    const outputs = await as("admin", async (tx, p) => [
      await service.search(tx, p, OPEN(), "raiz"),
      await service.ticket(tx, p, OPEN(), 1),
      await service.ticket(tx, p, OPEN(), 2),
      await service.list(tx, p, OPEN()),
      await service.overview(tx, p, OPEN()),
    ]);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(outputs);
    expect([...keys].filter((key) => /assign|creat|author|person|owner|responsible|e-?mail|name|avatar|user/i.test(key))).toEqual([]);
    const text = JSON.stringify(outputs);
    for (const leaked of ["Nome manager", "Nome admin", "@exemplo.test", world.people.manager, world.people.admin]) {
      expect(text).not.toContain(leaked);
    }
  });
});

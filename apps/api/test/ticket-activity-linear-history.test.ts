import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { AI_CONFIG } from "./helpers.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0061, fatia 4 (TREEPM-482), etapa 5: a linha do tempo do ticket traz o histórico importado do Linear como terceira fonte, intercalada
// por data com eventos e comentários, mais duas entradas sintetizadas na leitura (criação no Linear e "criado" na data real, só para ticket
// com origem no Linear) e o resumo da rodada (`history_imported`), somado por rodada.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const ORG = "org_A";
const MIN = 60_000;
const BASE = Date.parse("2026-10-01T12:00:00Z");
const at = (minutes: number): Date => new Date(BASE + minutes * MIN);
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
type Person = { id: string; displayName: string; avatarUrl: string | null };
type Entry = { id: string; type: string; occurredAt: string; actor: Person | null; [k: string]: unknown };
type Page = { entries: Entry[]; before: string | null };

const personId = (who: Who) => h.world().people[who];
const person = (who: Who): Person => ({ id: personId(who), displayName: `Nome ${who}`, avatarUrl: null });
const page = async (id: string, query = "", who: Who = "admin"): Promise<Page> => {
  const res = await h.call("GET", `/api/tickets/${id}/activity${query}`, as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
};
const types = (p: Page) => p.entries.map((e) => e.type);

/** Ticket sem evento de criação (como os que a importação do Linear grava), criado em `createdMin`. */
async function imported(title: string, createdMin: number): Promise<{ id: string; number: number }> {
  const res = await h.call("POST", `/api/projects/${priv()}/tickets/import`, as("manager"), { items: [{ title }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const ticket = (res.body as { id: string; number: number }[])[0] as { id: string; number: number };
  await h.pool.query("update tickets set created_at = $2 where id = $1", [ticket.id, at(createdMin)]);
  return ticket;
}
/** A origem no Linear: data e criador lá (pessoa casada ou nome). */
async function origin(ticketId: string, opts: { createdMin?: number | null; creator?: string | null; creatorName?: string | null } = {}): Promise<void> {
  await h.pool.query(
    "insert into ticket_external_refs (org_id, ticket_id, project_id, provider, kind, external_id, source_snapshot, applied_snapshot, external_created_at, creator_person_id, external_creator_name) values ($1,$2,$3,'linear','issue',$4,'{}','{}',$5,$6,$7)",
    [ORG, ticketId, priv(), `issue-${ticketId}`, opts.createdMin === null ? null : at(opts.createdMin ?? 0), opts.creator ?? null, opts.creatorName ?? null],
  );
}
let seq = 0;
async function history(ticketId: string, minutes: number, changes: unknown[], author: { person?: string; name?: string } = {}, id?: string): Promise<string> {
  seq += 1;
  const rows = await h.pool.query(
    "insert into external_history_entries (org_id, id, project_id, ticket_id, provider, external_id, occurred_at, actor_person_id, external_actor_name, changes) values ($1,coalesce($9::uuid, app_uuid_v7()),$2,$3,'linear',$4,$5,$6,$7,$8) returning id",
    [ORG, priv(), ticketId, `h-${seq}-${ticketId}`, at(minutes), author.person ?? null, author.name ?? null, JSON.stringify(changes), id ?? null],
  );
  return rows.rows[0].id as string;
}
async function event(ticketId: string, minutes: number, kind: string, payload: unknown, actor: string | null = personId("admin")): Promise<string> {
  const rows = await h.pool.query("insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id, payload, occurred_at) values ($1,$2,$3,'ticket',$4,$5,$6) returning id", [ORG, actor, kind, ticketId, JSON.stringify(payload), at(minutes)]);
  return rows.rows[0].id as string;
}
async function comment(ticketId: string, minutes: number, body: string, linearName: string | null = null): Promise<string> {
  const rows = await h.pool.query(
    "insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, external_author_name, body, via, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [ORG, priv(), ticketId, linearName === null ? personId("contributor") : null, linearName, body, linearName === null ? null : "linear", at(minutes)],
  );
  return rows.rows[0].id as string;
}
const status = (from: string | null, to: string | null) => ({ field: "status", from: from === null ? null : { name: from, type: "started" }, to: to === null ? null : { name: to, type: "completed" } });

async function allPages(id: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const p: Page = await page(id, `?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    expect(p.entries.length, `limit ${limit}, página ${pages}`).toBeLessThanOrEqual(limit);
    expect(p.entries.length, `limit ${limit}, página ${pages}`).toBeGreaterThan(0);
    ids.push(...p.entries.map((e) => e.id));
    before = p.before;
    pages += 1;
  } while (before && pages < 60);
  return { ids, pages };
}

describe("histórico do Linear na linha do tempo", () => {
  it("intercala por data as três fontes, com a criação no Linear e o 'criado' nas datas reais", async () => {
    const parent = await imported("Pai", 90);
    const t = await imported("Filho", 100);
    await origin(t.id, { createdMin: 0, creator: personId("manager") });
    const runA = crypto.randomUUID();
    await event(t.id, 120, "ticket.updated", { fields: ["title"], title: { from: "Filho", to: "Filho 2" } });
    await event(t.id, 110, "ticket.history_imported_from_linear", { key: "PRIV-2", count: 2, automatic: true, source: "linear_sync", runId: runA });
    await event(t.id, 109, "ticket.history_imported_from_linear", { key: "PRIV-2", count: 3, automatic: true, source: "linear_sync", runId: runA });
    const h30 = await history(t.id, 30, [{ field: "description" }], { name: "Robô do Linear" });
    const h20 = await history(
      t.id,
      20,
      [
        status("Em revisão", "Pronto"),
        { field: "assignee", from: { personId: personId("contributor") }, to: { name: "Bia no Linear" } },
        { field: "priority", from: 0, to: 300 },
        { field: "title", from: "Antigo", to: "Filho" },
        { field: "parent", from: null, to: { ticketId: parent.id } },
        { field: "project", from: { ticketId: null }, to: { ticketId: UNKNOWN_ID } },
        { field: "description" },
      ],
      { name: "Ana no Linear" },
    );
    const c15 = await comment(t.id, 15, "do Linear", "Carla");
    const h10 = await history(t.id, 10, [status(null, "Pronto"), { field: "assignee", from: null, to: null }], { person: personId("reader") });
    await history(t.id, 5, [], {});

    const p = await page(t.id, "?limit=100");
    expect(types(p)).toEqual(["title_changed", "history_imported", "created", "linear_history", "linear_history", "comment", "linear_history", "linear_created"]);
    expect(p.before).toBeNull();
    const byType = (type: string, n = 0) => p.entries.filter((e) => e.type === type)[n] as Entry;
    expect(byType("history_imported")).toMatchObject({ count: 5, automatic: true, actor: person("admin") });
    expect(byType("created")).toMatchObject({ id: `created:${t.id}`, occurredAt: at(100).toISOString(), actor: person("manager") });
    expect(byType("linear_created")).toEqual({ id: `linear_created:${t.id}`, type: "linear_created", occurredAt: at(0).toISOString(), actor: person("manager") });
    expect(byType("linear_history", 0)).toEqual({ id: h30, type: "linear_history", occurredAt: at(30).toISOString(), actor: null, externalActor: { name: "Robô do Linear" }, changes: [{ field: "description" }] });
    expect(byType("linear_history", 1)).toEqual({
      id: h20,
      type: "linear_history",
      occurredAt: at(20).toISOString(),
      actor: null,
      externalActor: { name: "Ana no Linear" },
      changes: [
        { field: "status", from: { name: "Em revisão", type: "started" }, to: { name: "Pronto", type: "completed" } },
        { field: "assignee", from: { kind: "person", person: person("contributor") }, to: { kind: "linear", name: "Bia no Linear" } },
        { field: "priority", from: 0, to: 300 },
        { field: "title", from: "Antigo", to: "Filho" },
        { field: "parent", from: null, to: { id: parent.id, key: `PRIV-${parent.number}`, title: "Pai" } },
        { field: "project", from: { id: null, key: null, title: null }, to: { id: null, key: null, title: null } },
        { field: "description" },
      ],
    });
    expect(byType("comment").id).toBe(c15);
    expect(byType("linear_history", 2)).toMatchObject({ id: h10, actor: person("reader"), changes: [{ field: "status", from: null }, { field: "assignee", from: null, to: null }] });
    expect(byType("linear_history", 2)).not.toHaveProperty("externalActor");
  });

  it("autor: o criador no Linear sem pessoa sai pelo nome; autor apagado sai com nome nulo; sem data de criação, nada de linear_created", async () => {
    const a = await imported("A", 100);
    await origin(a.id, { createdMin: 0, creatorName: "Dora no Linear" });
    await history(a.id, 10, [{ field: "description" }]);
    const p = await page(a.id);
    expect(p.entries.find((e) => e.type === "linear_created")).toMatchObject({ actor: null, externalActor: { name: "Dora no Linear" } });
    expect(p.entries.find((e) => e.type === "linear_history")).toMatchObject({ actor: null, externalActor: { name: null } });
    const b = await imported("B", 100);
    await origin(b.id, { createdMin: null });
    await history(b.id, 10, [{ field: "description" }]);
    expect(types(await page(b.id))).toEqual(["created", "linear_history"]);
  });

  it("responsável e autor: pessoa inativa aparece pelo nome; pessoa que não existe mais vira null", async () => {
    const t = await imported("T", 100);
    await origin(t.id);
    await h.pool.query("update people set active = false where id = $1", [personId("contributor")]);
    await history(t.id, 10, [{ field: "assignee", from: { personId: personId("contributor") }, to: { personId: UNKNOWN_ID } }], { person: personId("contributor") });
    const entry = (await page(t.id)).entries.find((e) => e.type === "linear_history") as Entry;
    expect(entry.actor).toEqual(person("contributor"));
    expect(entry["changes"]).toEqual([{ field: "assignee", from: { kind: "person", person: person("contributor") }, to: { kind: "person", person: null } }]);
  });

  it("mudança fora do formato é descartada; entrada sem nenhuma mudança válida não aparece; situação de tipo desconhecido sai com tipo nulo", async () => {
    const t = await imported("T", 100);
    await origin(t.id);
    await history(t.id, 30, [{ field: "outra" }, { field: "priority", from: "x", to: 1 }]);
    await history(t.id, 20, [{ field: "priority", from: 100, to: 200 }, { field: "title", from: 1, to: "x" }, "lixo"]);
    await history(t.id, 10, [{ field: "status", from: { name: "Triagem", type: null }, to: { name: "Feito", type: "completed" } }]);
    const p = await page(t.id);
    const linear = p.entries.filter((e) => e.type === "linear_history");
    expect(linear.map((e) => e["changes"])).toEqual([[{ field: "priority", from: 100, to: 200 }], [{ field: "status", from: { name: "Triagem", type: null }, to: { name: "Feito", type: "completed" } }]]);
  });

  it("o resumo da rodada soma os eventos da mesma rodada; rodadas diferentes ficam separadas", async () => {
    const t = await imported("T", 100);
    await origin(t.id);
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [min, run, count] of [[140, a, 1], [139, a, 2], [130, b, 4], [129, b, 5], [128, b, 6]] as const) {
      await event(t.id, min, "ticket.history_imported_from_linear", { key: "PRIV-1", count, automatic: true, source: "linear_sync", runId: run });
    }
    const p = await page(t.id);
    expect(p.entries.filter((e) => e.type === "history_imported").map((e) => e["count"])).toEqual([3, 15]);
    // Cortando a página no meio de uma rodada, a soma não muda.
    const ids = (await allPages(t.id, 1)).ids;
    expect(ids).toEqual(p.entries.map((e) => e.id));
  });

  it("ticket de origem no Linear com evento de criação: o 'criado' vem do evento, sem sintético", async () => {
    const t = await imported("T", 100);
    await origin(t.id, { createdMin: 0 });
    const created = await event(t.id, 100, "ticket.created", {});
    const p = await page(t.id);
    expect(p.entries.filter((e) => e.type === "created").map((e) => e.id)).toEqual([created]);
    expect(types(p)).toEqual(["created", "linear_created"]);
  });

  it("a conversa de uma contribuição não traz histórico nem entradas sintéticas", async () => {
    const t = await imported("T", 100);
    await origin(t.id);
    await history(t.id, 10, [{ field: "description" }]);
    const area = (await h.pool.query("insert into areas (org_id, name) values ($1,'Área') returning id", [ORG])).rows[0].id as string;
    const contribution = (await h.pool.query("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ($1,$2,$3,$4,'x',$5) returning id", [ORG, priv(), t.id, area, personId("manager")])).rows[0].id as string;
    expect((await page(t.id, `?contribution=${contribution}`)).entries).toEqual([]);
  });

  it("ticket nativo fica como antes: 'criado' por último, mesmo com comentário mais antigo que ele", async () => {
    const t = await imported("Nativo", 100);
    const c = await comment(t.id, 50, "mais antigo que o ticket");
    const p = await page(t.id);
    expect(p.entries.map((e) => [e.type, e.id])).toEqual([["comment", c], ["created", `created:${t.id}`]]);
    expect(p.entries[1]?.occurredAt).toBe(at(100).toISOString());
  });
});

describe("paginação com as três fontes e as entradas sintéticas", () => {
  /** Ticket com entradas no mesmo instante de cada sintética e de um lado e do outro delas. */
  async function crowded(): Promise<string> {
    const t = await imported("Cheio", 100);
    await origin(t.id, { createdMin: 0, creatorName: "Ana" });
    const run = crypto.randomUUID();
    // No mesmo instante da criação no Linear (0) e do "criado" (100), e entre elas.
    for (const min of [0, 0, 1, 50, 99, 100, 100, 101, 150]) await history(t.id, min, [{ field: "priority", from: 0, to: 100 + min }], { name: "Ana" });
    // No mesmo instante de cada sintética, mas com id MENOR que o do ticket: fica depois dela na ordem (abaixo), e o cursor que aponta
    // para a sintética precisa trazê-la na página seguinte.
    await history(t.id, 0, [{ field: "title", from: "x", to: "y" }], { name: "Ana" }, "00000000-0000-7000-8000-00000000000a");
    await history(t.id, 100, [{ field: "title", from: "x", to: "y" }], { name: "Ana" }, "00000000-0000-7000-8000-00000000000b");
    for (const min of [0, 100, 100, 120]) await comment(t.id, min, `c${min}`);
    for (const min of [100, 100, 130]) await event(t.id, min, "ticket.updated", { fields: ["title", "status", "priority"], title: { from: "a", to: "b" }, status: { from: "todo", to: "done" }, priority: { from: 0, to: 100 } });
    for (const [min, count] of [[140, 1], [140, 2], [141, 3]] as const) await event(t.id, min, "ticket.history_imported_from_linear", { key: "PRIV-1", count, automatic: true, source: "linear_sync", runId: run });
    // Edições da descrição seguidas que se juntam, no meio do histórico.
    for (const min of [102, 103, 104]) await event(t.id, min, "ticket.updated", { fields: ["description"] });
    return t.id;
  }

  it("qualquer tamanho de página: sem perder nem repetir, cortando em cada entrada (inclusive nas sintéticas)", async () => {
    const id = await crowded();
    const whole = await page(id, "?limit=100");
    expect(whole.before).toBeNull();
    const n = whole.entries.length;
    expect(types(whole)).toContain("linear_created");
    expect(types(whole)).toContain("created");
    // Os dois de id baixo ficam logo abaixo de cada sintética; a criação no Linear não é a última.
    const ids = whole.entries.map((e) => e.id);
    expect(ids[ids.indexOf(`linear_created:${id}`) + 1]).toBe("00000000-0000-7000-8000-00000000000a");
    expect(ids[ids.indexOf(`created:${id}`) + 1]).toBe("00000000-0000-7000-8000-00000000000b");
    expect(whole.entries.filter((e) => e.type === "history_imported").map((e) => e["count"])).toEqual([6]);
    for (let limit = 1; limit <= n + 1; limit += 1) {
      const { ids, pages } = await allPages(id, limit);
      expect(ids, `limit ${limit}`).toEqual(whole.entries.map((e) => e.id));
      expect(pages, `limit ${limit}`).toBe(Math.ceil(n / limit));
    }
  });

  it("o cursor que aponta para cada sintética continua dali", async () => {
    const id = await crowded();
    const whole = await page(id, "?limit=100");
    for (const synthetic of ["created", "linear_created"]) {
      const index = whole.entries.findIndex((e) => e.type === synthetic);
      expect(index, synthetic).toBeLessThan(whole.entries.length - 1);
      const upTo = await page(id, `?limit=${index + 1}`);
      expect(upTo.entries.at(-1)?.type).toBe(synthetic);
      const rest = await page(id, `?limit=100&before=${encodeURIComponent(upTo.before as string)}`);
      expect(rest.entries.map((e) => e.id)).toEqual(whole.entries.slice(index + 1).map((e) => e.id));
    }
  });
});

import { describe, expect, it } from "vitest";
import { TEAM_ENG, expectRelationOriginsCoherent, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeRelation, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Sincronizar com o Linear, fatia 3: relações (ADR 0061, seções 3, 4 e 7; TREEPM-478), de ponta a ponta com `fetch` falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean>; waitUntil?: string | null };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

const LETTERS = "abcdefghijkl".split("");
/** 12 issues: a..l (ENG-1..ENG-12), nesta ordem (a primeira página lida é esta). */
const ISSUES = (): FakeIssue[] => LETTERS.map((id, i) => ({ id, identifier: `ENG-${i + 1}`, title: id.toUpperCase() }));
/**
 * A bloqueia B, B bloqueia C, C bloqueia A (a última fecharia o ciclo); D relacionado a E; F duplicata de G; H bloqueia issue de outro
 * time; I bloqueia J (já existe à mão); K bloqueia L; L com 25 relações: 14 com issues de outro time e 11 com A..K (as 5 últimas, G..K,
 * só vêm na página seguinte da issue).
 */
const RELATIONS = (): FakeRelation[] => [
  { id: "r-ab", type: "blocks", from: "a", to: "b" },
  { id: "r-bc", type: "blocks", from: "b", to: "c" },
  { id: "r-ca", type: "blocks", from: "c", to: "a" },
  { id: "r-de", type: "related", from: "d", to: "e" },
  { id: "r-fg", type: "duplicate", from: "f", to: "g" },
  { id: "r-hx", type: "blocks", from: "h", to: "x-outro" },
  { id: "r-ij", type: "blocks", from: "i", to: "j" },
  { id: "r-kl", type: "blocks", from: "k", to: "l" },
  { id: "r-sim", type: "similar", from: "a", to: "k" },
  ...Array.from({ length: 14 }, (_, i): FakeRelation => ({ id: `r-lo${i}`, type: "related", from: "l", to: `x-o${i}` })),
  ...LETTERS.slice(0, 11).map((to): FakeRelation => ({ id: `r-l${to}`, type: "related", from: "l", to })),
];

async function finish(run: RunBody, steps = 200): Promise<RunBody> {
  for (let i = 0; i < steps; i += 1) {
    const res = await post(`/${run.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) {
      await expectRelationOriginsCoherent(h.pool);
      return res.body;
    }
  }
  throw new Error("não terminou");
}
const sync = async (): Promise<RunBody> => {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return finish(run.body);
};
const ticketOf = async (letter: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [letter]))[0]!["ticket_id"] as string;
/** As relações locais como texto (`b>a` = b depende de a; `d~e` = relacionado), em ordem. */
async function links(): Promise<string[]> {
  const rows = await q(`select f.external_id f, t.external_id t, r.kind from ticket_relations r
    join ticket_external_refs f on f.ticket_id = r.from_ticket_id join ticket_external_refs t on t.ticket_id = r.to_ticket_id where r.kind <> 'mentions'`);
  return rows.map((row) => (row["kind"] === "related" ? [row["f"], row["t"]].sort().join("~") : `${row["f"]}>${row["t"]}`)).sort();
}
const relationEvents = async (): Promise<{ n: number; total: number }> => {
  const row = (await q("select count(*)::int n, coalesce(sum((payload->>'count')::int), 0)::int total from activity_events where kind = 'ticket.relations_imported_from_linear'"))[0] as Row;
  return { n: row["n"] as number, total: row["total"] as number };
};
const origin = async (relationId: string): Promise<Row[]> => q("select * from external_item_refs where kind = 'relation' and external_id like $1 order by first_imported_at, id", [`${relationId}:%`]);
const EXPECTED = ["b>a", "c>b", "d~e", "f~g", "j>i", "l>k", ...LETTERS.slice(0, 11).map((x) => `${x}~l`)].sort();

/** Importa as 12 issues SEM relações e cria à mão "J depende de I" (antes de o Linear trazer a mesma). */
async function importWithoutRelations(): Promise<FakeTeamData> {
  const team: FakeTeamData = { projects: [], issues: ISSUES(), relations: [] };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
  expect((await sync()).phase).toBe("done");
  const added = await h.call("POST", `/api/tickets/${await ticketOf("j")}/dependencies`, as("admin"), { ticketId: await ticketOf("i") });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  return team;
}

describe("a sincronização traz as relações", () => {
  it("projeto importado antes desta fatia: blocks vira depende de, related e duplicate viram relacionado (uma linha), o ciclo e o resto ficam de fora", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    const done = await sync();
    expect(done.phase).toBe("done");
    expect(await links()).toEqual(EXPECTED);
    // 16 criadas (b>a, c>b, l>k e 13 relacionadas), 1 adotada (j>i), 1 recusada por ciclo (a>c), 16 ignoradas (similar, H e as 14 de L com outro time).
    expect(done.counts).toMatchObject({ relationsCreated: 16, relationsAdopted: 1, relationsCycle: 1, relationsSkipped: 16 });
    expect((await q("select count(*)::int n from ticket_relations where kind = 'related'"))[0]).toEqual({ n: 13 });
    // A adotada não ganha evento; a recusada não ganha origem (volta a tentar quando o ciclo se desfizer).
    expect(await origin("r-ca")).toHaveLength(0);
    expect((await origin("r-ij"))[0]).toMatchObject({ removed_here_at: null, missing_since: null });
    // `applied`: o tipo do TreePM, os ids do Linear e os tickets das duas pontas (para "removida aqui" × ticket apagado).
    expect((await origin("r-lk"))[0]!["applied"]).toEqual({ type: "related", relationId: "r-lk", issueId: "l", relatedIssueId: "k", issueTicketId: await ticketOf("l"), relatedIssueTicketId: await ticketOf("k") });
    // Um evento por ticket por página: depende de conta no dependente, relacionado nos dois (3 + 2 × 13).
    expect(await relationEvents()).toEqual({ n: 12, total: 29 });
    // Sem evento por ligação, como na tela.
    expect((await q("select count(*)::int n from activity_events where kind = 'ticket.dependency_added'"))[0]).toEqual({ n: 1 });
    // "Bloqueado" olha só depende de: b, c, j e l (j já estava, pela ligação feita à mão).
    const tickets = (await h.call("GET", `/api/projects/${open()}/tickets`, as("admin"))).body as { tickets?: Row[] } | Row[];
    const list = (Array.isArray(tickets) ? tickets : (tickets.tickets ?? [])) as Row[];
    expect(list.filter((ticket) => ticket["blocked"] === true)).toHaveLength(4);
  });

  it("a página do ticket mostra Depende de, Bloqueia e Relacionado a nos dois tickets, com a marca do Linear só nas importadas", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    await sync();
    const page = async (letter: string): Promise<Row> => (await h.call("GET", `/api/tickets/${await ticketOf(letter)}`, as("admin"))).body as Row;
    const d = await page("d");
    const e = await page("e");
    expect((d["related"] as Row[]).map((link) => link["key"])).toEqual(expect.arrayContaining([`${(e["key"] as string)}`]));
    expect((e["related"] as Row[]).map((link) => link["key"])).toContain(d["key"]);
    expect((d["related"] as Row[])[0]).toMatchObject({ fromLinear: true });
    const b = await page("b");
    expect(b["dependsOn"]).toEqual([expect.objectContaining({ fromLinear: true })]);
    // A ligação feita à mão (e depois adotada pela origem) também é do Linear agora? Não: continua sem a marca, foi criada aqui.
    expect((await page("j"))["dependsOn"]).toEqual([expect.objectContaining({ fromLinear: false })]);
    expect((await page("i"))["blocks"]).toEqual([expect.objectContaining({ fromLinear: false })]);
    // A linha do tempo resume a rodada ("N relações trazidas do Linear") e mostra a remoção de "relacionado a" com o outro ticket.
    const activity = async (letter: string): Promise<Row[]> => (await h.call("GET", `/api/tickets/${await ticketOf(letter)}/activity?limit=100`, as("admin"))).body.entries as Row[];
    expect((await activity("l")).filter((entry) => entry["type"] === "relations_imported")).toEqual([expect.objectContaining({ count: 12, automatic: true })]);
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("d")}/related/${await ticketOf("e")}`, as("admin"))).status).toBeLessThan(300);
    expect((await activity("d")).find((entry) => entry["type"] === "related_removed")).toMatchObject({ ticket: expect.objectContaining({ key: e["key"] }) });
  });
});

describe("as sincronizações seguintes", () => {
  it("repetida fica quieta; removida aqui não volta; apagada no Linear ganha missing_since e fica; trocada de tipo no Linear atualiza aqui", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    await sync();
    const events = await relationEvents();
    const rows = (await q("select count(*)::int n from ticket_relations"))[0];
    const quiet = await sync();
    expect(quiet.counts).toMatchObject({ relationsCreated: 0, relationsAdopted: 0, relationsCycle: 1, relationsMissing: 0 });
    expect(await relationEvents()).toEqual(events);
    expect((await q("select count(*)::int n from ticket_relations"))[0]).toEqual(rows);

    // Removidas aqui: l>k (tela) e d~e (tela). Apagada no Linear: f~g. Trocada de tipo no mesmo id: r-ab vira related.
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("l")}/dependencies/${await ticketOf("k")}`, as("admin"))).status).toBeLessThan(300);
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("d")}/related/${await ticketOf("e")}`, as("admin"))).status).toBeLessThan(300);
    expect((await origin("r-kl"))[0]).toMatchObject({ local_id: null });
    expect((await origin("r-kl"))[0]!["removed_here_at"]).not.toBeNull();
    expect((await origin("r-de"))[0]!["removed_here_at"]).not.toBeNull();
    team.relations = (team.relations ?? []).filter((r) => r.id !== "r-fg").map((r) => (r.id === "r-ab" ? { ...r, type: "related" } : r));
    const done = await sync();
    // r-ab editada no Linear (blocks → related, mesmo id): a forma nova entra no lugar da antiga (R2); só r-fg sumiu de lá. Sem b>a,
    // a>c (r-ca, antes recusada por ciclo) deixa de fechar ciclo e entra.
    expect(done.counts).toMatchObject({ relationsCreated: 1, relationsCycle: 0, relationsUpdated: 1, relationsMissing: 1 });
    const now = await links();
    expect(now).not.toContain("l>k");
    expect(now).not.toContain("d~e");
    expect(now).not.toContain("b>a");
    // Apagada lá: fica aqui, com a origem marcada.
    expect(now).toEqual(expect.arrayContaining(["f~g", "a~b", "a>c"]));
    expect((await origin("r-fg"))[0]!["missing_since"]).not.toBeNull();
    const ab = await origin("r-ab");
    expect(ab).toHaveLength(2);
    // A forma antiga não "sumiu do Linear": virou a nova (sem linha local, sem `missing_since`).
    expect(ab[0]).toMatchObject({ missing_since: null, local_id: null });
    expect((ab[0]!["applied"] as Row)["superseded"]).toBe(true);
    expect(ab[1]).toMatchObject({ missing_since: null });
  });

  it("related ↔ duplicate no mesmo id não muda nada; o ciclo desfeito aqui deixa a recusada entrar", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    await sync();
    team.relations = (team.relations ?? []).map((r) => (r.id === "r-de" ? { ...r, type: "duplicate" } : r));
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("c")}/dependencies/${await ticketOf("b")}`, as("admin"))).status).toBeLessThan(300);
    const done = await sync();
    expect(done.counts).toMatchObject({ relationsCreated: 1, relationsCycle: 0, relationsMissing: 0 });
    expect(await links()).toContain("a>c");
    expect(await links()).not.toContain("c>b");
  });

  it("todas apagadas no Linear (issues lidas, nenhuma relação): as origens ganham missing_since e as ligações ficam", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    await sync();
    team.relations = [];
    const done = await sync();
    expect(done.counts).toMatchObject({ relationsMissing: 17, relationsInvalid: 0 });
    expect(await links()).toEqual(EXPECTED);
  });

  it("ticket apagado aqui: a relação some com ele; reimportado, ela volta com ele", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    await sync();
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("e")}`, as("admin"))).status).toBeLessThan(300);
    expect(await links()).not.toContain("d~e");
    await sync();
    expect(await links()).toContain("d~e");
  });
});

describe("idempotência", () => {
  it("duas abas no mesmo passo, o limite de taxa no meio e o passo repetido não duplicam nada", async () => {
    const team = await importWithoutRelations();
    let limited = false;
    Object.assign(team, {
      relations: RELATIONS(),
      relationsOverride: () => {
        if (limited) return undefined;
        limited = true;
        return { status: 429, headers: { "Retry-After": "30" }, body: {} };
      },
    });
    const run = (await post("", {})).body as RunBody;
    let waited = false;
    for (let i = 0; i < 200; i += 1) {
      const [one, two] = await Promise.all([post(`/${run.id}/step`), post(`/${run.id}/step`)]);
      for (const res of [one, two]) expect([200, 409], JSON.stringify(res.body)).toContain(res.status);
      const body = (one.status === 200 ? one.body : two.body) as RunBody;
      if (body.waitUntil) {
        waited = true;
        await q("update external_import_runs set wait_until = null where id = $1", [run.id]);
      }
      if (body.done) break;
    }
    expect(waited).toBe(true);
    expect(await links()).toEqual(EXPECTED);
    expect(await relationEvents()).toEqual({ n: 12, total: 29 });
  });

  it("rodada abandonada na fase relations e sincronizada de novo: tudo entra uma vez, coberto por evento", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    // Página de 6 issues: a rodada para no meio das relações.
    const run = (await post("", {})).body as RunBody;
    await q("update external_import_runs set page_size = 6 where id = $1", [run.id]);
    let res = await post(`/${run.id}/step`);
    for (let i = 0; i < 50 && (res.body as RunBody).phase !== "relations"; i += 1) res = await post(`/${run.id}/step`);
    await q("update external_import_runs set page_size = 6 where id = $1", [run.id]);
    res = await post(`/${run.id}/step`);
    expect((res.body as RunBody).phase).toBe("relations");
    expect((await post(`/${run.id}/abandon`)).status).toBeLessThan(300);
    const partial = await relationEvents();
    expect(partial.total).toBeGreaterThan(0);
    await sync();
    expect(await links()).toEqual(EXPECTED);
    expect((await relationEvents()).total).toBe(29);
  });

  it("leitura incompleta (nó fora do formato) não marca nada como apagado no Linear", async () => {
    const team = await importWithoutRelations();
    team.relations = RELATIONS();
    await sync();
    team.relations = [{ id: "r-\u0000", type: "blocks", from: "a", to: "b" }];
    const done = await sync();
    expect(done.counts).toMatchObject({ relationsMissing: 0, relationsInvalid: 1 });
    expect((await q("select count(*)::int n from external_item_refs where kind = 'relation' and missing_since is not null"))[0]).toEqual({ n: 0 });
  });
});

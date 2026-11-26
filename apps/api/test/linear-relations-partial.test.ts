import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINEAR_ERROR_SENTINEL, TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeRelation, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// ADR 0061, fatia 3 (TREEPM-478), correção R2 item 1: `relatedIssue` é `Issue!`. Quando a chave não enxerga uma ponta, o Linear responde 200
// com `errors`. R3: se o `data` veio e valida, ele é usado (nós nulos contam como pulados). Com `data` nulo ou que não valida, é erro
// REDUTÍVEL: a página cai pela metade até 1 issue; com 1 issue ainda falhando, as relações dela ficam de fora (contam em
// `relationsTruncated`) e o cursor anda; 10 issues assim seguidas encerram a fase. A rodada nunca fica presa.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const issues = (ids: string[]): FakeIssue[] => ids.map((id, i) => ({ id, identifier: `ENG-${i + 1}`, title: `T ${i + 1}` }));
const ids120 = Array.from({ length: 120 }, (_, i) => `i${String(i).padStart(3, "0")}`);

/** Cada passo tem de responder 200: a resposta com `errors` não conta como erro da rodada. Guarda as respostas para o teste do vazamento. */
async function sync(responses: string[] = []): Promise<RunBody> {
  const started = await post("", {});
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  responses.push(JSON.stringify(started.body));
  for (let i = 0; i < 400; i += 1) {
    const res = await post(`/${String(started.body.id)}/step`);
    responses.push(JSON.stringify(res.body));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
async function links(): Promise<string[]> {
  const rows = await q(`select f.external_id f, t.external_id t, r.kind from ticket_relations r
    join ticket_external_refs f on f.ticket_id = r.from_ticket_id join ticket_external_refs t on t.ticket_id = r.to_ticket_id where r.kind <> 'mentions'`);
  return rows.map((row) => (row["kind"] === "related" ? [row["f"], row["t"]].sort().join("~") : `${row["f"]}>${row["t"]}`)).sort();
}
async function setup(ids: string[], relations: FakeRelation[], extra: Partial<FakeTeamData> = {}): Promise<FakeTeamData> {
  const team: FakeTeamData = { projects: [], issues: issues(ids), relations, ...extra };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
  return team;
}
/** Uma relação `related` de cada issue com a seguinte (i000~i001, i001~i002, …). */
const chain = (ids: string[]): FakeRelation[] => ids.slice(0, -1).map((id, i) => ({ id: `r-${id}`, type: "related", from: id, to: ids[i + 1] as string }));
const pair = (a: string, b: string): string => [a, b].sort().join("~");

afterEach(() => vi.restoreAllMocks());

describe("resposta com `errors` na página de relações", () => {
  it("uma issue envenenada no meio de 120: a rodada chega a `done`, as relações das outras entram e nada ganha `missing_since`", async () => {
    const team = await setup(ids120, []);
    await sync();
    team.relations = chain(ids120);
    team.poisoned = ["i060"];
    const done = await sync();
    expect(done.phase).toBe("done");
    // Só as relações da issue envenenada (i060~i061) ficam de fora.
    const expected = chain(ids120).filter((r) => r.from !== "i060").map((r) => pair(r.from, r.to)).sort();
    expect(await links()).toEqual(expected);
    expect(done.counts).toMatchObject({ relationsCreated: 118, relationsTruncated: 1 });
    expect(done.counts?.["missingNotChecked"]).toBeUndefined();
    // A relação da envenenada já existia aqui (rodada anterior sem veneno): continua, sem `missing_since`.
    team.poisoned = [];
    await sync();
    team.poisoned = ["i060"];
    const again = await sync();
    expect(again.phase).toBe("done");
    expect(again.counts).toMatchObject({ relationsMissing: 0, relationsTruncated: 1 });
    expect(await q("select count(*)::int n from external_item_refs where kind = 'relation' and missing_since is not null")).toEqual([{ n: 0 }]);
    expect(await links()).toEqual(chain(ids120).map((r) => pair(r.from, r.to)).sort());
  });

  it("todas envenenadas: a rodada termina, sem relação nenhuma e sem marcar nada (para nas 10 seguidas: R3, item 3)", async () => {
    const ids = ids120.slice(0, 12);
    const team = await setup(ids, chain(ids));
    await sync();
    expect(await links()).toHaveLength(11);
    team.poisoned = [...ids];
    const done = await sync();
    expect(done.phase).toBe("done");
    expect(done.counts).toMatchObject({ relationsTruncated: 10, relationsCreated: 0, relationsMissing: 0 });
    expect(await q("select count(*)::int n from external_item_refs where kind = 'relation' and missing_since is not null")).toEqual([{ n: 0 }]);
    expect(await links()).toHaveLength(11);
  });

  it("página extra de uma issue com `errors`: só aquela issue fica pela metade; as outras issues com mais de 20 continuam", async () => {
    const ids = ids120.slice(0, 60);
    // i000 e i001 têm 25 relações cada (as 5 últimas só na página extra); a extra de i000 vem com `errors`.
    const relations: FakeRelation[] = ["i000", "i001"].flatMap((from, f) => Array.from({ length: 25 }, (_, k): FakeRelation => ({ id: `r-${from}-${k}`, type: "related", from, to: ids[10 + f * 25 + k] as string })));
    await setup(ids, relations, { poisonedExtra: ["i000"] });
    const done = await sync();
    expect(done.phase).toBe("done");
    expect(done.counts).toMatchObject({ relationsCreated: 45, relationsTruncated: 1 });
    expect((await links()).filter((link) => link.includes("i001"))).toHaveLength(25);
  });

  it("o texto do erro do Linear não vai a log, resposta, evento nem à rodada", async () => {
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
      vi.spyOn(Logger, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    }
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    const ids = ids120.slice(0, 30);
    const relations = [...chain(ids), ...Array.from({ length: 25 }, (_, k): FakeRelation => ({ id: `r-x-${k}`, type: "blocks", from: "i029", to: ids[k] as string }))];
    await setup(ids, relations, { poisoned: ["i010"], poisonedExtra: ["i029"] });
    const responses: string[] = [];
    expect((await sync(responses)).phase).toBe("done");
    const stored = JSON.stringify([await q("select * from external_import_runs"), await q("select * from activity_events"), await q("select * from external_item_refs")]);
    for (const text of [lines.join("\n"), responses.join("\n"), stored]) expect(text).not.toContain(LINEAR_ERROR_SENTINEL);
  });

  it("erro de rede, 5xx e limite de taxa continuam como antes (a rodada não anda)", async () => {
    const ids = ids120.slice(0, 3);
    const team = await setup(ids, chain(ids));
    let reply: "500" | "429" | null = "500";
    team.relationsOverride = () => (reply === "500" ? { status: 500, body: { errors: [{ message: "boom" }] } } : reply === "429" ? { status: 429, headers: { "Retry-After": "30" }, body: {} } : undefined);
    const started = await post("", {});
    let body = started.body as RunBody;
    for (let i = 0; i < 40 && body.phase !== "relations"; i += 1) body = (await post(`/${String(started.body.id)}/step`)).body as RunBody;
    expect(body.phase).toBe("relations");
    const failed = await post(`/${String(started.body.id)}/step`);
    expect(failed.status).toBe(503);
    reply = "429";
    const limited = await post(`/${String(started.body.id)}/step`);
    expect(limited.status).toBe(200);
    expect((limited.body as RunBody)["waitUntil"]).not.toBeNull();
    expect((await q("select phase, cursor from external_import_runs where id = $1", [started.body.id]))[0]).toEqual({ phase: "relations", cursor: null });
  });

  it("`errors` com `data` que valida (R3, item 3): o `data` vale; a rodada lê tudo e marca o que sumiu", async () => {
    const team = await setup(ids120, chain(ids120));
    await sync();
    expect(await links()).toHaveLength(119);
    // Toda consulta de relações responde 200 com `errors` E com o `data` completo e válido.
    team.relations = chain(ids120).slice(1);
    let relationCalls = 0;
    team.relationsOverride = (call, ask) => {
      if (!call.query.includes("relations(first")) return undefined;
      relationCalls += 1;
      const start = ask.after === null ? 0 : Number(ask.after);
      const end = start + ask.first;
      const nodes = team.issues.slice(start, end).map((issue) => ({ id: issue.id, relations: { nodes: (team.relations ?? []).filter((r) => r.from === issue.id).map((r) => ({ id: r.id, type: r.type, relatedIssue: { id: r.to } })), pageInfo: { hasNextPage: false, endCursor: null } } }));
      return { body: { data: { team: { issues: { nodes, pageInfo: { hasNextPage: end < team.issues.length, endCursor: end < team.issues.length ? String(end) : null } } } }, errors: [{ message: LINEAR_ERROR_SENTINEL, extensions: { code: "INTERNAL_SERVER_ERROR", userPresentableMessage: LINEAR_ERROR_SENTINEL } }] } };
    };
    const responses: string[] = [];
    const done = await sync(responses);
    expect(done.phase).toBe("done");
    expect(relationCalls).toBe(5); // 120 issues em páginas de 25: nada de redução
    expect(done.counts).toMatchObject({ relationsSeen: 118, relationsTruncated: 0, relationsMissing: 1 });
    expect(done.counts?.["missingNotChecked"]).toBeUndefined();
    const stored = JSON.stringify([await q("select * from external_import_runs"), await q("select * from activity_events"), await q("select * from external_item_refs")]);
    for (const text of [responses.join("\n"), stored]) expect(text).not.toContain(LINEAR_ERROR_SENTINEL);
  });

  it("10 issues ilegíveis SEGUIDAS encerram a fase (120 envenenadas: poucos passos, o resto não lido, nada marcado)", async () => {
    const team = await setup(ids120, chain(ids120));
    await sync();
    team.poisoned = [...ids120];
    let calls = 0;
    team.relationsOverride = () => void (calls += 1) as undefined;
    const started = await post("", {});
    let body = started.body as RunBody;
    let relationSteps = 0;
    for (let i = 0; i < 400 && !body.done; i += 1) {
      if (body.phase === "relations") relationSteps += 1;
      const res = await post(`/${String(started.body.id)}/step`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      body = res.body as RunBody;
    }
    expect(body.phase).toBe("done");
    expect(relationSteps).toBeLessThanOrEqual(15);
    expect(calls).toBeLessThanOrEqual(30);
    expect(body.counts).toMatchObject({ relationsTruncated: 10, relationsMissing: 0, relationsCreated: 0 });
    expect(body.counts?.["missingNotChecked"]).toBeUndefined();
    expect(await q("select count(*)::int n from external_item_refs where kind = 'relation' and missing_since is not null")).toEqual([{ n: 0 }]);
    expect(await links()).toHaveLength(119);
  });

  it("uma issue legível no meio zera a conta: 9 ilegíveis, 1 legível, 9 ilegíveis lê até o fim", async () => {
    const ids = ids120.slice(0, 25);
    const team = await setup(ids, chain(ids));
    await sync();
    team.poisoned = [...ids.slice(0, 9), ...ids.slice(10, 19)];
    const done = await sync();
    expect(done.phase).toBe("done");
    // As 18 ilegíveis contam; a legível (i009) e as 6 do fim (i019…i024) são lidas.
    expect(done.counts).toMatchObject({ relationsTruncated: 18, relationsMissing: 0 });
    expect(done.counts?.["relationsSeen"]).toBe(6);
  });
});

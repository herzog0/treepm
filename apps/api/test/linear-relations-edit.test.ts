import { describe, expect, it } from "vitest";
import { TEAM_ENG, expectRelationOriginsCoherent, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeRelation, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// ADR 0061, seção 3 (fatia 3; TREEPM-478), correções R2:
// - item 2: a relação editada no Linear (mesmo id, outra forma: sentido, ponta ou tipo) atualiza aqui;
// - item 3: "removida aqui não volta" vale enquanto os DOIS tickets são os mesmos; ticket apagado aqui e importado de novo é ticket novo.
// Correções R3: a linha que duas relações do Linear compartilham só sai quando a ÚLTIMA delas é editada; "removida aqui" só passa à forma
// nova no MESMO par; e, depois de cada sincronização, o estado das origens é coerente (`expectRelationOriginsCoherent`).
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
const issues = (ids: string[]): FakeIssue[] => ids.map((id, i) => ({ id, identifier: `ENG-${i + 1}`, title: id.toUpperCase() }));

async function sync(): Promise<RunBody> {
  const started = await post("", {});
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  for (let i = 0; i < 200; i += 1) {
    const res = await post(`/${String(started.body.id)}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) {
      await expectRelationOriginsCoherent(h.pool);
      return res.body;
    }
  }
  throw new Error("não terminou");
}
const ticketOf = async (id: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [id]))[0]!["ticket_id"] as string;
async function links(): Promise<string[]> {
  const rows = await q(`select f.external_id f, t.external_id t, r.kind from ticket_relations r
    join ticket_external_refs f on f.ticket_id = r.from_ticket_id join ticket_external_refs t on t.ticket_id = r.to_ticket_id where r.kind <> 'mentions'`);
  return rows.map((row) => (row["kind"] === "related" ? [row["f"], row["t"]].sort().join("~") : `${row["f"]}>${row["t"]}`)).sort();
}
async function setup(relations: FakeRelation[], ids = ["a", "b", "c", "d", "e"]): Promise<FakeTeamData> {
  const team: FakeTeamData = { projects: [], issues: issues(ids), relations };
  await linkWithData(h, put, open(), { [TEAM_ENG.id]: team });
  return team;
}
const missing = async (): Promise<number> => (await q("select count(*)::int n from external_item_refs where kind = 'relation' and missing_since is not null"))[0]!["n"] as number;
const eventKinds = async (): Promise<string[]> => (await q("select distinct kind from activity_events where kind like '%relat%' or kind like '%dependenc%' order by kind")).map((row) => row["kind"] as string);
const blocks = (id: string, from: string, to: string): FakeRelation => ({ id, type: "blocks", from, to });

describe("relação editada no Linear (mesmo id, outra forma)", () => {
  it("sentido invertido: a linha antiga sai, a nova entra (a antiga não conta para o ciclo); repetida fica quieta e nada ganha missing_since", async () => {
    const team = await setup([blocks("r-1", "a", "b")]);
    await sync();
    expect(await links()).toEqual(["b>a"]);
    team.relations = [blocks("r-1", "b", "a")];
    const done = await sync();
    expect(await links()).toEqual(["a>b"]);
    expect(done.counts).toMatchObject({ relationsUpdated: 1, relationsCreated: 0, relationsCycle: 0, relationsMissing: 0 });
    const again = await sync();
    expect(again.counts).toMatchObject({ relationsUpdated: 0, relationsCreated: 0, relationsCycle: 0, relationsMissing: 0 });
    expect(await links()).toEqual(["a>b"]);
    expect(await missing()).toBe(0);
    // Evento: no máximo o resumido de sempre (nada de "dependência adicionada/removida" por ligação).
    expect(await eventKinds()).toEqual(["ticket.relations_imported_from_linear"]);
  });

  it("ida e volta: A bloqueia B, B bloqueia A, A bloqueia B de novo", async () => {
    const team = await setup([blocks("r-1", "a", "b")]);
    await sync();
    team.relations = [blocks("r-1", "b", "a")];
    await sync();
    team.relations = [blocks("r-1", "a", "b")];
    const done = await sync();
    expect(await links()).toEqual(["b>a"]);
    expect(done.counts).toMatchObject({ relationsUpdated: 1, relationsCycle: 0 });
    expect(await missing()).toBe(0);
    expect(await q("select count(*)::int n from external_item_refs where kind = 'relation' and local_id is not null")).toEqual([{ n: 1 }]);
  });

  it("troca de ponta e troca blocks ↔ related", async () => {
    const team = await setup([blocks("r-1", "a", "b"), { id: "r-2", type: "related", from: "c", to: "d" }]);
    await sync();
    expect(await links()).toEqual(["b>a", "c~d"]);
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "c", "d")];
    const done = await sync();
    expect(await links()).toEqual(["c>a", "d>c"]);
    expect(done.counts).toMatchObject({ relationsUpdated: 2, relationsMissing: 0 });
    team.relations = [{ id: "r-1", type: "duplicate", from: "a", to: "c" }, blocks("r-2", "c", "d")];
    expect((await sync()).counts).toMatchObject({ relationsUpdated: 1 });
    expect(await links()).toEqual(["a~c", "d>c"]);
    expect(await missing()).toBe(0);
  });

  it("removida aqui antes da edição: a forma nova também não entra (herda a marca)", async () => {
    const team = await setup([blocks("r-1", "a", "b")]);
    await sync();
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("b")}/dependencies/${await ticketOf("a")}`, as("admin"))).status).toBeLessThan(300);
    team.relations = [blocks("r-1", "b", "a")];
    const done = await sync();
    expect(await links()).toEqual([]);
    expect(done.counts).toMatchObject({ relationsUpdated: 0, relationsCreated: 0 });
    expect(await q("select count(*)::int n from external_item_refs where kind = 'relation' and removed_here_at is not null")).toEqual([{ n: 2 }]);
    await sync();
    expect(await links()).toEqual([]);
    expect(await missing()).toBe(0);
  });

  it("a antiga era adotada (feita à mão aqui): fica, e a nova entra pelas regras normais", async () => {
    const team = await setup([]);
    await sync();
    expect((await h.call("POST", `/api/tickets/${await ticketOf("b")}/dependencies`, as("admin"), { ticketId: await ticketOf("a") })).status).toBeLessThan(300);
    team.relations = [blocks("r-1", "a", "b")];
    expect((await sync()).counts).toMatchObject({ relationsAdopted: 1 });
    team.relations = [blocks("r-1", "a", "c")];
    const done = await sync();
    expect(await links()).toEqual(["b>a", "c>a"]);
    expect(done.counts).toMatchObject({ relationsCreated: 1, relationsUpdated: 0 });
    expect(await missing()).toBe(0);
  });

  it("a forma nova que fecharia um ciclo com OUTRA ligação: a antiga sai do mesmo jeito e a nova conta como ciclo (tenta de novo depois)", async () => {
    const team = await setup([blocks("r-1", "a", "d"), blocks("r-2", "a", "b"), blocks("r-3", "b", "c")]);
    await sync();
    expect(await links()).toEqual(["b>a", "c>b", "d>a"]);
    // r-1 vira "C bloqueia A" (A depende de C); com C > B > A (r-2 e r-3) já aqui, fecharia um ciclo.
    team.relations = [blocks("r-1", "c", "a"), blocks("r-2", "a", "b"), blocks("r-3", "b", "c")];
    const done = await sync();
    expect(await links()).toEqual(["b>a", "c>b"]);
    expect(done.counts).toMatchObject({ relationsCycle: 1, relationsMissing: 0 });
    expect(await missing()).toBe(0);
  });
});

describe("removida aqui × ticket apagado e importado de novo", () => {
  for (const which of ["from", "to"] as const) {
    it(`related: apagado o ticket da ponta "${which}" da linha e importado de novo, a relação volta`, async () => {
      await setup([{ id: "r-de", type: "related", from: "d", to: "c" }]);
      await sync();
      const [c, d] = [await ticketOf("c"), await ticketOf("d")];
      const [from, to] = c < d ? [c, d] : [d, c];
      expect((await h.call("DELETE", `/api/tickets/${d}/related/${c}`, as("admin"))).status).toBe(204);
      await sync();
      expect(await links()).toEqual([]);
      expect((await h.call("DELETE", `/api/tickets/${which === "from" ? from : to}`, as("admin"))).status).toBeLessThan(300);
      await sync();
      expect(await links()).toEqual(["c~d"]);
      expect(await q("select count(*)::int n from external_item_refs where kind = 'relation' and removed_here_at is not null")).toEqual([{ n: 0 }]);
    });
  }

  for (const which of ["dependente", "bloqueador"] as const) {
    it(`depends_on: apagado o ticket ${which} e importado de novo, a relação volta`, async () => {
      await setup([blocks("r-1", "a", "b")]);
      await sync();
      expect((await h.call("DELETE", `/api/tickets/${await ticketOf("b")}/dependencies/${await ticketOf("a")}`, as("admin"))).status).toBeLessThan(300);
      await sync();
      expect(await links()).toEqual([]);
      expect((await h.call("DELETE", `/api/tickets/${await ticketOf(which === "dependente" ? "b" : "a")}`, as("admin"))).status).toBeLessThan(300);
      await sync();
      expect(await links()).toEqual(["b>a"]);
    });
  }

  it("os dois tickets são os mesmos: a removida aqui não volta", async () => {
    await setup([blocks("r-1", "a", "b"), blocks("r-2", "c", "d")]);
    await sync();
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("b")}/dependencies/${await ticketOf("a")}`, as("admin"))).status).toBeLessThan(300);
    // Outro ticket apagado e reimportado não muda nada para r-1.
    expect((await h.call("DELETE", `/api/tickets/${await ticketOf("c")}`, as("admin"))).status).toBeLessThan(300);
    await sync();
    await sync();
    expect(await links()).toEqual(["d>c"]);
  });
});

describe("ponta sem ticket vivo neste projeto (R2, item 5)", () => {
  it("a relação continua no Linear: a origem é vista e não ganha missing_since", async () => {
    const team = await setup([], ["a", "b"]);
    await sync();
    const [a, b] = [await ticketOf("a"), await ticketOf("b")];
    // A origem de `related` pertence ao ticket de menor id: ele fica, o outro é apagado aqui e sai do time no Linear.
    const [keep, drop] = a < b ? ["a", "b"] : ["b", "a"];
    team.relations = [{ id: "r-1", type: "related", from: keep, to: drop }];
    await sync();
    expect(await links()).toEqual(["a~b"]);
    team.issues = team.issues.filter((issue) => issue.id !== drop);
    expect((await h.call("DELETE", `/api/tickets/${drop === "a" ? a : b}`, as("admin"))).status).toBeLessThan(300);
    const done = await sync();
    expect(done.counts).toMatchObject({ relationsMissing: 0, relationsSkipped: 1 });
    expect(await q("select count(*)::int n from external_item_refs where kind = 'relation'")).toEqual([{ n: 1 }]);
    expect(await missing()).toBe(0);
  });
});

/** As origens de relação: `id da forma` + L (com linha), R (removida aqui), S (forma antiga), A (adotada: linha feita à mão). */
const origins = async (): Promise<string[]> =>
  (await q("select external_id, local_id is not null as linked, removed_here_at is not null as removed, applied->>'superseded' as sup, applied->>'adopted' as ado from external_item_refs where kind = 'relation' order by external_id")).map(
    (row) => `${String(row["external_id"])}${row["linked"] ? " L" : ""}${row["removed"] ? " R" : ""}${row["sup"] === "true" ? " S" : ""}${row["ado"] === "true" ? " A" : ""}`,
  );
const relationEvents = async (): Promise<number> => (await q("select count(*)::int n from activity_events where kind = 'ticket.relations_imported_from_linear'"))[0]!["n"] as number;
const removeDependency = async (from: string, to: string): Promise<number> => (await h.call("DELETE", `/api/tickets/${await ticketOf(from)}/dependencies/${await ticketOf(to)}`, as("admin"))).status;
const addDependency = async (from: string, to: string): Promise<number> => (await h.call("POST", `/api/tickets/${await ticketOf(from)}/dependencies`, as("admin"), { ticketId: await ticketOf(to) })).status;

describe("linha compartilhada por duas relações do Linear (R3, item 2)", () => {
  it("related (dona) + duplicate no mesmo par: editar a dona não tira a linha; editar a ÚLTIMA tira", async () => {
    const team = await setup([{ id: "r-1", type: "related", from: "a", to: "b" }, { id: "r-2", type: "duplicate", from: "a", to: "b" }]);
    await sync();
    expect(await links()).toEqual(["a~b"]);
    // A linha é do Linear (selo): nenhuma das duas origens a marca como feita à mão.
    expect(await origins()).toEqual(["r-1:r:a:b L", "r-2:r:a:b L"]);
    const events = await relationEvents();
    team.relations = [blocks("r-1", "a", "c"), { id: "r-2", type: "duplicate", from: "a", to: "b" }];
    const edited = await sync();
    expect(await links()).toEqual(["a~b", "c>a"]);
    expect(edited.counts).toMatchObject({ relationsUpdated: 1, relationsCreated: 0 });
    // Na rodada seguinte, nada: nem "criada", nem evento novo, e r-2 continua com a linha.
    const again = await sync();
    expect(again.counts).toMatchObject({ relationsUpdated: 0, relationsCreated: 0, relationsAdopted: 0 });
    expect(await relationEvents()).toBe(events);
    expect(await origins()).toEqual(["r-1:d:c:a L", "r-1:r:a:b S", "r-2:r:a:b L"]);
    // Agora a última que aponta para a~b é editada: a linha sai.
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "b", "d")];
    expect((await sync()).counts).toMatchObject({ relationsUpdated: 1 });
    expect(await links()).toEqual(["c>a", "d>b"]);
  });

  it("dois blocks no mesmo par: trocar a ponta de um mantém a linha da outra; trocar a da outra a tira", async () => {
    const team = await setup([blocks("r-1", "a", "b"), blocks("r-2", "a", "b")]);
    await sync();
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "a", "b")];
    await sync();
    expect(await links()).toEqual(["b>a", "c>a"]);
    expect((await sync()).counts).toMatchObject({ relationsCreated: 0, relationsUpdated: 0 });
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "a", "d")];
    await sync();
    expect(await links()).toEqual(["c>a", "d>a"]);
  });

  it("as duas editadas na mesma página: a linha sai", async () => {
    const team = await setup([blocks("r-1", "a", "b"), blocks("r-2", "a", "b")]);
    await sync();
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "a", "d")];
    const done = await sync();
    expect(await links()).toEqual(["c>a", "d>a"]);
    expect(done.counts).toMatchObject({ relationsUpdated: 2 });
  });

  it("linha feita à mão e adotada pelas duas: nenhuma edição a tira", async () => {
    const team = await setup([]);
    await sync();
    expect(await addDependency("b", "a")).toBeLessThan(300);
    team.relations = [blocks("r-1", "a", "b"), blocks("r-2", "a", "b")];
    await sync();
    expect(await origins()).toEqual(["r-1:d:b:a L A", "r-2:d:b:a L A"]);
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "a", "b")];
    await sync();
    team.relations = [blocks("r-1", "a", "c"), blocks("r-2", "a", "d")];
    await sync();
    expect(await links()).toEqual(["b>a", "c>a", "d>a"]);
  });
});

describe("removida aqui só passa à forma nova no MESMO par (R3, item 4)", () => {
  it("removida b>a; a relação vai para a→c no Linear: c>a entra; depois volta ao par a/b invertida: não entra (herda)", async () => {
    const team = await setup([blocks("r-1", "a", "b")]);
    await sync();
    expect(await removeDependency("b", "a")).toBeLessThan(300);
    team.relations = [blocks("r-1", "a", "c")];
    const moved = await sync();
    expect(await links()).toEqual(["c>a"]);
    expect(moved.counts).toMatchObject({ relationsCreated: 1 });
    team.relations = [blocks("r-1", "b", "a")];
    await sync();
    expect(await links()).toEqual([]);
    expect(await origins()).toEqual(["r-1:d:a:b R", "r-1:d:b:a R S", "r-1:d:c:a S"]);
  });

  it("removida b>a; a relação troca de tipo no mesmo par (related a~b): não entra", async () => {
    const team = await setup([blocks("r-1", "a", "b")]);
    await sync();
    expect(await removeDependency("b", "a")).toBeLessThan(300);
    team.relations = [{ id: "r-1", type: "related", from: "a", to: "b" }];
    await sync();
    expect(await links()).toEqual([]);
  });
});

describe("estado coerente (R3, item 5)", () => {
  const ids60 = Array.from({ length: 60 }, (_, i) => `i${String(i).padStart(3, "0")}`);

  it("as duas formas vivas na mesma rodada (a antiga na página 1, a nova na 3) e a ANTIGA removida aqui: a nova, de outro par, fica com a linha", async () => {
    const team = await setup([blocks("r-1", "i000", "i001")], ids60);
    await sync();
    team.relationsOverride = (_call, ask) => {
      if (ask.after !== null) team.relations = [blocks("r-1", "i050", "i051")];
      return undefined;
    };
    await sync();
    team.relationsOverride = undefined;
    expect(await links()).toEqual(["i001>i000", "i051>i050"]);
    expect(await removeDependency("i001", "i000")).toBeLessThan(300);
    await sync();
    expect(await links()).toEqual(["i051>i050"]);
    expect((await origins()).find((origin) => origin.startsWith("r-1:d:i051:i050"))).toBe("r-1:d:i051:i050 L");
  });

  it("o mesmo com as duas formas no MESMO par (related na página 1, blocks na 3): a forma viva com linha não herda a remoção da outra", async () => {
    const team = await setup([{ id: "r-1", type: "related", from: "i000", to: "i051" }], ids60);
    await sync();
    team.relationsOverride = (_call, ask) => {
      if (ask.after !== null) team.relations = [blocks("r-1", "i051", "i000")];
      return undefined;
    };
    await sync();
    team.relationsOverride = undefined;
    expect(await links()).toEqual(["i000>i051", "i000~i051"]);
    const [x, y] = [await ticketOf("i000"), await ticketOf("i051")];
    expect((await h.call("DELETE", `/api/tickets/${x}/related/${y}`, as("admin"))).status).toBe(204);
    await sync();
    expect(await links()).toEqual(["i000>i051"]);
    // E a origem dela continua dona da linha (nada de "removida aqui" com a linha órfã no banco).
    expect((await origins()).find((origin) => origin.startsWith("r-1:d:i000:i051"))).toBe("r-1:d:i000:i051 L");
  });
});

import { describe, expect, it } from "vitest";
import { TEAM_ENG, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeLabel, FakeTeamData } from "./linear-support.js";
import { as } from "./world.js";

// Etiquetas do Linear (ADR 0065, seção 5; TREEPM-466): o catálogo do projeto pela origem (`project_label_origins`) e a regra por item
// no ticket (`external_item_refs` tipo `label`), aplicados dentro do passo `issues`. Ponta a ponta com o Linear falso.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);

async function sync(): Promise<RunBody> {
  const run = await post("", {});
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  let last = run.body as RunBody;
  for (let i = 0; i < 200 && last.done !== true; i += 1) {
    const res = await post(`/${last.id ?? run.body.id}/step`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    last = res.body;
  }
  expect(last.done).toBe(true);
  return last;
}

const BUG: FakeLabel = { id: "l-bug", name: "Bug", color: "#eb5757" };
const FRONT: FakeLabel = { id: "l-front", name: "Front", color: "#4ea7fc" };
const WEB_AREA: FakeLabel = { id: "l-web-area", name: "Web", color: "#4cb782", parent: { id: "g-area", name: "Área" } };
const WEB_PLAT: FakeLabel = { id: "l-web-plat", name: "Web", color: "#f2c94c", parent: { id: "g-plat", name: "Plataforma" } };

let issues: FakeIssue[] = [];
const team = (): Record<string, FakeTeamData> => ({ [TEAM_ENG.id]: { projects: [], issues } });
async function firstImport(list: FakeIssue[]): Promise<RunBody> {
  issues = list;
  await linkWithData(h, put, open(), team());
  return sync();
}
const issue = (id: string): FakeIssue => issues.find((item) => item.id === id) as FakeIssue;
const ticketId = async (externalId: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [externalId]))[0]!["ticket_id"] as string;
/** As etiquetas do ticket importado, por nome (ordem do nome). */
async function labelsOf(externalId: string): Promise<string[]> {
  const rows = await q("select pl.name from ticket_labels tl join project_labels pl on pl.id = tl.label_id where tl.ticket_id = $1::uuid order by pl.name_key", [await ticketId(externalId)]);
  return rows.map((row) => row["name"] as string);
}
const projectLabels = async (): Promise<Row[]> => q("select id::text, name, color from project_labels where project_id = $1::uuid order by name_key", [open()]);
const labelId = async (name: string): Promise<string> => (await q("select id::text from project_labels where project_id = $1::uuid and name = $2", [open(), name]))[0]!["id"] as string;
async function changeHere(externalId: string, change: { add?: unknown[]; remove?: string[] }): Promise<void> {
  const res = await h.call("POST", `/api/tickets/${await ticketId(externalId)}/labels`, as("admin"), change);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const labelEvents = async (): Promise<Row[]> => (await q("select subject_id, payload from activity_events where kind = 'ticket.labels_changed' order by occurred_at, id")).map((row) => ({ subject: row["subject_id"], ...(row["payload"] as Row) }));
/** Um retrato das tabelas de etiqueta e da versão do projeto: sincronizar sem mudança não pode mexer em nada disso. */
async function snapshot(): Promise<unknown> {
  const parts = await Promise.all([
    q("select * from project_labels order by id"),
    q("select * from ticket_labels order by ticket_id, label_id"),
    q("select * from project_label_origins order by id"),
    q("select * from external_item_refs where kind = 'label' order by id"),
    q("select count(*)::int n from activity_events where kind = 'ticket.labels_changed'"),
  ]);
  const list = await h.call("GET", `/api/projects/${open()}/tickets`, as("admin"));
  expect(list.status).toBe(200);
  return JSON.parse(JSON.stringify({ labels: parts[0], ticketLabels: parts[1], origins: parts[2], refs: parts[3], events: parts[4], etag: list.headers["etag"] }));
}

describe("o catálogo do projeto", () => {
  it("primeira importação cria as etiquetas usadas, com a cor da paleta mais próxima, e as põe nos tickets", async () => {
    const run = await firstImport([
      { id: "a", identifier: "ENG-1", labels: [BUG, FRONT] },
      { id: "b", identifier: "ENG-2", labels: [BUG] },
      { id: "c", identifier: "ENG-3" },
    ]);
    expect((await projectLabels()).map((row) => [row["name"], row["color"]])).toEqual([
      ["Bug", "rose"],
      ["Front", "cyan"],
    ]);
    expect(await labelsOf("a")).toEqual(["Bug", "Front"]);
    expect(await labelsOf("b")).toEqual(["Bug"]);
    expect(await labelsOf("c")).toEqual([]);
    expect(run.counts).toMatchObject({ labelsCreated: 2, labelsAdopted: 0, labelsAdded: 3, labelsRemoved: 0 });
    // Um evento resumido por ticket, automático, sem nenhum id do Linear.
    const events = await labelEvents();
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ automatic: true, source: "linear_reimport" });
    expect(JSON.stringify(events)).not.toMatch(/l-bug|l-front/);
  });

  it("etiqueta daqui com o mesmo nome (sem diferenciar maiúsculas) é adotada, não duplicada, e não muda de nome nem cor", async () => {
    const res = await h.call("POST", `/api/projects/${open()}/labels`, as("admin"), { name: "bug", color: "olive" });
    expect(res.status).toBe(201);
    const run = await firstImport([{ id: "a", labels: [BUG] }]);
    expect((await projectLabels()).map((row) => [row["name"], row["color"]])).toEqual([["bug", "olive"]]);
    expect(await labelsOf("a")).toEqual(["bug"]);
    expect(run.counts).toMatchObject({ labelsCreated: 0, labelsAdopted: 1 });
  });

  it("duas etiquetas de grupos diferentes com o mesmo nome: a sem grupo (ou a de menor id) fica com o nome simples, a outra vira «Grupo: Nome»", async () => {
    await firstImport([
      { id: "a", labels: [WEB_PLAT] },
      { id: "b", labels: [WEB_AREA] },
    ]);
    // Na mesma rodada, a ordem é determinística: sem grupo primeiro, depois pelo id do Linear (`l-web-area` < `l-web-plat`).
    expect(await labelsOf("b")).toEqual(["Web"]);
    expect(await labelsOf("a")).toEqual(["Plataforma: Web"]);
    // Na rodada seguinte, cada uma resolve pela própria origem.
    await sync();
    expect(await labelsOf("b")).toEqual(["Web"]);
    expect(await labelsOf("a")).toEqual(["Plataforma: Web"]);
  });

  it("etiqueta apagada aqui (configurações) não renasce pela sincronização", async () => {
    await firstImport([{ id: "a", labels: [BUG, FRONT] }]);
    const res = await h.call("DELETE", `/api/projects/${open()}/labels/${await labelId("Bug")}`, as("admin"));
    expect(res.status).toBe(200);
    issue("a").labels = [BUG, FRONT];
    issues.push({ id: "b", identifier: "ENG-9", labels: [BUG] });
    await sync();
    expect((await projectLabels()).map((row) => row["name"])).toEqual(["Front"]);
    expect(await labelsOf("a")).toEqual(["Front"]);
    expect(await labelsOf("b")).toEqual([]);
  });

  it("renomear e recolorir lá muda aqui; renomear aqui segura o nome daqui (a cor de lá ainda chega)", async () => {
    await firstImport([{ id: "a", labels: [BUG, FRONT] }]);
    issue("a").labels = [
      { ...BUG, name: "Defeito", color: "#4ea7fc" },
      { ...FRONT, name: "Frontend" },
    ];
    const res = await h.call("PATCH", `/api/projects/${open()}/labels/${await labelId("Front")}`, as("admin"), { name: "Interface" });
    expect(res.status).toBe(200);
    const run = await sync();
    expect((await projectLabels()).map((row) => [row["name"], row["color"]])).toEqual([
      ["Defeito", "cyan"],
      ["Interface", "cyan"],
    ]);
    expect(run.counts).toMatchObject({ labelsUpdated: 1 });
  });

  it("renomear lá para o nome de outra etiqueta daqui não renomeia (conta) e não derruba o passo", async () => {
    await firstImport([{ id: "a", labels: [BUG] }]);
    const made = await h.call("POST", `/api/projects/${open()}/labels`, as("admin"), { name: "Defeito" });
    expect(made.status).toBe(201);
    issue("a").labels = [{ ...BUG, name: "defeito" }];
    const run = await sync();
    expect((await projectLabels()).map((row) => row["name"])).toEqual(["Bug", "Defeito"]);
    expect(await labelsOf("a")).toEqual(["Bug"]);
    expect(run.counts).toMatchObject({ labelsRenameTaken: 1 });
  });
});

describe("a regra por item no ticket", () => {
  it("posta lá chega; tirada lá sai se veio de lá; adotada (já estava aqui) fica", async () => {
    await firstImport([{ id: "a", labels: [BUG] }]);
    await changeHere("a", { add: [{ name: "Front" }] });
    issue("a").labels = [BUG, FRONT];
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug", "Front"]);
    issue("a").labels = [];
    const run = await sync();
    // Bug veio de lá e sai; Front já estava aqui quando chegou (adotada) e fica.
    expect(await labelsOf("a")).toEqual(["Front"]);
    expect(run.counts).toMatchObject({ labelsRemoved: 1 });
  });

  it("tirada aqui não volta; posta aqui fica", async () => {
    await firstImport([{ id: "a", labels: [BUG, FRONT] }]);
    await changeHere("a", { remove: [await labelId("Bug")], add: [{ name: "Local" }] });
    await sync();
    expect(await labelsOf("a")).toEqual(["Front", "Local"]);
    issue("a").title = "mudou lá";
    await sync();
    expect(await labelsOf("a")).toEqual(["Front", "Local"]);
  });

  it("tirada lá e posta de novo lá volta", async () => {
    await firstImport([{ id: "a", labels: [BUG] }]);
    issue("a").labels = [];
    await sync();
    expect(await labelsOf("a")).toEqual([]);
    issue("a").labels = [BUG];
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug"]);
  });

  it("`labelIds` ausente ou malformado: nada muda no ticket; id sem nó e sem origem: não lido, contado, nunca removido", async () => {
    await firstImport([{ id: "a", labels: [BUG, FRONT] }]);
    delete issue("a").labels;
    let run = await sync();
    expect(await labelsOf("a")).toEqual(["Bug", "Front"]);
    issue("a").labelIds = "lixo";
    run = await sync();
    expect(await labelsOf("a")).toEqual(["Bug", "Front"]);
    // Bug e Front sem nó nesta página resolvem pela origem; `l-novo` sem nó e sem origem não é lido.
    issue("a").labelIds = ["l-bug", "l-front", "l-novo"];
    issue("a").labels = [];
    run = await sync();
    expect(await labelsOf("a")).toEqual(["Bug", "Front"]);
    expect(run.counts).toMatchObject({ labelsUnread: 1, labelsRemoved: 0 });
  });

  it("mais de 10 etiquetas numa issue: as sem nó entram pela origem nas rodadas seguintes; as novas sem nó são não lidas", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `l-${String(i).padStart(2, "0")}`, name: `E${String(i).padStart(2, "0")}` }));
    const run = await firstImport([{ id: "a", labels: many }]);
    expect(await labelsOf("a")).toHaveLength(10);
    expect(run.counts).toMatchObject({ labelsUnread: 2 });
  });
});

describe("limites, texto hostil e quietude", () => {
  it("limite de 20 por ticket: o que passa não entra e é contado", async () => {
    // O Linear manda só 10 nós; as outras 15 já têm origem (de outra issue) e resolvem por ela.
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `l-${String(i).padStart(2, "0")}`, name: `E${String(i).padStart(2, "0")}` }));
    const list: FakeIssue[] = [0, 10, 20].map((start, i) => ({ id: `seed-${i}`, labels: many.slice(start, start + 10) }));
    await firstImport(list);
    issues.push({ id: "a", identifier: "ENG-50", labels: many });
    const run = await sync();
    expect(await labelsOf("a")).toHaveLength(20);
    expect(run.counts).toMatchObject({ labelsOverTicketLimit: 5 });
  });

  it("limite de 200 por projeto: o que passa não entra, é contado, e entra depois quando houver lugar", async () => {
    await q("insert into project_labels (org_id, project_id, name, name_key, color) select org_id, id, 'cheia ' || g, 'cheia ' || g, 'gray' from projects, generate_series(1, 199) g where id = $1::uuid", [open()]);
    const run = await firstImport([{ id: "a", labels: [BUG, FRONT] }]);
    expect(await labelsOf("a")).toEqual(["Bug"]);
    expect(run.counts).toMatchObject({ labelsCreated: 1, labelsOverProjectLimit: 1 });
    await q("delete from project_labels where name = 'cheia 1'");
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug", "Front"]);
  });

  it("nomes hostis: nada vira menção, vazio é ignorado e contado, 100 mil caracteres em tempo linear, nenhuma recusa do banco", async () => {
    const hostile: FakeLabel[] = [
      { id: "l-m", name: "[@Ana](person:00000000-0000-0000-0000-000000000001)" },
      { id: "l-p", name: "person:abc ana@acme.io" },
      { id: "l-long", name: "x".repeat(100_000) },
      { id: "l-nul", name: "a\u0000b\nc" },
      { id: "l-blank", name: "   \n\t " },
    ];
    const started = Date.now();
    const run = await firstImport([{ id: "a", labels: hostile }]);
    expect(Date.now() - started).toBeLessThan(20_000);
    const names = (await projectLabels()).map((row) => row["name"] as string);
    expect(names).toHaveLength(4);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(60);
      expect([...name].some((char) => char.charCodeAt(0) < 0x20)).toBe(false);
    }
    expect(run.counts).toMatchObject({ labelsNameInvalid: 1, labelsCreated: 4 });
    expect((await q("select count(*)::int n from ticket_relations where kind = 'mentions'"))[0]!["n"]).toBe(0);
    expect((await q("select count(*)::int n from activity_events where payload::text like '%person:%' and kind <> 'ticket.labels_changed'"))[0]!["n"]).toBe(0);
  });

  it("sincronização sem mudança: zero escritas nas tabelas de etiqueta, zero eventos, versão do projeto intocada", async () => {
    await firstImport([
      { id: "a", labels: [BUG, FRONT] },
      { id: "b", labels: [WEB_AREA, WEB_PLAT] },
    ]);
    const before = (await snapshot()) as Row;
    await sync();
    const after = (await snapshot()) as Row;
    expect({ ...after, etag: null }).toEqual({ ...before, etag: null });
    // A rodada em si já toca a versão uma vez (medido: um time sem etiquetas vai de v2.2 a v2.3); as etiquetas não tocam de novo.
    const version = (row: Row) => Number(/v2\.(\d+)/.exec(row["etag"] as string)?.[1]);
    expect(version(after) - version(before)).toBe(1);
  });

  it("um evento por ticket por rodada, mesmo pondo e tirando várias", async () => {
    await firstImport([{ id: "a", labels: [BUG] }]);
    const before = (await labelEvents()).length;
    issue("a").labels = [FRONT, WEB_AREA];
    await sync();
    const events = (await labelEvents()).slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ automatic: true, source: "linear_reimport" });
    expect((events[0]!["added"] as Row[]).map((item) => item["name"])).toEqual(["Front", "Web"]);
    expect((events[0]!["removed"] as Row[]).map((item) => item["name"])).toEqual(["Bug"]);
  });

  it("ticket apagado e reimportado é ticket novo: as origens dele somem e as etiquetas voltam", async () => {
    await firstImport([{ id: "a", labels: [BUG] }]);
    await changeHere("a", { remove: [await labelId("Bug")] });
    const res = await h.call("DELETE", `/api/tickets/${await ticketId("a")}`, as("admin"));
    expect([200, 204]).toContain(res.status);
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug"]);
  });
});

// Revisão E1 (TREEPM-466), itens 1 e 2: nome que o banco recusaria (chave NFKC acima de 240, só invisíveis) não derruba o passo: é
// ignorado e contado, e a rodada termina. (O id de etiqueta fora do CHECK de 100 já para no cliente: `linear-client-labels.test.ts`.)
describe("nomes e ids que o banco recusaria", () => {
  const BIG = "\ufdfa".repeat(14); // a chave NFKC tem 252 pontos de código
  it("ignorados e contados; a rodada termina, o resto entra e o nome com invisível é a mesma etiqueta", async () => {
    const done = await firstImport([
      {
        id: "a",
        identifier: "ENG-1",
        labels: [
          { id: "l-big", name: BIG, color: "#eb5757" },
          { id: "l-zw", name: "\u200b\u2060", color: "#eb5757" },
          BUG,
        ],
      },
      { id: "b", identifier: "ENG-2", labels: [BUG, { id: "l-bug-zw", name: "Bug\u200b", color: "#eb5757" }] },
    ]);
    expect(done.counts).toMatchObject({ labelsNameInvalid: 2, labelsUnread: 0 });
    expect(await labelsOf("a")).toEqual(["Bug"]);
    // "Bug\u200b" é a mesma etiqueta que "Bug" (adotada), não uma duplicata visual.
    expect(await labelsOf("b")).toEqual(["Bug"]);
    expect((await projectLabels()).map((row) => row["name"])).toEqual(["Bug"]);
    expect((await sync()).done).toBe(true);
  });
});

// Revisão E1 (TREEPM-466), item 3: o vínculo esquecido que volta recalcula `adopted` pelo estado de AGORA.
describe("origem que volta: adotada ou vinda de lá pelo estado de agora", () => {
  it("veio de lá, saiu lá, uma pessoa pôs aqui, lá puseram de novo e tiraram: fica", async () => {
    await firstImport([{ id: "a", identifier: "ENG-1", labels: [BUG] }]);
    expect(await labelsOf("a")).toEqual(["Bug"]);
    issue("a").labels = [];
    await sync();
    expect(await labelsOf("a")).toEqual([]);
    await changeHere("a", { add: [{ labelId: await labelId("Bug") }] });
    issue("a").labels = [BUG];
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug"]);
    issue("a").labels = [];
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug"]);
  });

  it("adotada, saiu lá, a pessoa tirou aqui, lá puseram e tiraram: não fica", async () => {
    await firstImport([{ id: "a", identifier: "ENG-1", labels: [] }]);
    await changeHere("a", { add: [{ name: "Bug" }] });
    issue("a").labels = [BUG];
    await sync();
    issue("a").labels = [];
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug"]);
    await changeHere("a", { remove: [await labelId("Bug")] });
    issue("a").labels = [BUG];
    await sync();
    expect(await labelsOf("a")).toEqual(["Bug"]);
    issue("a").labels = [];
    await sync();
    expect(await labelsOf("a")).toEqual([]);
  });
});

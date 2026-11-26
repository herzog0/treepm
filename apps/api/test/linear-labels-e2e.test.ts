/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { CATEGORIZE_CONFIG } from "./linear-categorize-support.js";
import { KEY, KEY_B, TEAM_ENG, TEAM_OPS, WORKSPACE, linearImportWorld } from "./linear-support.js";
import type { FakeIssue, FakeLabel, FakeTeamData, LinearWorld } from "./linear-support.js";
import { useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// Etiquetas do Linear de ponta a ponta (ADR 0065; BRIEF-E1, seção 6), com o Linear falso: um time de 40 issues e 12 etiquetas (grupos,
// nome repetido entre grupos, cores variadas, uma com o nome de uma etiqueta que já existe no projeto). O mesmo roteiro roda pela tela
// (com o passo pedido por duas abas ao mesmo tempo) e pelo MCP (`start_linear_sync`/`continue_linear_sync`); o estado final é o mesmo.
const h = useMcpHarness(CATEGORIZE_CONFIG);
const priv = () => h.world().projects.priv;
const q = async (sql: string, params: unknown[] = []) => h.rows(sql, params);

const L = (id: string, name: string, color: string, parent: { id: string; name: string } | null = null): FakeLabel => ({ id, name, color, parent });
const AREA = { id: "g-area", name: "Área" };
const PLAT = { id: "g-plat", name: "Plataforma" };
const LABELS: FakeLabel[] = [
  L("lab-bug", "Bug", "#eb5757"),
  L("lab-web-area", "Web", "#4cb782", AREA),
  L("lab-mobile", "Mobile", "#26b5ce", AREA),
  L("lab-api", "API", "#5e6ad2", AREA),
  L("lab-web-plat", "Web", "#f2c94c", PLAT),
  L("lab-ios", "iOS", "#bec2c8", PLAT),
  L("lab-front", "Front", "#4ea7fc"),
  L("lab-docs", "Docs", "#95a2b3"),
  L("lab-urgente", "Urgente", "#f2994a"),
  L("lab-divida", "Dívida", "#9b51e0"),
  L("lab-cliente", "Cliente X", "#f7c8c1"),
  L("lab-pesquisa", "Pesquisa", "#0f783c"),
];
const label = (id: string): FakeLabel => LABELS.find((item) => item.id === id) as FakeLabel;

/** 40 issues; as 36 primeiras com duas etiquetas cada (todas as 12 usadas, as duas "Web" na mesma página), as 4 últimas sem nenhuma. */
function team(withLabels: boolean): FakeTeamData {
  const issues: FakeIssue[] = [];
  for (let i = 0; i < 40; i += 1) {
    const item: FakeIssue = { id: `iss-${String(i).padStart(2, "0")}`, identifier: `ENG-${i + 1}`, title: `Issue ${i + 1}` };
    if (withLabels) item.labels = i < 36 ? [...new Set([LABELS[i % 12] as FakeLabel, LABELS[(i * 5 + 3) % 12] as FakeLabel])] : [];
    issues.push(item);
  }
  return { projects: [], issues };
}

const KEY_M = "lin_api_SEGREDO_M_3333cccc";
const world = (): LinearWorld => ({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG, TEAM_OPS] }, [KEY_M]: { workspace: WORKSPACE, teams: [TEAM_ENG] }, [KEY_B]: { workspace: WORKSPACE, teams: [TEAM_ENG] } });
let data: FakeTeamData = team(false);
const issue = (id: string): FakeIssue => data.issues.find((item) => item.id === id) as FakeIssue;

async function link(): Promise<void> {
  // O falso lê o mesmo objeto a cada chamada: mudar `data` entre rodadas é mudar o Linear.
  const base = linearImportWorld(world(), { [TEAM_ENG.id]: data });
  h.linear().use((call) => base(call));
  expect((await h.call("PUT", "/api/linear/connection", as("admin"), { apiKey: KEY })).status).toBe(200);
  const res = await h.call("POST", `/api/projects/${priv()}/linear`, as("admin"), { teamId: TEAM_ENG.id, confirmTeamKey: TEAM_ENG.key });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

type Driver = { sync: () => Promise<any> };
const runs = (tail = "") => `/api/projects/${priv()}/linear/runs${tail}`;

/** Pela tela, como duas abas: cada passo é pedido duas vezes ao mesmo tempo; a segunda pode esperar (409 de passo em andamento). */
const httpDriver: Driver = {
  async sync() {
    const opened = await h.call("POST", runs(), as("admin"), {});
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    let last: any = opened.body;
    for (let i = 0; i < 200 && last.done !== true; i += 1) {
      const pair = await Promise.all([h.call("POST", runs(`/${opened.body.id}/step`), as("admin")), h.call("POST", runs(`/${opened.body.id}/step`), as("admin"))]);
      for (const res of pair) expect([200, 409], JSON.stringify(res.body)).toContain(res.status);
      const ok = pair.filter((res) => res.status === 200).map((res) => res.body);
      last = ok.find((body: any) => body.done === true) ?? ok[ok.length - 1] ?? last;
    }
    expect(last.done).toBe(true);
    return last;
  },
};

let mcpToken = "";
async function write(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
  h.clock.advance(61_000);
  return h.tool(mcpToken, "PRIV", name, args);
}
const mcpDriver: Driver = {
  async sync() {
    if (mcpToken === "") {
      await h.pool.query("update organizations set mcp_enabled = true, mcp_write_enabled = true where org_id = $1", [ORG]);
      const res = await h.create("admin", priv(), { scope: "write" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      mcpToken = res.body.token as string;
    }
    const started = await write("start_linear_sync");
    expect(started.isError, started.text).toBe(false);
    let last: any = started.data;
    for (let i = 0; i < 200 && last.done !== true; i += 1) {
      const res = await write("continue_linear_sync", { runId: started.data?.id });
      expect(res.isError, res.text).toBe(false);
      last = res.data;
    }
    expect(last.done).toBe(true);
    return last;
  },
};

const ticketOf = async (externalId: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1", [externalId]))[0]?.ticket_id as string;
const labelId = async (name: string): Promise<string> => (await q("select id::text from project_labels where project_id = $1::uuid and name = $2", [priv(), name]))[0]?.id as string;
async function changeHere(externalId: string, change: { add?: unknown[]; remove?: string[] }): Promise<void> {
  const res = await h.call("POST", `/api/tickets/${await ticketOf(externalId)}/labels`, as("admin"), change);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}
/** O estado que importa, sem ids: etiquetas do projeto (nome, cor) e as de cada issue, por nome. */
async function state(): Promise<{ project: string[]; tickets: Record<string, string[]> }> {
  const project = (await q("select name, color from project_labels where project_id = $1::uuid order by name_key", [priv()])).map((row: any) => `${row.name}=${row.color}`);
  const rows = await q(
    `select r.external_id, coalesce(array_agg(pl.name order by pl.name_key) filter (where pl.id is not null), '{}') as names
     from ticket_external_refs r left join ticket_labels tl on tl.ticket_id = r.ticket_id left join project_labels pl on pl.id = tl.label_id
     where r.project_id = $1::uuid group by r.external_id order by r.external_id`,
    [priv()],
  );
  return { project, tickets: Object.fromEntries(rows.map((row: any) => [row.external_id, row.names as string[]])) };
}
/** Tabelas de etiqueta e eventos: sincronizar sem mudança não mexe em nada disso. */
async function labelTables(): Promise<string> {
  const parts = await Promise.all([
    q("select * from project_labels order by id"),
    q("select * from ticket_labels order by ticket_id, label_id"),
    q("select * from project_label_origins order by id"),
    q("select * from external_item_refs where kind = 'label' order by id"),
    q("select count(*)::int n from activity_events where kind like '%label%'"),
  ]);
  return JSON.stringify(parts);
}
const eventsPerTicketPerRun = async (): Promise<number> =>
  Number((await q("select coalesce(max(n), 0)::int m from (select count(*) n from activity_events where kind = 'ticket.labels_changed' and payload->>'runId' is not null group by subject_id, payload->>'runId') s"))[0]?.m);

/** O roteiro inteiro; devolve o estado final para comparar os dois caminhos. */
async function scenario(driver: Driver): Promise<{ project: string[]; tickets: Record<string, string[]> }> {
  // 1. O projeto foi importado ANTES desta fatia: a leitura não trazia etiquetas (nem `labelIds`).
  data = team(false);
  await link();
  // A primeira importação é sempre pela tela (o MCP só sincroniza projeto já importado).
  await httpDriver.sync();
  expect(Number((await q("select count(*)::int n from project_labels"))[0]?.n)).toBe(0);
  // Uma etiqueta daqui com o nome de uma do Linear (sem diferenciar maiúsculas): é adotada, não duplicada.
  expect((await h.call("POST", `/api/projects/${priv()}/labels`, as("admin"), { name: "bug", color: "olive" })).status).toBe(201);

  // 2. A sincronização seguinte (a primeira com etiquetas) traz tudo.
  Object.assign(data, team(true));
  const first = await driver.sync();
  const after = await state();
  expect(after.project).toHaveLength(12);
  expect(after.project).toContain("bug=olive");
  expect(after.project.some((entry) => entry.startsWith("Web="))).toBe(true); // "Web" de Área (menor id entre as duas do mesmo nome)
  expect(after.project.some((entry) => entry.startsWith("Plataforma: Web="))).toBe(true);
  expect(after.tickets["iss-00"]).toEqual(["API", "bug"]); // Bug adotada (bug) e API (índices 0 e 3)
  expect(after.tickets["iss-39"]).toEqual([]);
  expect(first.counts).toMatchObject({ labelsCreated: 11, labelsAdopted: 1 });
  expect(await eventsPerTicketPerRun()).toBe(1);

  // 3. Aqui: tirar uma vinda de lá, pôr uma nova, renomear uma, apagar outra.
  await changeHere("iss-06", { remove: [await labelId("Front")] }); // iss-06 tem Front (6 % 12) vinda do Linear
  await changeHere("iss-38", { add: [{ name: "Daqui" }] });
  expect((await h.call("PATCH", `/api/projects/${priv()}/labels/${await labelId("Pesquisa")}`, as("admin"), { name: "Investigação" })).status).toBe(200);
  expect((await h.call("DELETE", `/api/projects/${priv()}/labels/${await labelId("Cliente X")}`, as("admin"))).status).toBe(200);

  // 4. Lá: tirar uma, renomear duas (uma delas renomeada aqui também).
  issue("iss-01").labels = (issue("iss-01").labels ?? []).filter((item) => item.id !== "lab-web-area");
  for (const item of data.issues) item.labels = (item.labels ?? []).map((one) => (one.id === "lab-urgente" ? { ...one, name: "Urgentíssimo" } : one.id === "lab-pesquisa" ? { ...one, name: "Research" } : one));
  // "Cliente X" continua posta no Linear numa issue a mais: apagada aqui, não renasce.
  issue("iss-39").labels = [label("lab-cliente")];
  await driver.sync();
  const now = await state();
  expect(now.tickets["iss-06"]).not.toContain("Front"); // tirada aqui não volta
  expect(now.tickets["iss-38"]).toContain("Daqui"); // posta aqui fica
  expect(now.tickets["iss-01"]).not.toContain("Web"); // tirada lá sai
  expect(now.project.some((entry) => entry.startsWith("Urgentíssimo="))).toBe(true); // renomeada lá
  expect(now.project.some((entry) => entry.startsWith("Investigação="))).toBe(true); // renomeada aqui segura
  expect(now.project.some((entry) => entry.startsWith("Research=") || entry.startsWith("Pesquisa="))).toBe(false);
  expect(now.project.some((entry) => entry.startsWith("Cliente X="))).toBe(false); // apagada aqui não renasce
  expect(now.tickets["iss-39"]).toEqual([]);
  expect(await eventsPerTicketPerRun()).toBe(1);

  // 5. Sincronizar sem mudança: zero escritas nas tabelas de etiqueta e zero eventos.
  const before = await labelTables();
  await driver.sync();
  expect(await labelTables()).toBe(before);
  return now;
}

let byScreen: Awaited<ReturnType<typeof scenario>> | null = null;

describe("etiquetas do Linear, de ponta a ponta", () => {
  it("pela tela, com o passo pedido por duas abas", async () => {
    byScreen = await scenario(httpDriver);
  });

  it("pelo MCP dá o mesmo resultado", async () => {
    expect(byScreen).not.toBeNull();
    expect(await scenario(mcpDriver)).toEqual(byScreen);
  });
});

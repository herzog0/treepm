/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// ADR 0065 (TREEPM-466), etapa C: as leituras de ticket do MCP trazem `labels` (nomes, pelo limpador de texto); `list_labels`;
// `create_ticket` e `update_ticket` aceitam `addLabels`/`removeLabels` por nome, pelo mesmo serviço da tela.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Um nome de etiqueta com elo de pessoa (como poderia vir do Linear): o limpador o troca por `@Unnamed person`. */
const HOSTILE = "Time [@Zé](person:00000000-0000-4000-8000-000000000001)";
const HOSTILE_OUT = "Time @Unnamed person";
const LINEAR_SENTINEL = "zzlinearlabelsentinela";

async function setup(scope: "read" | "write" = "write", people = false): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.pool.query("update organizations set mcp_enabled = true, mcp_write_enabled = true, mcp_people_enabled = $2 where org_id = $1", [ORG, people]);
  const res = await h.create("contributor", priv(), { scope, ...(people ? { people: true } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}

const idOf = async (number: number): Promise<string> => (await h.rows("select id from tickets where project_id = $1 and number = $2", [priv(), number]))[0]?.["id"] as string;
/** Pela rota da tela, como o gerente. */
const route = async (number: number, body: unknown, who: "manager" | "contributor" = "manager") => h.call("POST", `/api/tickets/${await idOf(number)}/labels`, as(who), body);
const labelsOf = async (number: number) =>
  h.rows("select pl.id::text as id, pl.name, pl.color from ticket_labels tl join project_labels pl on pl.id = tl.label_id join tickets t on t.id = tl.ticket_id where t.project_id = $1 and t.number = $2 order by pl.name_key, pl.id", [priv(), number]);
const projectLabels = async () => h.rows("select id::text as id, name, color from project_labels where project_id = $1 order by name_key", [priv()]);
const labelEvents = async (number: number) =>
  h.rows("select e.payload from activity_events e join tickets t on t.id::text = e.subject_id::text where t.project_id = $1 and t.number = $2 and e.kind = 'ticket.labels_changed' order by e.occurred_at, e.id", [priv(), number]);
const without = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const timeline = async (number: number) => ((await h.call("GET", `/api/tickets/${await idOf(number)}/activity`, as("admin"))).body.entries as any[]).filter((entry) => entry.type === "labels_changed");

describe("labels nas leituras de ticket", () => {
  it("get_ticket (e caminho, filhos, ligações), list_tickets, busca, visão geral e fila trazem os nomes, na ordem da tela", async () => {
    const token = await setup("read");
    expect((await route(1, { add: [{ name: "Zeta" }, { name: "alpha" }] })).status).toBe(200);
    expect((await route(4, { add: [{ name: "Bug" }] })).status).toBe(200);
    const one = await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" });
    expect(one.isError).toBe(false);
    expect(one.json?.["labels"]).toEqual(["alpha", "Zeta"]);
    expect(one.json?.["relations"].mentions.outgoing.tickets[0]).toMatchObject({ key: "PRIV-4", labels: ["Bug"] });
    expect(one.json?.["children"].tickets.map((t: any) => [t.key, t.labels])).toEqual([["PRIV-2", []], ["PRIV-3", []]]);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).json?.["path"][0].labels).toEqual(["alpha", "Zeta"]);
    const list = await h.tool(token, "PRIV", "list_tickets", {});
    expect(list.json?.["tickets"].map((t: any) => [t.key, t.labels])).toEqual([["PRIV-1", ["alpha", "Zeta"]], ["PRIV-2", []], ["PRIV-3", []], ["PRIV-4", ["Bug"]]]);
    expect((await h.tool(token, "PRIV", "search_tickets", { query: "Solto" })).json?.["tickets"][0]).toMatchObject({ key: "PRIV-4", labels: ["Bug"] });
    expect((await h.tool(token, "PRIV", "get_project_overview")).json?.["top"].tickets.find((t: any) => t.key === "PRIV-1").labels).toEqual(["alpha", "Zeta"]);
    expect((await h.tool(token, "PRIV", "get_work_queue", {})).json?.["tickets"].find((t: any) => t.key === "PRIV-4").labels).toEqual(["Bug"]);
  });

  it("nome com elo de pessoa sai limpo; nenhum id (daqui ou do Linear) sai em leitura nenhuma", async () => {
    const token = await setup("read");
    expect((await route(4, { add: [{ name: HOSTILE }] })).status).toBe(200);
    const [label] = await projectLabels();
    // A origem no Linear (id de lá) existe e não pode sair.
    await h.pool.query("insert into project_label_origins (org_id, project_id, provider, external_id, label_id, applied_name, applied_color) values ($1,$2,'linear',$3,$4,$5,'gray')", [ORG, priv(), LINEAR_SENTINEL, label?.["id"], HOSTILE]);
    await h.pool.query("insert into external_item_refs (org_id, project_id, ticket_id, provider, kind, external_id, local_id, applied) values ($1,$2,$3,'linear','label',$4,$5,'{}'::jsonb)", [ORG, priv(), await idOf(4), `issue1:${LINEAR_SENTINEL}`, label?.["id"]]);
    const outs = [
      await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-4" }),
      await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-1" }),
      await h.tool(token, "PRIV", "list_tickets", {}),
      await h.tool(token, "PRIV", "search_tickets", { query: "Solto" }),
      await h.tool(token, "PRIV", "get_project_overview"),
      await h.tool(token, "PRIV", "get_work_queue", {}),
      await h.tool(token, "PRIV", "list_labels"),
    ];
    expect(outs[0]?.json?.["labels"]).toEqual([HOSTILE_OUT]);
    for (const out of outs) {
      expect(out.isError, out.text).toBe(false);
      expect(out.text).not.toMatch(/person:/i);
      expect(out.text).not.toContain(LINEAR_SENTINEL);
      expect(out.text).not.toContain(label?.["id"] as string);
    }
    expect(outs[6]?.text).not.toMatch(UUID);
  });
});

describe("list_labels", () => {
  it("as etiquetas do projeto: nome (limpo), cor e quantos tickets usam, na ordem da tela; existe com o alcance de leitura", async () => {
    const token = await setup("read");
    await route(1, { add: [{ name: "Bug" }, { name: HOSTILE }] });
    await route(4, { add: [{ name: "bug" }] });
    expect((await h.call("POST", `/api/projects/${priv()}/labels`, as("manager"), { name: "Vazia", color: "rose" })).status).toBe(201);
    const out = await h.tool(token, "PRIV", "list_labels");
    expect(out.isError, out.text).toBe(false);
    const colors = Object.fromEntries((await projectLabels()).map((row) => [row["name"], row["color"]]));
    expect(out.json).toEqual({
      labels: [
        { name: "Bug", color: colors["Bug"], tickets: 2 },
        { name: HOSTILE_OUT, color: colors[HOSTILE], tickets: 1 },
        { name: "Vazia", color: "rose", tickets: 0 },
      ],
    });
  });

  it("projeto sem etiqueta: lista vazia", async () => {
    const token = await setup("read");
    expect((await h.tool(token, "PRIV", "list_labels")).json).toEqual({ labels: [] });
  });
});

describe("update_ticket com addLabels e removeLabels", () => {
  it("põe (reusando sem diferenciar maiúsculas e criando a que falta) e tira; um evento com a origem MCP; devolve o ticket com labels", async () => {
    const token = await setup();
    await route(3, { add: [{ name: "Bug" }, { name: "Velha" }] });
    const out = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: ["bug", "Nova"], removeLabels: ["VELHA"] });
    expect(out.isError, out.text).toBe(false);
    expect(out.json?.["labels"]).toEqual(["Bug", "Nova"]);
    expect((await labelsOf(3)).map((row) => row["name"])).toEqual(["Bug", "Nova"]);
    expect((await projectLabels()).map((row) => row["name"])).toEqual(["Bug", "Nova", "Velha"]);
    const events = await labelEvents(3);
    expect(events).toHaveLength(2);
    expect(events[1]?.["payload"]).toMatchObject({ key: "PRIV-3", added: [{ name: "Nova" }], removed: [{ name: "Velha" }], via: "mcp" });
    // Repetir não muda nada nem grava evento.
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: ["Nova"], removeLabels: ["Velha"] })).isError).toBe(false);
    expect(await labelEvents(3)).toHaveLength(2);
  });

  it("só etiquetas não grava evento de edição do ticket; título e etiquetas juntos gravam os dois", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: ["Bug"] })).isError).toBe(false);
    const updated = async () => h.rows("select e.kind from activity_events e join tickets t on t.id::text = e.subject_id::text where t.project_id = $1 and t.number = 3 and e.kind = 'ticket.updated'", [priv()]);
    expect(await updated()).toHaveLength(0);
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "Novo título", removeLabels: ["Bug"] })).isError).toBe(false);
    expect(await updated()).toHaveLength(1);
    expect(await labelsOf(3)).toEqual([]);
  });

  it("a volta de um nome que o limpador mudou acha A MESMA etiqueta (tirar e pôr em outro ticket)", async () => {
    const token = await setup();
    await route(3, { add: [{ name: HOSTILE }] });
    const [label] = await projectLabels();
    const seen = (await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).json?.["labels"] as string[];
    expect(seen).toEqual([HOSTILE_OUT]);
    const put = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-4", addLabels: seen });
    expect(put.isError, put.text).toBe(false);
    expect(await labelsOf(4)).toEqual([label]);
    expect(await projectLabels()).toHaveLength(1);
    const removed = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", removeLabels: [` ${HOSTILE_OUT.toUpperCase()} `] });
    expect(removed.isError, removed.text).toBe(false);
    expect(await labelsOf(3)).toEqual([]);
    expect(await projectLabels()).toEqual([label]);
  });

  it("nome cru que casa vence o limpo; dois nomes que ficam iguais depois de limpos são recusados como ambíguos", async () => {
    const token = await setup();
    const other = "Time [@Ana](person:00000000-0000-4000-8000-000000000002)";
    await route(3, { add: [{ name: HOSTILE }, { name: other }] });
    const before = await labelsOf(3);
    const out = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", removeLabels: [HOSTILE_OUT] });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/more than one label/i);
    expect(await labelsOf(3)).toEqual(before);
    // Pelo nome cru (o elo inteiro) acha a etiqueta certa.
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", removeLabels: [other] })).isError).toBe(false);
    expect((await labelsOf(3)).map((row) => row["name"])).toEqual([HOSTILE]);
    // Uma etiqueta chamada literalmente como a saída limpa casa pelo nome cru e vence.
    await route(4, { add: [{ name: HOSTILE_OUT }] });
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: [HOSTILE_OUT] })).isError).toBe(false);
    expect((await labelsOf(3)).map((row) => row["name"])).toEqual([HOSTILE_OUT, HOSTILE]);
  });

  it("removeLabels com nome que não existe no projeto: recusa a chamada inteira e nada muda; existente fora do ticket: nada a fazer", async () => {
    const token = await setup();
    await route(3, { add: [{ name: "Bug" }] });
    await route(4, { add: [{ name: "Doc" }] });
    const out = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "Não deve mudar", addLabels: ["Outra"], removeLabels: ["Bgu"] });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no label named/i);
    expect((await h.rows("select title from tickets where project_id = $1 and number = 3", [priv()]))[0]?.["title"]).toBe("Filho B");
    expect((await projectLabels()).map((row) => row["name"])).toEqual(["Bug", "Doc"]);
    const noop = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", removeLabels: ["Doc"] });
    expect(noop.isError, noop.text).toBe(false);
    expect(await labelEvents(3)).toHaveLength(1);
  });

  it("a mesma etiqueta nos dois lados, nome vazio e listas grandes são recusados; pedir nada também", async () => {
    const token = await setup();
    await route(3, { add: [{ name: "Bug" }] });
    const both = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: ["bug"], removeLabels: ["BUG"] });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/both added and removed/i);
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: ["   "] })).isError).toBe(true);
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: Array.from({ length: 21 }, (_, i) => `e${i}`) })).isError).toBe(true);
    const none = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: [] });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/labels/);
    expect((await labelsOf(3)).map((row) => row["name"])).toEqual(["Bug"]);
  });

  it("limite de 20 por ticket: recusa clara, nada muda", async () => {
    const token = await setup();
    await route(3, { add: Array.from({ length: 20 }, (_, i) => ({ name: `e${String(i).padStart(2, "0")}` })) });
    const out = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", addLabels: ["mais uma"] });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/at most 20 labels/i);
    expect(await labelsOf(3)).toHaveLength(20);
    expect(await projectLabels()).toHaveLength(20);
  });

  it("token de leitura tem list_labels e não tem as escritas", async () => {
    const read = await setup("read");
    const tools = ((await h.rpc(read, "PRIV", "tools/list")).body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[]).map((t) => [t.name, t.annotations.readOnlyHint]);
    expect(tools).toContainEqual(["list_labels", true]);
    expect(tools.map(([name]) => name)).not.toContain("update_ticket");
  });
});

describe("create_ticket com addLabels", () => {
  it("cria com as etiquetas (reusa e cria), um evento; repetir com o mesmo requestId não duplica; etiquetas diferentes = requestId reusado", async () => {
    const token = await setup();
    await route(4, { add: [{ name: "Bug" }] });
    const out = await h.tool(token, "PRIV", "create_ticket", { title: "Com etiquetas", addLabels: ["bug", "Nova"], requestId: "req-labels-1" });
    expect(out.isError, out.text).toBe(false);
    expect(out.json?.["ticket"].labels).toEqual(["Bug", "Nova"]);
    const number = Number((out.json?.["key"] as string).split("-")[1]);
    expect((await labelsOf(number)).map((row) => row["name"])).toEqual(["Bug", "Nova"]);
    expect(await labelEvents(number)).toHaveLength(1);
    const again = await h.tool(token, "PRIV", "create_ticket", { title: "Com etiquetas", addLabels: ["bug", "Nova"], requestId: "req-labels-1" });
    expect(again.json?.["key"]).toBe(out.json?.["key"]);
    expect(await labelEvents(number)).toHaveLength(1);
    const other = await h.tool(token, "PRIV", "create_ticket", { title: "Com etiquetas", addLabels: ["Outra"], requestId: "req-labels-1" });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/requestId already used/);
    // Sem etiquetas: nasce sem nenhuma.
    const plain = await h.tool(token, "PRIV", "create_ticket", { title: "Sem etiquetas" });
    expect(plain.json?.["ticket"].labels).toEqual([]);
  });

  it("removeLabels não existe na criação; nome vazio é recusado e nada é criado", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "create_ticket", { title: "X", removeLabels: ["Bug"] })).isError).toBe(true);
    expect((await h.tool(token, "PRIV", "create_ticket", { title: "Y", addLabels: [""] })).isError).toBe(true);
    expect(await h.rows("select 1 from tickets where project_id = $1 and title in ('X', 'Y')", [priv()])).toEqual([]);
  });
});

describe("equivalência MCP × tela", () => {
  it("o mesmo pedido pela rota e pelo MCP dá o mesmo estado, os mesmos eventos e a mesma linha do tempo", async () => {
    const token = await setup();
    expect((await route(3, { add: [{ name: "Doc" }, { name: "Velha" }] })).status).toBe(200);
    const [doc, velha] = await projectLabels();
    expect((await route(4, { add: [{ labelId: doc?.["id"] }, { labelId: velha?.["id"] }] })).status).toBe(200);
    // Mesmo pedido: pôr "bug" (nova, criada pela primeira; a segunda reusa), pôr "doc" (já tem), tirar "Velha".
    // Pela tela como a mesma pessoa do token (a contribuidora).
    const http = await route(3, { add: [{ name: "bug" }, { name: "doc" }], remove: [velha?.["id"]] }, "contributor");
    expect(http.status, JSON.stringify(http.body)).toBe(200);
    const mcp = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-4", addLabels: ["bug", "doc"], removeLabels: ["velha"] });
    expect(mcp.isError, mcp.text).toBe(false);
    expect(await labelsOf(4)).toEqual(await labelsOf(3));
    expect(http.body.labels.map((l: any) => l.name)).toEqual(mcp.json?.["labels"]);
    // A origem (`via` e `tokenId`, só no MCP) e a chave do ticket são as únicas diferenças.
    const strip = (payload: any) => without(payload, ["key", "via", "tokenId"]);
    const [e3, e4] = [await labelEvents(3), await labelEvents(4)];
    expect(e3).toHaveLength(2);
    expect(e4).toHaveLength(2);
    expect(strip(e4[1]?.["payload"])).toEqual(strip(e3[1]?.["payload"]));
    expect(e4[1]?.["payload"]).toMatchObject({ key: "PRIV-4", via: "mcp", tokenId: expect.any(String) });
    expect((e3[1]?.["payload"] as Record<string, unknown>)["via"]).toBeUndefined();
    const entry = (list: any[]) => list.map((item) => without(item, ["id", "occurredAt", "via"]));
    const [t3, t4] = [await timeline(3), await timeline(4)];
    expect(entry(t4)).toEqual(entry(t3));
    expect(t4[0]?.via).toBe("mcp");
  });
});

describe("get_ticket_history", () => {
  it("labels_changed sai com os nomes da época pelo limpador, sem id", async () => {
    const token = await setup("read", true);
    await route(3, { add: [{ name: HOSTILE }, { name: "Bug" }] });
    const out = await h.tool(token, "PRIV", "get_ticket_history", { key: "PRIV-3" });
    expect(out.isError, out.text).toBe(false);
    const entry = (out.json?.["events"] as any[]).find((e) => e.kind === "labels_changed");
    expect(entry).toMatchObject({ added: [HOSTILE_OUT, "Bug"], removed: [] });
    expect(out.text).not.toMatch(/person:/i);
    for (const row of await projectLabels()) expect(out.text).not.toContain(row["id"] as string);
  });
});

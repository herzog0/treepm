/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { ORG } from "./world.js";

// ADR 0068 pelo MCP: o tipo de "depende de" em add_dependency e get_ticket, o lugar na fila, e o impedimento (mark_impediment,
// clear_impediment). O motivo do impedimento NÃO sai pelas leituras do MCP (fica fora do que vai à IA, TREEPM-580).
// O projeto semeado: PRIV-1 (pai), PRIV-2 (filho concluído), PRIV-3 (filho a fazer), PRIV-4 (solto, depende de PRIV-2).
const h = useMcpHarness();
const priv = () => h.world().projects.priv;

async function setup(): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.enableMcp();
  await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
  const res = await h.create("contributor", priv(), { scope: "write" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}
const refused = (res: ToolResponse) => res.status !== 200 || res.isError || res.raw["error"] !== undefined;
const events = async (kind: string) => h.rows("select subject_id, payload from activity_events where kind = $1 order by occurred_at, id", [kind]);
const get = async (token: string, key: string) => (await h.tool(token, "PRIV", "get_ticket", { key })).json as any;

describe("add_dependency com o tipo", () => {
  it("cria 'para entregar' quando pedido; get_ticket mostra o tipo nos dois lados", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4", need: "deliver" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json?.["relations"]["depends_on"]["outgoing"]["tickets"]).toMatchObject([{ key: "PRIV-4", need: "deliver" }]);
    expect((await get(token, "PRIV-4"))["relations"]["depends_on"]).toMatchObject({ outgoing: { tickets: [{ key: "PRIV-2", need: "start" }] }, incoming: { tickets: [{ key: "PRIV-3", need: "deliver" }] } });
    const [event] = await events("ticket.dependency_added");
    expect(event?.payload).toMatchObject({ key: "PRIV-3", dependsOnKey: "PRIV-4", need: "deliver", via: "mcp" });
  });

  it("sem tipo cria 'para começar'; o mesmo par com outro tipo troca o tipo", async () => {
    const token = await setup();
    await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" });
    expect((await get(token, "PRIV-3"))["relations"]["depends_on"]["outgoing"]["tickets"]).toMatchObject([{ key: "PRIV-4", need: "start" }]);
    const changed = await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4", need: "deliver" });
    expect(changed.json?.["relations"]["depends_on"]["outgoing"]["tickets"]).toMatchObject([{ key: "PRIV-4", need: "deliver" }]);
    const [event] = await events("ticket.dependency_need_changed");
    expect(event?.payload).toMatchObject({ key: "PRIV-3", need: { from: "start", to: "deliver" }, via: "mcp" });
  });

  it("tipo desconhecido é recusado", async () => {
    const token = await setup();
    expect(refused(await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4", need: "later" }))).toBe(true);
  });

  it("concluir com dependência para entregar aberta é recusado, e a frase diz a chave que falta", async () => {
    const token = await setup();
    await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-4", dependsOn: "PRIV-3", need: "deliver" });
    const res = await h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-4", status: "done" });
    expect(refused(res)).toBe(true);
    expect(res.text).toContain("PRIV-3");
    expect(res.text).toContain("deliver");
  });
});

describe("get_ticket: bloqueado e lugar na fila", () => {
  it("lugar na fila: livre, próximo e nulo para o pai e o concluído", async () => {
    const token = await setup();
    expect(await get(token, "PRIV-4")).toMatchObject({ blocked: false, place: "free" });
    expect(await get(token, "PRIV-1")).toMatchObject({ place: null });
    expect(await get(token, "PRIV-2")).toMatchObject({ place: null });
    await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-4", dependsOn: "PRIV-3" });
    expect(await get(token, "PRIV-4")).toMatchObject({ place: "next" });
  });
});

describe("mark_impediment e clear_impediment", () => {
  it("marcar deixa o ticket bloqueado sem o motivo sair na leitura; limpar volta; os eventos levam a origem MCP", async () => {
    const token = await setup();
    const reason = "Esperando a chave secreta do fornecedor";
    const res = await h.tool(token, "PRIV", "mark_impediment", { key: "PRIV-3", reason });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-3", blocked: true });
    expect(res.text).not.toContain("chave secreta");
    expect(JSON.stringify(await get(token, "PRIV-3"))).not.toContain("chave secreta");
    expect((await h.rows("select impediment_reason from tickets where project_id = $1 and number = 3", [priv()]))[0]?.impediment_reason).toBe(reason);
    expect((await events("ticket.impediment_marked"))[0]?.payload).toMatchObject({ key: "PRIV-3", via: "mcp" });
    const cleared = await h.tool(token, "PRIV", "clear_impediment", { key: "PRIV-3" });
    expect(cleared.json).toMatchObject({ key: "PRIV-3", blocked: false });
    expect((await events("ticket.impediment_cleared"))[0]?.payload).toMatchObject({ key: "PRIV-3", via: "mcp" });
  });

  it("ticket concluído, motivo vazio ou com menção a pessoa: recusados", async () => {
    const token = await setup();
    const done = await h.tool(token, "PRIV", "mark_impediment", { key: "PRIV-2", reason: "motivo" });
    expect(refused(done)).toBe(true);
    expect(done.text).toContain("cannot be marked as blocked");
    expect(refused(await h.tool(token, "PRIV", "mark_impediment", { key: "PRIV-3", reason: "   " }))).toBe(true);
  });
});

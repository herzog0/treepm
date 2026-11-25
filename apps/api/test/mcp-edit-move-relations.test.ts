/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { personLink } from "@treepm/domain";
import { MINUTE } from "./access-token-support.js";
import { LINEAR_CONFIG } from "./helpers.js";
import { KEY, TEAM_ENG, linkWithData } from "./linear-support.js";
import type { FakeIssue } from "./linear-support.js";
import { rpcBody, rpcHeaders, seedProject, useMcpHarness } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { WRITE_TOOL_NAMES } from "../src/mcp/mcp-write-tools.js";
import { ORG, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0062, fatia 1 (TREEPM-493): update_ticket, move_ticket, add_dependency e remove_dependency. Nenhuma tem regra própria:
// todas chamam o serviço da tela. Os testes provam a lista de escritas, o gateway, as recusas, as regras e a paridade com a rota HTTP.
const h = useMcpHarness(LINEAR_CONFIG);
const priv = () => h.world().projects.priv;
const put = (who: Who, apiKey: string = KEY) => h.call("PUT", "/api/linear/connection", as(who), { apiKey });
const NEW_TOOLS = ["update_ticket", "move_ticket", "add_dependency", "remove_dependency"];

async function setup(who: Who = "contributor", scope: "read" | "write" = "write"): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.enableMcp();
  await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
  const res = await h.create(who, priv(), { scope });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}
const refused = (res: ToolResponse) => res.status !== 200 || res.isError || res.raw["error"] !== undefined;
const idOf = async (n: number, project = priv()) => (await h.rows("select id from tickets where project_id = $1 and number = $2", [project, n]))[0]?.id as string;
const parentNumber = async (n: number) => (await h.rows("select p.number from tickets t left join tickets p on p.id = t.parent_id where t.project_id = $1 and t.number = $2", [priv(), n]))[0]?.number as number | null;
const events = async (kind: string) => h.rows("select subject_id, payload from activity_events where kind = $1 order by occurred_at, id", [kind]);
const count = async (sql: string, params: unknown[] = []) => Number((await h.rows(sql, params))[0]?.n);
const deps = async () => h.rows("select f.number as from_n, t.number as to_n from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = 'depends_on' order by 1, 2");

describe("a lista de escritas (estrutural)", () => {
  it("toda ferramenta registrada no bloco de escrita de mcp-server.ts está em WRITE_TOOL_NAMES, e vice-versa", () => {
    const source = readFileSync(new URL("../src/mcp/mcp-server.ts", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("if (write) {"));
    const registered = [...block.matchAll(/server\.registerTool\("([a-z_]+)"/g)].map((m) => m[1] as string).sort();
    expect(registered).toEqual([...WRITE_TOOL_NAMES].sort());
    for (const name of NEW_TOOLS) expect(WRITE_TOOL_NAMES as readonly string[]).toContain(name);
    // nenhuma ferramenta de leitura (fora do bloco) pode estar na lista de escritas
    const reads = [...source.slice(0, source.indexOf("if (write) {")).matchAll(/server\.registerTool\("([a-z_]+)"/g)].map((m) => m[1] as string);
    for (const name of reads) expect(WRITE_TOOL_NAMES as readonly string[]).not.toContain(name);
  });

  it("tools/list: as quatro novas aparecem só para token de escrita com a chave ligada, marcadas como de escrita, com descrição em inglês", async () => {
    const token = await setup();
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string; annotations: any }[];
    for (const name of NEW_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations.readOnlyHint).toBe(false);
      expect(tool?.description).toMatch(/^[\x20-\x7e]+$/);
    }
    const read = await h.create("contributor", priv(), { scope: "read" });
    const readTools = (await h.rpc(read.body.token, "PRIV", "tools/list")).body.result.tools as { name: string }[];
    expect(readTools.map((t) => t.name).filter((n) => NEW_TOOLS.includes(n))).toEqual([]);
    await h.pool.query("update organizations set mcp_write_enabled = false where org_id = $1", [ORG]);
    const off = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string }[];
    expect(off.map((t) => t.name).filter((n) => NEW_TOOLS.includes(n))).toEqual([]);
  });
});

describe("o gateway trata as ferramentas novas como escrita", () => {
  const calls: Record<string, Record<string, unknown>> = {
    update_ticket: { key: "PRIV-3", title: "Novo título" },
    move_ticket: { key: "PRIV-4", parent: "PRIV-3" },
    add_dependency: { key: "PRIV-3", dependsOn: "PRIV-4" },
    remove_dependency: { key: "PRIV-4", dependsOn: "PRIV-2" },
  };
  const unchanged = async () => {
    expect(await count("select count(*)::int n from activity_events where kind in ('ticket.updated','ticket.dependency_added','ticket.dependency_removed')")).toBe(0);
    expect((await h.rows("select title from tickets where project_id = $1 and number = 3", [priv()]))[0]?.title).toBe("Filho B");
    expect(await parentNumber(4)).toBeNull();
  };

  for (const [name, args] of Object.entries(calls)) {
    it(`${name}: token só de leitura e organização com a escrita desligada são recusados sem efeito`, async () => {
      const read = await setup("contributor", "read");
      expect(refused(await h.tool(read, "PRIV", name, args))).toBe(true);
      const write = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
      await h.pool.query("update organizations set mcp_write_enabled = false where org_id = $1", [ORG]);
      expect(refused(await h.tool(write, "PRIV", name, args))).toBe(true);
      await unchanged();
    });

    it(`${name}: lote com escrita é recusado inteiro`, async () => {
      const token = await setup();
      const batch = [rpcBody("tools/call", { name: "get_ticket", arguments: { key: "PRIV-3" } }, 1), rpcBody("tools/call", { name, arguments: args }, 2)];
      expect((await h.post(token, "PRIV", batch, rpcHeaders("tools/call", { name }))).status).toBe(400);
      await unchanged();
    });

    it(`${name}: pessoa que saiu da organização escreve zero vezes, mesmo dentro da janela de 5 minutos`, async () => {
      const token = await setup();
      expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200); // aquece a memória
      h.directory().memberships.set(`${ORG}:u_contributor`, null);
      h.clock.advance(MINUTE);
      expect((await h.tool(token, "PRIV", name, args)).status).toBe(401);
      await unchanged();
    });
  }

  it("o limite de 20 escritas por minuto por token conta as ferramentas novas; a leitura não é afetada", async () => {
    const token = await setup();
    for (let i = 0; i < 20; i += 1) expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: `T${i}` })).status, `#${i}`).toBe(200);
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "T20" })).status).toBe(429);
    expect((await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-3" })).status).toBe(429);
    expect((await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" })).status).toBe(429);
    expect((await h.tool(token, "PRIV", "remove_dependency", { key: "PRIV-4", dependsOn: "PRIV-2" })).status).toBe(429);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
  });
});

describe("as mesmas recusas das escritas atuais", () => {
  type Case = { name: string; prepare: () => Promise<Who>; token?: Who };
  const cases: Case[] = [
    { name: "leitor do projeto", prepare: async () => "reader", token: "reader" },
    { name: "projeto arquivado", prepare: async () => { await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]); return "contributor"; } },
    { name: "papel removido depois do token", prepare: async () => { await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]); await h.pool.query("delete from project_teams where project_id = $1", [priv()]); return "contributor"; } },
  ];
  const attempts: [string, Record<string, unknown>][] = [
    ["update_ticket", { key: "PRIV-3", title: "Mudou" }],
    ["move_ticket", { key: "PRIV-4", parent: "PRIV-3" }],
    ["add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" }],
    ["remove_dependency", { key: "PRIV-4", dependsOn: "PRIV-2" }],
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const token = await setup(c.token ?? "contributor");
      await c.prepare();
      for (const [tool, args] of attempts) expect(refused(await h.tool(token, "PRIV", tool, args)), tool).toBe(true);
      expect((await h.rows("select title from tickets where project_id = $1 and number = 3", [priv()]))[0]?.title).toBe("Filho B");
      expect(await parentNumber(4)).toBeNull();
      expect((await deps()).length).toBe(1);
    });
  }

  it("ticket inexistente, ticket de outro projeto e ticket de outra organização: recusados, e a recusa não diz se existe", async () => {
    const token = await setup();
    const texts: string[] = [];
    for (const [tool, args] of attempts) {
      const missing = await h.tool(token, "PRIV", tool, { ...args, key: "PRIV-99" });
      const otherProject = await h.tool(token, "PRIV", tool, { ...args, key: "OPEN-1" });
      expect(refused(missing) && refused(otherProject), tool).toBe(true);
      texts.push(missing.text, otherProject.text);
    }
    const other = await h.issueOther();
    for (const [tool, args] of attempts) expect(refused(await h.tool(other.token, "PRIV", tool, args)), tool).toBe(true);
    // o segundo ticket (parent / dependsOn) de outro projeto ou inexistente: a mesma frase curta
    const parentMissing = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-99" });
    const parentOther = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "OPEN-1" });
    expect(refused(parentMissing) && refused(parentOther)).toBe(true);
    expect(parentOther.text).not.toMatch(/exist/i);
    const depMissing = await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-99" });
    const depOther = await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "OPEN-1" });
    expect(refused(depMissing) && refused(depOther)).toBe(true);
    for (const text of [...texts, parentMissing.text, parentOther.text, depMissing.text, depOther.text]) expect(text).not.toMatch(/Filho|Raiz|Solto/);
    expect(await parentNumber(4)).toBeNull();
    expect((await deps()).length).toBe(1);
  });
});

describe("update_ticket", () => {
  it("muda título e descrição, devolve o ticket como get_ticket, marca a origem MCP e refaz as menções de ticket", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "Relatórios novos", description: "Agora ligado a PRIV-4." });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-3", title: "Relatórios novos" });
    expect(res.json).toHaveProperty("relations");
    expect((await h.rows("select title, description from tickets where project_id = $1 and number = 3", [priv()]))[0]).toEqual({ title: "Relatórios novos", description: "Agora ligado a PRIV-4." });
    const [event] = await events("ticket.updated");
    expect(event?.payload).toMatchObject({ key: "PRIV-3", fields: ["title", "description"], via: "mcp" });
    expect((event?.payload as any).tokenId).toBeTruthy();
    expect(await count("select count(*)::int n from ticket_relations r join tickets f on f.id = r.from_ticket_id where r.kind = 'mentions' and f.number = 3 and f.project_id = $1", [priv()])).toBe(1);
    // repetir a mesma chamada é inofensivo: nada muda, nenhum segundo evento
    await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "Relatórios novos", description: "Agora ligado a PRIV-4." });
    expect((await events("ticket.updated")).length).toBe(1);
  });

  it("só descrição ou só título; não aceita situação, prioridade nem pai; ao menos um campo", async () => {
    const token = await setup();
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", description: "Só a descrição" })).isError).toBe(false);
    expect((await h.rows("select title, description from tickets where project_id = $1 and number = 3", [priv()]))[0]).toEqual({ title: "Filho B", description: "Só a descrição" });
    for (const extra of [{ status: "done" }, { priority: 5 }, { parent: "PRIV-1" }, { parentId: null }]) {
      expect(refused(await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "X", ...extra })), JSON.stringify(extra)).toBe(true);
    }
    expect(refused(await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3" }))).toBe(true);
    expect((await h.rows("select title, status, priority from tickets where project_id = $1 and number = 3", [priv()]))[0]).toEqual({ title: "Filho B", status: "todo", priority: 0 });
  });

  it("título vazio, título e descrição acima do limite: recusados, nada muda", async () => {
    const token = await setup();
    const attempts = [{ title: "" }, { title: "   " }, { title: "x".repeat(201) }, { description: "d".repeat(20_001) }];
    for (const args of attempts) expect(refused(await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", ...args })), JSON.stringify(args).slice(0, 40)).toBe(true);
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: "x".repeat(200) })).isError).toBe(false);
    expect((await events("ticket.updated")).length).toBe(1);
  });

  it("menção de pessoa na descrição (e no título) é recusada, em todas as formas", async () => {
    const token = await setup();
    const link = personLink("11111111-1111-4111-8111-111111111111", "Alice");
    for (const args of [{ description: `Fale com ${link}` }, { description: `\`${link}\`` }, { description: "> ```\n> " + link + "\n> ```" }, { title: link }, { description: link.replace("person:", "PERSON:") }]) {
      const res = await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", ...args });
      expect(res.isError, res.text).toBe(true);
      expect(res.text).toContain("person_mention_not_allowed");
    }
    expect((await h.rows("select title, description from tickets where project_id = $1 and number = 3", [priv()]))[0]).toEqual({ title: "Filho B", description: "Segundo filho sobre relatórios" });
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", description: "Veja #PRIV-1 e @Alice" })).isError).toBe(false);
  });

  const SECRET_TITLE = "TituloSecretoDoTeste";
  const SECRET_BODY = "CorpoSecretoDoTeste";
  const spies = () => (["log", "error", "warn", "debug", "verbose", "fatal"] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it("nem o título nem a descrição entram em log, nas chamadas boas, nas recusadas e nas que falham", async () => {
    const token = await setup();
    const logged = spies();
    const out = vi.spyOn(process.stdout, "write");
    const errOut = vi.spyOn(process.stderr, "write");
    await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: SECRET_TITLE, description: SECRET_BODY });
    await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: SECRET_TITLE, description: `${SECRET_BODY} ${personLink("11111111-1111-4111-8111-111111111111", "Alice")}` });
    await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-99", title: SECRET_TITLE, description: SECRET_BODY });
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-3", title: SECRET_TITLE, description: SECRET_BODY });
    const seen = [...logged.flatMap((spy) => spy.mock.calls), ...out.mock.calls, ...errOut.mock.calls].map((call) => JSON.stringify(call)).join("\n");
    expect(seen).not.toContain(SECRET_TITLE);
    expect(seen).not.toContain(SECRET_BODY);
  });
});

describe("move_ticket", () => {
  it("move para dentro de outro ticket e para a raiz; devolve o ticket; um evento com a origem MCP; repetir não gera outro", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-3" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-4", parent: "PRIV-3" });
    expect(await parentNumber(4)).toBe(3);
    const [event] = await events("ticket.updated");
    expect(event?.payload).toMatchObject({ key: "PRIV-4", fields: ["parentId"], via: "mcp" });
    await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-3" });
    expect((await events("ticket.updated")).length).toBe(1);
    const root = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: null });
    expect(root.isError, root.text).toBe(false);
    expect(root.json).toMatchObject({ key: "PRIV-4", parent: null });
    expect(await parentNumber(4)).toBeNull();
    expect(refused(await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4" }))).toBe(true); // parent é obrigatório (null é a raiz)
    expect(refused(await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-3", title: "x" }))).toBe(true);
  });

  it("ciclo: para dentro de si mesmo ou de um descendente é recusado, e a árvore fica como estava", async () => {
    const token = await setup();
    expect(refused(await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-1", parent: "PRIV-3" }))).toBe(true);
    expect(refused(await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-1", parent: "PRIV-1" }))).toBe(true);
    expect(await parentNumber(1)).toBeNull();
    expect(await parentNumber(3)).toBe(1);
  });

  it("profundidade: a cadeia longa se comporta como na rota HTTP (mesmo resultado nas duas portas)", async () => {
    const token = await setup();
    // cadeia 5 -> 6 -> ... -> 30 (cada um filho do anterior), com 4 solto
    let parent: string | null = null;
    for (let n = 5; n <= 30; n += 1) {
      const row: { rows: { id: string }[] } = await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ($1,$2,$3,$4,$5,$6) returning id", [ORG, priv(), n, parent, `n${n}`, h.world().people.manager]);
      parent = row.rows[0]?.id ?? null;
    }
    await h.pool.query("update projects set next_ticket_number = 31 where id = $1", [priv()]);
    const http = await h.call("PATCH", `/api/tickets/${await idOf(4)}`, as("contributor"), { parentId: await idOf(30) });
    const mcp = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-30" });
    expect(refused(mcp)).toBe(http.status >= 400);
    // para dentro do próprio descendente profundo: ciclo nas duas portas
    const cycleHttp = await h.call("PATCH", `/api/tickets/${await idOf(5)}`, as("contributor"), { parentId: await idOf(30) });
    const cycleMcp = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-5", parent: "PRIV-30" });
    expect(cycleHttp.status).toBe(409);
    expect(refused(cycleMcp)).toBe(true);
  });

  it("ticket aberto para baixo de um pai concluído reabre o pai (evento automático, origem MCP)", async () => {
    const token = await setup();
    expect((await h.rows("select status from tickets where project_id = $1 and number = 2", [priv()]))[0]?.status).toBe("done");
    const res = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-2" });
    expect(res.isError, res.text).toBe(false);
    expect((await h.rows("select status from tickets where project_id = $1 and number = 2", [priv()]))[0]?.status).toBe("todo");
    const reopened = (await events("ticket.updated")).find((e) => (e.payload as any).key === "PRIV-2");
    expect(reopened?.payload).toMatchObject({ automatic: true, causedBy: "PRIV-4", via: "mcp" });
  });

  it("regras de ideia iguais às da tela: trabalho em andamento não entra numa ideia; o que está a fazer entra", async () => {
    const token = await setup();
    await h.pool.query("update tickets set idea_stage = 'new' where project_id = $1 and number = 4", [priv()]);
    const http = await h.call("PATCH", `/api/tickets/${await idOf(1)}`, as("contributor"), { parentId: await idOf(4) });
    expect(http.status).toBe(409);
    const blocked = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-1", parent: "PRIV-4" });
    expect(refused(blocked)).toBe(true);
    expect(await parentNumber(1)).toBeNull();
    const ok = await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-3", parent: "PRIV-4" });
    expect(ok.isError, ok.text).toBe(false);
    expect(await parentNumber(3)).toBe(4);
  });

  it("duas movimentações simultâneas do mesmo projeto (uma para dentro da outra) não fecham um ciclo: a trava é a real", async () => {
    const token = await setup();
    for (let round = 0; round < 3; round += 1) {
      await h.pool.query("update tickets set parent_id = null where project_id = $1 and number in (3, 4)", [priv()]);
      const [a, b] = await Promise.all([h.tool(token, "PRIV", "move_ticket", { key: "PRIV-3", parent: "PRIV-4" }), h.tool(token, "PRIV", "move_ticket", { key: "PRIV-4", parent: "PRIV-3" })]);
      expect([a, b].filter((r) => !refused(r)).length, `${a.text} | ${b.text}`).toBe(1);
      const p3 = await parentNumber(3);
      const p4 = await parentNumber(4);
      expect(p3 === 4 && p4 === 3).toBe(false);
      expect(p3 === 4 || p4 === 3).toBe(true);
    }
  });
});

describe("add_dependency e remove_dependency", () => {
  it("cria 'depende de', devolve o ticket, grava um evento com a origem MCP e é idempotente como a tela", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-3" });
    expect(JSON.stringify(res.json?.["relations"]["depends_on"]["outgoing"])).toContain("PRIV-4");
    expect(await deps()).toEqual([{ from_n: 3, to_n: 4 }, { from_n: 4, to_n: 2 }]);
    const [event] = await events("ticket.dependency_added");
    expect(event?.payload).toMatchObject({ key: "PRIV-3", dependsOnKey: "PRIV-4", via: "mcp" });
    expect((await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" })).isError).toBe(false);
    expect((await events("ticket.dependency_added")).length).toBe(1);
  });

  it("si mesmo, ciclo (direto e indireto) e outro projeto: recusados, sem ligação nova", async () => {
    const token = await setup();
    expect(refused(await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-3" }))).toBe(true);
    expect(refused(await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-2", dependsOn: "PRIV-4" }))).toBe(true); // 4 já depende de 2
    expect((await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "PRIV-4" })).isError).toBe(false);
    expect(refused(await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-2", dependsOn: "PRIV-3" }))).toBe(true); // 3 -> 4 -> 2: indireto
    expect(refused(await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-3", dependsOn: "OPEN-1" }))).toBe(true);
    expect(await deps()).toEqual([{ from_n: 3, to_n: 4 }, { from_n: 4, to_n: 2 }]);
  });

  it("remove a ligação, grava um evento, e remover o que não existe é recusado como na tela", async () => {
    const token = await setup();
    const res = await h.tool(token, "PRIV", "remove_dependency", { key: "PRIV-4", dependsOn: "PRIV-2" });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-4" });
    expect(await deps()).toEqual([]);
    const [event] = await events("ticket.dependency_removed");
    expect(event?.payload).toMatchObject({ key: "PRIV-4", dependsOnKey: "PRIV-2", via: "mcp" });
    const again = await h.tool(token, "PRIV", "remove_dependency", { key: "PRIV-4", dependsOn: "PRIV-2" });
    const http = await h.call("DELETE", `/api/tickets/${await idOf(4)}/dependencies/${await idOf(2)}`, as("contributor"));
    expect(http.status).toBe(404);
    expect(refused(again)).toBe(true);
    expect((await events("ticket.dependency_removed")).length).toBe(1);
  });
});

describe("paridade: a mesma mudança pela rota HTTP e pelo MCP dá o mesmo estado e os mesmos eventos", () => {
  /** Dois pares idênticos (A pela tela, B pelo MCP): ticket "Par" e pai "Pai par", com a mesma descrição e a mesma situação. */
  async function pairs(): Promise<void> {
    const add = async (n: number, title: string, parent: number | null, description = "") => {
      await h.pool.query(
        "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ($1,$2,$3,(select id from tickets where project_id = $2 and number = $4),$5,$6,$7)",
        [ORG, priv(), n, parent, title, description, h.world().people.manager],
      );
    };
    await add(10, "Pai par", null);
    await add(11, "Pai par", null);
    await add(12, "Par", null, "Texto inicial");
    await add(13, "Par", null, "Texto inicial");
    await add(14, "Outro par", null);
    await add(15, "Outro par", null);
    await h.pool.query("update projects set next_ticket_number = 16 where id = $1", [priv()]);
  }
  /** O estado de um ticket e os eventos dele, sem o que difere por natureza (números, ids, origem). */
  async function view(n: number): Promise<unknown> {
    const t = (await h.rows("select t.title, t.description, t.status, p.title as parent_title from tickets t left join tickets p on p.id = t.parent_id where t.project_id = $1 and t.number = $2", [priv(), n]))[0];
    const ev = await h.rows("select e.kind, e.payload from activity_events e join tickets t on t.id::text = e.subject_id::text where t.project_id = $1 and t.number = $2 order by e.occurred_at, e.id", [priv(), n]);
    const clean = ev.map((e) => {
      const payload = { ...(e.payload as Record<string, any>) };
      for (const k of ["key", "via", "tokenId", "dependsOnKey", "dependsOnTicketId"]) delete payload[k];
      if (payload["parentId"]) payload["parentId"] = { from: payload["parentId"].from === null ? null : "id", to: payload["parentId"].to === null ? null : "id" };
      return { kind: e.kind, payload };
    });
    const relations = (await h.rows("select r.kind, o.title from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets o on o.id = r.to_ticket_id where f.project_id = $1 and f.number = $2 order by 1, 2", [priv(), n]));
    return { t, clean, relations };
  }

  it("update_ticket", async () => {
    const token = await setup();
    await pairs();
    const body = { title: "Par novo", description: "Veja #PRIV-14 agora" };
    expect((await h.call("PATCH", `/api/tickets/${await idOf(12)}`, as("contributor"), body)).status).toBe(200);
    expect((await h.tool(token, "PRIV", "update_ticket", { key: "PRIV-13", ...body })).isError).toBe(false);
    // as menções apontam para tickets de mesmo título (14 e 15 são "Outro par"): a descrição cita o 14 nos dois, então a ligação é igual
    expect(await view(13)).toEqual(await view(12));
  });

  it("move_ticket", async () => {
    const token = await setup();
    await pairs();
    expect((await h.call("PATCH", `/api/tickets/${await idOf(12)}`, as("contributor"), { parentId: await idOf(10) })).status).toBe(200);
    expect((await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-13", parent: "PRIV-11" })).isError).toBe(false);
    expect(await view(13)).toEqual(await view(12));
    expect((await h.call("PATCH", `/api/tickets/${await idOf(12)}`, as("contributor"), { parentId: null })).status).toBe(200);
    expect((await h.tool(token, "PRIV", "move_ticket", { key: "PRIV-13", parent: null })).isError).toBe(false);
    expect(await view(13)).toEqual(await view(12));
  });

  it("add_dependency e remove_dependency", async () => {
    const token = await setup();
    await pairs();
    expect((await h.call("POST", `/api/tickets/${await idOf(12)}/dependencies`, as("contributor"), { ticketId: await idOf(14) })).status).toBe(200);
    expect((await h.tool(token, "PRIV", "add_dependency", { key: "PRIV-13", dependsOn: "PRIV-15" })).isError).toBe(false);
    const added = await view(12);
    expect(await view(13)).toEqual(added);
    expect((added as any).clean.length).toBe(1);
    expect((await h.call("DELETE", `/api/tickets/${await idOf(12)}/dependencies/${await idOf(14)}`, as("contributor"))).status).toBe(204);
    expect((await h.tool(token, "PRIV", "remove_dependency", { key: "PRIV-13", dependsOn: "PRIV-15" })).isError).toBe(false);
    expect(await view(13)).toEqual(await view(12));
  });
});

describe("Linear: o que foi mexido pelo MCP conta como mexido aqui na reimportação", () => {
  const open = () => h.world().projects.org;
  const world = (): { list: FakeIssue[]; data: Record<string, any> } => {
    const list: FakeIssue[] = [
      { id: "p1", identifier: "ENG-1", title: "Pai um", project: "lp1" },
      { id: "p2", identifier: "ENG-2", title: "Pai dois", project: "lp1" },
      { id: "a", identifier: "ENG-3", title: "Título A", description: "Descrição A", project: "lp1" },
      { id: "h", identifier: "ENG-9", title: "Título H", parent: "p1" },
    ];
    return { list, data: { [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa" }], issues: list } } };
  };
  const post = (path: string, body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as("admin"), body);
  async function runAll(): Promise<void> {
    const run = await post("");
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    for (let i = 0; i < 120; i += 1) {
      const res = await post(`/${run.body.id}/step`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      if (res.body.done) return;
    }
    throw new Error("rodada não terminou");
  }
  const byExt = async (external: string) =>
    (await h.rows("select t.id, t.number, t.title, t.description, p.number as parent_number from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id left join tickets p on p.id = t.parent_id where r.project_id = $1 and r.external_id = $2", [open(), external]))[0] as any;

  async function writeToken(): Promise<string> {
    await h.enableMcp();
    await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
    const res = await h.create("admin", open(), { scope: "write" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.token as string;
  }
  const keyOf = (n: number) => `OPEN-${n}`;

  it("ticket importado e movido por move_ticket: a reimportação não o leva de volta", async () => {
    const w = world();
    await linkWithData(h, put, open(), w.data);
    await runAll();
    const token = await writeToken();
    const moved = await h.tool(token, "OPEN", "move_ticket", { key: keyOf((await byExt("h")).number), parent: keyOf((await byExt("p2")).number) });
    expect(moved.isError, moved.text).toBe(false);
    const where = (await byExt("h")).parent_number;
    expect(where).toBe((await byExt("p2")).number);
    // no Linear o pai muda de novo e o título também; aqui o ticket foi movido, então fica onde está
    w.list.find((i) => i.id === "h")!.parent = "p1";
    w.list.find((i) => i.id === "h")!.title = "Título H do Linear";
    await runAll();
    expect((await byExt("h")).parent_number).toBe(where);
  });

  it("ticket importado com título e descrição editados por update_ticket: a reimportação não os sobrescreve", async () => {
    const w = world();
    await linkWithData(h, put, open(), w.data);
    await runAll();
    const token = await writeToken();
    const a = await byExt("a");
    const edited = await h.tool(token, "OPEN", "update_ticket", { key: keyOf(a.number), title: "A editado pelo MCP", description: "Descrição do MCP" });
    expect(edited.isError, edited.text).toBe(false);
    w.list.find((i) => i.id === "a")!.title = "Título A novo no Linear";
    w.list.find((i) => i.id === "a")!.description = "Descrição A nova no Linear";
    await runAll();
    const after = await byExt("a");
    expect(after.title).toBe("A editado pelo MCP");
    expect(after.description).toBe("Descrição do MCP");
  });
});

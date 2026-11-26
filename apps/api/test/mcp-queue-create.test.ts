/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona resultados JSON */
import { describe, expect, it } from "vitest";
import { WRITE_LIMIT_PER_PERSON_PER_MINUTE } from "../src/mcp/mcp-gateway.js";
import { rpcBody, rpcHeaders, seedProject, useMcpHarness, useSmallLimits } from "./mcp-support.js";
import type { ToolResponse } from "./mcp-support.js";
import { ORG, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0043, adendo de 2026-11-23 (TREEPM-258): get_work_queue, set_ticket_priority e create_ticket.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const people = () => h.world().people;
const refused = (res: ToolResponse) => res.status !== 200 || res.isError || res.raw["error"] !== undefined;
const countRows = async (sql: string, params: unknown[] = []) => Number((await h.rows(sql, params))[0]?.n);

async function writeOn(on = true): Promise<void> {
  await h.pool.query("update organizations set mcp_write_enabled = $2 where org_id = $1", [ORG, on]);
}
/** Semeia o projeto, liga as duas chaves e cria um token da pessoa com o alcance pedido. */
async function setup(who: Who = "contributor", scope: "read" | "write" = "write"): Promise<{ token: string; id: string }> {
  await seedProject(h.pool, priv(), people().manager, people().contributor);
  await h.enableMcp();
  await writeOn();
  const res = await h.create(who, priv(), { scope });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: res.body.token as string, id: res.body.id as string };
}
const setPriority = (number: number, value: number) => h.pool.query("update tickets set priority = $2 where project_id = $1 and number = $3", [priv(), value, number]);
const keys = (res: ToolResponse): string[] => (res.json?.["tickets"] as any[]).map((t) => t.key);
const queue = (token: string, args: Record<string, unknown> = {}) => h.tool(token, "PRIV", "get_work_queue", args);

describe("get_work_queue", () => {
  it("devolve a fila da pessoa na ordem da ADR 0047, com prioridade própria, a que vale e o caminho", async () => {
    const { token } = await setup("contributor", "read");
    const res = await queue(token);
    expect(res.isError, res.text).toBe(false);
    // PRIV-1 está em andamento (fora); PRIV-4 é da pessoa e PRIV-3 é de ninguém, então a da pessoa vem antes com prioridade igual.
    expect(keys(res)).toEqual(["PRIV-4", "PRIV-3"]);
    expect(res.json).toMatchObject({ total: 2, truncated: false, empty_reason: null });
    expect(res.json?.["tickets"][1]).toMatchObject({ key: "PRIV-3", title: "Filho B", status: "todo", parent: "PRIV-1", priority: 0, effective_priority: 0, path: [{ key: "PRIV-1", title: "Raiz do projeto" }] });
    expect(res.json?.["tickets"][0]).toMatchObject({ key: "PRIV-4", parent: null, path: [] });
    await setPriority(3, 5);
    expect(keys(await queue(token))).toEqual(["PRIV-3", "PRIV-4"]);
  });

  it("a prioridade herdada do ancestral vale na ordem", async () => {
    const { token } = await setup("contributor", "read");
    await setPriority(1, 9);
    const res = await queue(token);
    expect(keys(res)).toEqual(["PRIV-3", "PRIV-4"]);
    expect(res.json?.["tickets"][0]).toMatchObject({ priority: 0, effective_priority: 9 });
  });

  it("token de leitura basta; token de escrita também a lê; a saída bate com o schema declarado", async () => {
    const read = await setup("contributor", "read");
    const write = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    expect((await queue(read.token)).isError).toBe(false);
    expect(keys(await queue(write))).toEqual(["PRIV-4", "PRIV-3"]);
    const tools = (await h.rpc(read.token, "PRIV", "tools/list")).body.result.tools as { name: string; annotations: any; outputSchema: unknown }[];
    const tool = tools.find((t) => t.name === "get_work_queue");
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(tool?.outputSchema).toBeTruthy();
  });

  it("under restringe ao ramo; chave de outro projeto, inexistente ou malformada é erro de entrada", async () => {
    const { token } = await setup("contributor", "read");
    expect(keys(await queue(token, { under: "PRIV-1" }))).toEqual(["PRIV-3"]);
    expect(keys(await queue(token, { under: "PRIV-4" }))).toEqual(["PRIV-4"]);
    for (const under of ["PRIV-99", "OUTRO-1", "PRIV-03", "xx"]) {
      const res = await queue(token, { under });
      expect(res.isError, under).toBe(true);
    }
  });

  it("limit: padrão 20, máximo 50; mostra o total e marca truncated", async () => {
    const { token } = await setup("contributor", "read");
    const one = await queue(token, { limit: 1 });
    expect(keys(one)).toEqual(["PRIV-4"]);
    expect(one.json).toMatchObject({ total: 2, truncated: true });
    for (const limit of [0, 51, 1.5, "x"]) expect((await queue(token, { limit })).isError, String(limit)).toBe(true);
    expect((await queue(token, { limit: 50 })).isError).toBe(false);
    for (let n = 5; n < 30; n += 1) {
      await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,'Extra',$4)", [ORG, priv(), n, people().manager]);
    }
    const many = await queue(token);
    expect(many.json?.["tickets"]).toHaveLength(20);
    expect(many.json).toMatchObject({ total: 27, truncated: true });
  });

  it("fica de fora: ideia, ticket dentro de ideia, bloqueado, de outra pessoa, com marcador de agente e fora de todo", async () => {
    const { token } = await setup("contributor", "write");
    await h.pool.query("update tickets set idea_stage = 'new' where project_id = $1 and number = 3", [priv()]);
    expect(keys(await queue(token))).toEqual(["PRIV-4"]);
    await h.pool.query("update tickets set idea_stage = null where project_id = $1 and number = 3", [priv()]);
    // Marcador de trabalho de um agente: o ticket sai da fila.
    expect((await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true })).isError).toBe(false);
    expect(keys(await queue(token))).toEqual(["PRIV-4"]);
    await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: false });
    // De outra pessoa.
    await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) select $1, id, $3 from tickets where project_id = $2 and number = 3", [ORG, priv(), people().manager]);
    expect(keys(await queue(token))).toEqual(["PRIV-4"]);
    // Bloqueado por ticket aberto.
    await h.pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) select $1, $2, a.id, b.id, 'depends_on' from tickets a, tickets b where a.project_id = $2 and b.project_id = $2 and a.number = 4 and b.number = 1", [ORG, priv()]);
    expect(keys(await queue(token))).toEqual([]);
  });

  it("fila vazia diz o motivo: all_blocked, all_others e none", async () => {
    const { token } = await setup("contributor", "read");
    const block = (number: number) =>
      h.pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) select $1, $2, a.id, b.id, 'depends_on' from tickets a, tickets b where a.project_id = $2 and b.project_id = $2 and a.number = $3 and b.number = 1", [ORG, priv(), number]);
    await block(3);
    await block(4);
    expect((await queue(token)).json).toMatchObject({ tickets: [], total: 0, truncated: false, empty_reason: "all_blocked" });
    await h.pool.query("delete from ticket_relations where kind = 'depends_on' and from_ticket_id in (select id from tickets where project_id = $1 and number in (3, 4))", [priv()]);
    await h.pool.query("delete from ticket_assignees where ticket_id in (select id from tickets where project_id = $1)", [priv()]);
    for (const number of [3, 4]) {
      await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) select $1, id, $3 from tickets where project_id = $2 and number = $4", [ORG, priv(), people().manager, number]);
    }
    expect((await queue(token)).json).toMatchObject({ total: 0, empty_reason: "all_others" });
    await h.pool.query("update tickets set status = 'done' where project_id = $1 and number in (3, 4)", [priv()]);
    expect((await queue(token)).json).toMatchObject({ total: 0, empty_reason: "none" });
  });

  it("não vaza ticket de outro projeto da organização, nem de outra organização", async () => {
    const { token } = await setup("contributor", "read");
    const other = (await h.rows("insert into projects (org_id, name, key, visibility) values ($1, 'Outro', 'OUT', 'organization') returning id", [ORG]))[0]?.id as string;
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1, $2, 1, 'Segredo do outro', $3)", [ORG, other, people().manager]);
    const res = await queue(token);
    expect(JSON.stringify(res.raw)).not.toContain("Segredo do outro");
    expect(keys(res)).toEqual(["PRIV-4", "PRIV-3"]);
    const foreign = await h.issueOther();
    const asForeign = await queue(foreign.token);
    // O token de B serve o projeto de B (que pode ter a mesma chave): nunca a fila daqui.
    expect(asForeign.json?.["tickets"] ?? []).toEqual([]);
    expect(JSON.stringify(asForeign.raw)).not.toMatch(/Filho B|Solto/);
  });

  it("a fila é a da dona do token: outra pessoa, mesma fila de ninguém e a própria", async () => {
    await setup("contributor", "read");
    const manager = await h.create("manager", priv(), { scope: "read" });
    expect(manager.status).toBe(201);
    // PRIV-4 é do contributor: para o gerente fica de fora.
    expect(keys(await queue(manager.body.token as string))).toEqual(["PRIV-3"]);
  });

  it("a descrição da ferramenta diz o que ela faz e o que não faz", async () => {
    const { token } = await setup("contributor", "read");
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; description: string }[];
    const description = tools.find((t) => t.name === "get_work_queue")?.description ?? "";
    expect(description).toMatch(/person who owns the token/i);
    expect(description).toMatch(/reads the whole project|do not call it in a loop/i);
    expect(description).toMatch(/next/i);
    expect(description).toMatch(/does not (change|start|mark)/i);
  });
});

describe("set_ticket_priority", () => {
  const set = (token: string, args: Record<string, unknown>) => h.tool(token, "PRIV", "set_ticket_priority", args);
  const priorityOf = async (number: number) => Number((await h.rows("select priority from tickets where project_id = $1 and number = $2", [priv(), number]))[0]?.priority);

  it("muda a prioridade, devolve o ticket como get_ticket e grava priority_changed com via mcp e o id do token", async () => {
    const { token, id } = await setup();
    const res = await set(token, { key: "PRIV-3", priority: 7 });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-3", priority: 7, effective_priority: 7 });
    expect(res.json).toEqual((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).json);
    expect(await priorityOf(3)).toBe(7);
    const events = await h.rows("select payload from activity_events where kind = 'ticket.updated' order by occurred_at desc limit 1");
    expect(events[0]?.payload).toMatchObject({ via: "mcp", tokenId: id, fields: ["priority"], priority: { from: 0, to: 7 } });
    const ticket = (await h.rows("select id from tickets where project_id = $1 and number = 3", [priv()]))[0]?.id;
    const history = await h.call("GET", `/api/tickets/${ticket}/activity`, as("contributor"));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect((history.body.items ?? history.body.entries ?? history.body) as any[]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "priority_changed", from: 0, to: 7, via: "mcp" })]));
  });

  it("aceita os extremos e o zero; recusa fora de -999..999, não inteiro, ausente e campo extra", async () => {
    const { token } = await setup();
    expect((await set(token, { key: "PRIV-3", priority: 999 })).isError).toBe(false);
    expect((await set(token, { key: "PRIV-3", priority: -999 })).isError).toBe(false);
    expect((await set(token, { key: "PRIV-3", priority: 0 })).isError).toBe(false);
    for (const bad of [{ priority: 1000 }, { priority: -1000 }, { priority: 1.5 }, { priority: "3" }, {}, { priority: 1, status: "done" }]) {
      expect((await set(token, { key: "PRIV-3", ...bad })).isError, JSON.stringify(bad)).toBe(true);
    }
    expect(await priorityOf(3)).toBe(0);
  });

  it("token de leitura e chave desligada recusam, sem gravar; a ferramenta nem aparece", async () => {
    const read = await setup("contributor", "read");
    expect(refused(await set(read.token, { key: "PRIV-3", priority: 4 }))).toBe(true);
    const write = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    await writeOn(false);
    expect(refused(await set(write, { key: "PRIV-3", priority: 4 }))).toBe(true);
    expect(await priorityOf(3)).toBe(0);
    const names = ((await h.rpc(write, "PRIV", "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("set_ticket_priority");
  });

  it("leitor, projeto arquivado, ticket de outro projeto e inexistente: recusa, nada gravado", async () => {
    const reader = await setup("reader");
    expect(refused(await set(reader.token, { key: "PRIV-3", priority: 4 }))).toBe(true);
    const { token } = { token: (await h.create("contributor", priv(), { scope: "write" })).body.token as string };
    expect(refused(await set(token, { key: "PRIV-99", priority: 4 }))).toBe(true);
    expect(refused(await set(token, { key: "OUT-1", priority: 4 }))).toBe(true);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const archived = await set(token, { key: "PRIV-3", priority: 4 });
    expect(refused(archived)).toBe(true);
    expect(archived.text).toMatch(/archived/i);
    expect(await priorityOf(3)).toBe(0);
    expect(await countRows("select count(*)::int n from activity_events where kind = 'ticket.updated'")).toBe(0);
  });

  it("repetir o mesmo valor não grava evento; a escrita conta no limite por minuto do token (teto pequeno de teste, 20)", async () => {
    useSmallLimits(h.app());
    const { token } = await setup();
    expect((await set(token, { key: "PRIV-3", priority: 0 })).isError).toBe(false);
    expect(await countRows("select count(*)::int n from activity_events where kind = 'ticket.updated'")).toBe(0);
    for (let i = 1; i < 20; i += 1) expect((await set(token, { key: "PRIV-3", priority: i })).status, `#${i}`).toBe(200);
    const over = await h.post(token, "PRIV", rpcBody("tools/call", { name: "set_ticket_priority", arguments: { key: "PRIV-3", priority: 50 } }), rpcHeaders("tools/call", { name: "set_ticket_priority" }));
    expect(over.status).toBe(429);
  });
});

describe("create_ticket", () => {
  const create = (token: string, args: Record<string, unknown>) => h.tool(token, "PRIV", "create_ticket", args);
  const byTitle = async (title: string) => (await h.rows("select * from tickets where project_id = $1 and title = $2", [priv(), title]));
  const tickets = () => countRows("select count(*)::int n from tickets where project_id = $1", [priv()]);

  it("cria o ticket e devolve a chave e o resumo; o evento tem via mcp e o id do token; a versão do projeto anda", async () => {
    const { token, id } = await setup();
    const before = Number((await h.rows("select tickets_version v from projects where id = $1", [priv()]))[0]?.v);
    const res = await create(token, { title: "Novo pelo agente", description: "Veja PRIV-4." });
    expect(res.isError, res.text).toBe(false);
    expect(res.json).toMatchObject({ key: "PRIV-5", ticket: { key: "PRIV-5", title: "Novo pelo agente", status: "todo", parent: null, idea: null, priority: 0, effective_priority: 0 } });
    const rows = await byTitle("Novo pelo agente");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 5, description: "Veja PRIV-4.", created_by_person_id: people().contributor });
    const event = (await h.rows("select payload, actor_person_id from activity_events where kind = 'ticket.created' order by occurred_at desc limit 1"))[0];
    expect(event?.payload).toMatchObject({ key: "PRIV-5", via: "mcp", tokenId: id });
    expect(event?.actor_person_id).toBe(people().contributor);
    expect(Number((await h.rows("select tickets_version v from projects where id = $1", [priv()]))[0]?.v)).toBeGreaterThan(before);
    // A menção da descrição vira ligação, como na tela.
    expect(await countRows("select count(*)::int n from ticket_relations where kind = 'mentions' and from_ticket_id = $1", [rows[0]?.id])).toBe(1);
  });

  it("com pai (inclusive dentro de pai concluído, que é reaberto como na tela) e com prioridade", async () => {
    const { token } = await setup();
    const res = await create(token, { title: "Filho novo", parent: "PRIV-1", priority: 4 });
    expect(res.isError, res.text).toBe(false);
    expect(res.json?.["ticket"]).toMatchObject({ parent: "PRIV-1", priority: 4, effective_priority: 4 });
    await h.pool.query("update tickets set status = 'done' where project_id = $1 and number = 4", [priv()]);
    const reopen = await create(token, { title: "Dentro do concluído", parent: "PRIV-4" });
    expect(reopen.isError, reopen.text).toBe(false);
    expect((await h.rows("select status from tickets where project_id = $1 and number = 4", [priv()]))[0]?.status).toBe("todo");
  });

  it("idea: true cria a ideia; ticket dentro de ideia fica em todo", async () => {
    const { token } = await setup("manager");
    const idea = await create(token, { title: "Uma ideia", idea: true });
    expect(idea.isError, idea.text).toBe(false);
    expect(idea.json?.["ticket"]).toMatchObject({ idea: { kind: "root", stage: "new" }, status: "todo" });
    const inside = await create(token, { title: "Dentro da ideia", parent: idea.json?.["key"] });
    expect(inside.isError, inside.text).toBe(false);
    expect(inside.json?.["ticket"]).toMatchObject({ status: "todo", idea: { kind: "inside", root: idea.json?.["key"] } });
  });

  it("recusa: entrada inválida (título vazio ou longo, campo extra, pai mal formado, prioridade fora), pai inexistente e de outro projeto; nada é criado", async () => {
    const { token } = await setup();
    const bad: Record<string, unknown>[] = [
      { title: "" },
      { title: "   " },
      { title: "x".repeat(501) },
      { title: "ok", status: "done" },
      { title: "ok", parent: "xx" },
      { title: "ok", parent: "PRIV-99" },
      { title: "ok", parent: "OUT-1" },
      { title: "ok", priority: 1000 },
      { title: "ok", idea: "sim" },
      { title: "ok", requestId: "curto" },
      {},
    ];
    for (const args of bad) expect((await create(token, args)).isError, JSON.stringify(args)).toBe(true);
    expect(await tickets()).toBe(4);
  });

  it("a mesma tabela de recusas da tela: leitor, projeto arquivado, token de leitura, chave desligada", async () => {
    const reader = await setup("reader");
    const viaMcp = await create(reader.token, { title: "Não deve existir" });
    const viaHttp = await h.call("POST", `/api/projects/${priv()}/tickets`, as("reader"), { title: "Não deve existir" });
    expect(refused(viaMcp)).toBe(true);
    expect(viaHttp.status).toBe(403);
    const token = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    const read = (await h.create("contributor", priv(), { scope: "read" })).body.token as string;
    expect(refused(await create(read, { title: "Não deve existir" }))).toBe(true);
    await writeOn(false);
    expect(refused(await create(token, { title: "Não deve existir" }))).toBe(true);
    await writeOn(true);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const archived = await create(token, { title: "Não deve existir" });
    expect(refused(archived)).toBe(true);
    expect(archived.text).toMatch(/archived/i);
    expect(await byTitle("Não deve existir")).toHaveLength(0);
    expect(await tickets()).toBe(4);
  });

  it("quem não pode registrar ideia pela tela também não registra pelo MCP", async () => {
    const { token } = await setup("contributor");
    const viaHttp = await h.call("POST", `/api/projects/${priv()}/tickets`, as("contributor"), { title: "Ideia da tela", idea: true });
    const viaMcp = await create(token, { title: "Ideia do mcp", idea: true });
    expect(refused(viaMcp)).toBe(viaHttp.status >= 400);
  });

  it("descrição passa pelas mesmas regras da tela (tamanho e caracteres)", async () => {
    const { token } = await setup();
    for (const description of ["x".repeat(100_001), "oi‮oculto"]) {
      const viaHttp = await h.call("POST", `/api/projects/${priv()}/tickets`, as("contributor"), { title: "Regra", description });
      const viaMcp = await create(token, { title: "Regra", description });
      expect(refused(viaMcp), description.slice(0, 5)).toBe(viaHttp.status >= 400);
    }
  });

  describe("requestId", () => {
    it("repetir com o mesmo requestId devolve o ticket já criado, sem outro ticket nem outro evento", async () => {
      const { token } = await setup();
      const first = await create(token, { title: "Idempotente", requestId: "pedido-0001" });
      const second = await create(token, { title: "Idempotente", requestId: "pedido-0001" });
      expect(first.isError, first.text).toBe(false);
      expect(second.json).toEqual(first.json);
      expect(await byTitle("Idempotente")).toHaveLength(1);
      expect(await countRows("select count(*)::int n from activity_events where kind = 'ticket.created'")).toBe(1);
    });

    it("o mesmo requestId com outro título é erro claro, sem criar nem devolver o antigo", async () => {
      const { token } = await setup();
      await create(token, { title: "Primeiro", requestId: "pedido-0002" });
      const other = await create(token, { title: "Segundo", requestId: "pedido-0002" });
      expect(other.isError).toBe(true);
      expect(other.text).toMatch(/requestId already used/);
      expect(await byTitle("Segundo")).toHaveLength(0);
    });

    it("mesmo requestId e título, mas outro pai, descrição, ideia ou prioridade: 409 sem criar nem devolver o antigo; tudo igual repete", async () => {
      const { token } = await setup("manager");
      const base = { title: "Mesmo título", description: "d", parent: "PRIV-1", priority: 3, requestId: "pedido-0010" };
      const first = await create(token, base);
      expect(first.isError, first.text).toBe(false);
      for (const change of [{ parent: "PRIV-4" }, { parent: undefined }, { description: "outra" }, { description: undefined }, { idea: true }, { priority: 4 }, { priority: undefined }]) {
        const res = await create(token, { ...base, ...change });
        expect(res.isError, JSON.stringify(change)).toBe(true);
        expect(res.text, JSON.stringify(change)).toMatch(/requestId already used with a different request/);
      }
      expect((await create(token, base)).json).toEqual(first.json);
      expect(await byTitle("Mesmo título")).toHaveLength(1);
    });

    it("o resumo dos argumentos, não os argumentos, fica no evento de criação", async () => {
      const { token } = await setup();
      await create(token, { title: "Com resumo", description: "texto-secreto-da-descricao", requestId: "pedido-0011" });
      const payload = (await h.rows("select payload from activity_events where kind = 'ticket.created' order by occurred_at desc limit 1"))[0]?.payload as Record<string, unknown>;
      expect(typeof payload["requestDigest"]).toBe("string");
      expect(JSON.stringify(payload)).not.toContain("texto-secreto-da-descricao");
    });

    it("um import grande logo depois (mais de 500 tickets da pessoa) não faz a repetição duplicar", async () => {
      const { token } = await setup();
      const first = await create(token, { title: "Original", requestId: "pedido-0012" });
      await h.pool.query(
        "insert into tickets (org_id, project_id, number, title, created_by_person_id) select $1, $2, n, 'Import ' || n, $3 from generate_series(100, 799) n",
        [ORG, priv(), people().contributor],
      );
      const again = await create(token, { title: "Original", requestId: "pedido-0012" });
      expect(again.json).toEqual(first.json);
      expect(await byTitle("Original")).toHaveLength(1);
    });

    it("duas chamadas simultâneas criam um ticket só", async () => {
      const { token } = await setup();
      const [a, b] = await Promise.all([create(token, { title: "Corrida", requestId: "pedido-0003" }), create(token, { title: "Corrida", requestId: "pedido-0003" })]);
      expect(a.isError && b.isError).toBe(false);
      expect(a.json?.["key"]).toBe(b.json?.["key"]);
      expect(await byTitle("Corrida")).toHaveLength(1);
    });

    it("depois de 10 minutos, outro token, outra pessoa ou sem requestId criam outro ticket; ticket apagado cria de novo", async () => {
      const { token } = await setup();
      const second = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
      await create(token, { title: "Repete", requestId: "pedido-0004" });
      expect((await create(second, { title: "Repete", requestId: "pedido-0004" })).json?.["key"]).toBe("PRIV-6");
      expect((await create(token, { title: "Repete" })).json?.["key"]).toBe("PRIV-7");
      expect((await create(token, { title: "Repete" })).json?.["key"]).toBe("PRIV-8");
      h.clock.advance(11 * 60_000);
      expect((await create(token, { title: "Repete", requestId: "pedido-0004" })).json?.["key"]).toBe("PRIV-9");
    });

    it("o requestId não vai ao log, à resposta nem a uma coluna além do evento de criação", async () => {
      const { token } = await setup();
      const res = await create(token, { title: "Sem eco", requestId: "segredo-do-pedido" });
      expect(res.text).not.toContain("segredo-do-pedido");
      expect(JSON.stringify(res.raw)).not.toContain("segredo-do-pedido");
    });

    it("a repetição não escapa às recusas: token revogado e projeto arquivado", async () => {
      const { token, id } = await setup();
      await create(token, { title: "Antes", requestId: "pedido-0005" });
      await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
      expect(refused(await create(token, { title: "Antes", requestId: "pedido-0005" }))).toBe(true);
      await h.pool.query("update projects set archived_at = null where id = $1", [priv()]);
      await h.call("DELETE", `/api/access-tokens/${id}`, as("contributor"));
      expect((await create(token, { title: "Antes", requestId: "pedido-0005" })).status).toBe(401);
    });
  });

  it("chamada de escrita com token de leitura ou com a chave desligada não gasta o limite de escrita da pessoa", async () => {
    useSmallLimits(h.app());
    const write = await setup();
    const read = (await h.create("contributor", priv(), { scope: "read" })).body.token as string;
    for (let i = 0; i < 45; i += 1) await create(read, { title: `Vazado ${i}` });
    await writeOn(false);
    for (let i = 0; i < 10; i += 1) await create(write.token, { title: `Desligada ${i}` });
    await writeOn(true);
    for (let i = 0; i < 20; i += 1) expect((await create(write.token, { title: `Meu ${i}` })).status, `#${i}`).toBe(200);
    const other = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    for (let i = 0; i < 20; i += 1) expect((await create(other, { title: `Outro ${i}` })).status, `o#${i}`).toBe(200);
  });

  it("o que o limite do token já recusou não conta no limite da pessoa", async () => {
    useSmallLimits(h.app());
    const a = await setup();
    const b = (await h.create("contributor", priv(), { scope: "write" })).body.token as string;
    for (let i = 0; i < 30; i += 1) await create(a.token, { title: `A ${i}` }); // 20 passam, 10 são recusadas pelo token
    for (let i = 0; i < 20; i += 1) expect((await create(b, { title: `B ${i}` })).status, `b#${i}`).toBe(200);
  });

  it("conta no limite de escritas por minuto do token (teto pequeno de teste, 20)", async () => {
    useSmallLimits(h.app());
    const { token } = await setup();
    for (let i = 0; i < 20; i += 1) expect((await create(token, { title: `Em lote ${i}` })).status, `#${i}`).toBe(200);
    const over = await h.post(token, "PRIV", rpcBody("tools/call", { name: "create_ticket", arguments: { title: "Passou" } }), rpcHeaders("tools/call", { name: "create_ticket" }));
    expect(over.status).toBe(429);
    expect(await byTitle("Passou")).toHaveLength(0);
  });

  it("não aciona o assistente nem registra conversa ou consumo de IA", async () => {
    const { token } = await setup();
    await create(token, { title: "Sem IA" });
    expect(await countRows("select count(*)::int n from ticket_conversations")).toBe(0);
  });
});

describe("tools/list com as cinco ferramentas de escrita", () => {
  it("token de escrita vê as duas novas marcadas como de escrita e a de leitura como de leitura; token de leitura vê só a de leitura", async () => {
    const { token } = await setup();
    const tools = (await h.rpc(token, "PRIV", "tools/list")).body.result.tools as { name: string; annotations: any; description: string }[];
    const by = (name: string) => tools.find((t) => t.name === name);
    expect(by("get_work_queue")?.annotations.readOnlyHint).toBe(true);
    for (const name of ["set_ticket_priority", "create_ticket"]) {
      expect(by(name)?.annotations.readOnlyHint, name).toBe(false);
      expect(by(name)?.annotations.destructiveHint, name).toBe(false);
    }
    expect(by("create_ticket")?.description).toMatch(/does not/i);
    expect(by("create_ticket")?.description).toMatch(/requestId/);
    expect(by("create_ticket")?.description).toContain(`limit of ${WRITE_LIMIT_PER_PERSON_PER_MINUTE} changes per minute`);
    const read = (await h.create("contributor", priv(), { scope: "read" })).body.token as string;
    const names = ((await h.rpc(read, "PRIV", "tools/list")).body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("get_work_queue");
    expect(names).not.toContain("create_ticket");
    expect(names).not.toContain("set_ticket_priority");
  });
});

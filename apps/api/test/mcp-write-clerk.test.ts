import { describe, expect, it } from "vitest";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import { MINUTE } from "./access-token-support.js";
import { seedProject, useMcpHarness, useSmallLimits } from "./mcp-support.js";
import { ORG } from "./world.js";
import type { Who } from "./world.js";

// ADR 0043, revisão 2, item 1: o nome da ferramenta sozinho não pode forçar idas ao Clerk.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const visits = () => h.directory().calls.memberships.length;

async function setup(scope: "read" | "write", writeEnabled = true, who: Who = "contributor"): Promise<string> {
  await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
  await h.enableMcp();
  await h.pool.query("update organizations set mcp_write_enabled = $2 where org_id = $1", [ORG, writeEnabled]);
  const res = await h.create(who, priv(), { scope });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}
const write = (token: string, name = "add_comment") =>
  h.tool(token, "PRIV", name, name === "set_agent_work" ? { key: "PRIV-3", working: true } : name === "update_ticket_status" ? { key: "PRIV-3", status: "in_progress" } : { key: "PRIV-3", body: "oi" });

describe("a ferramenta de escrita pelo nome só vai ao Clerk quando o token pode escrever", () => {
  it("token de leitura chamando ferramenta de escrita N vezes: zero idas frescas e a memória da leitura continua", async () => {
    const token = await setup("read");
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    const warm = visits();
    expect(warm).toBe(1);
    for (const name of ["add_comment", "update_ticket_status", "set_agent_work", "add_comment", "add_comment"]) await write(token, name);
    expect(visits()).toBe(warm);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    expect(visits()).toBe(warm);
  });

  it("token de escrita com a chave da organização desligada: zero idas frescas", async () => {
    const token = await setup("write", false);
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    const warm = visits();
    for (let i = 0; i < 4; i += 1) await write(token);
    expect(visits()).toBe(warm);
  });

  it("token de escrita com a chave ligada continua indo ao Clerk a cada escrita (controle)", async () => {
    const token = await setup("write");
    for (let i = 0; i < 3; i += 1) expect((await write(token)).isError).toBe(false);
    expect(visits()).toBe(3);
  });

  it("acima do limite de escritas por minuto (teto pequeno de teste, 20): nenhuma ida ao Clerk além do limite", async () => {
    useSmallLimits(h.app());
    const token = await setup("write");
    for (let i = 0; i < 20; i += 1) expect((await write(token, "set_agent_work")).status, `#${i}`).toBe(200);
    expect(visits()).toBe(20);
    for (let i = 0; i < 5; i += 1) expect((await write(token)).status).toBe(429);
    expect(visits()).toBe(20);
    h.clock.advance(MINUTE + 1000);
    expect((await write(token)).status).toBe(200);
    expect(visits()).toBe(21);
  });
});

describe("falha ou demora do Clerk numa escrita", () => {
  it("falha do Clerk numa escrita responde 503 e não apaga a memória boa: as leituras da pessoa continuam sem nova ida", async () => {
    const token = await setup("write");
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    const warm = visits();
    h.directory().onCall = () => Promise.reject(new Error("Clerk fora do ar"));
    expect((await write(token)).status).toBe(503);
    h.directory().onCall = null;
    const before = visits();
    expect((await h.tool(token, "PRIV", "get_ticket", { key: "PRIV-3" })).status).toBe(200);
    expect(visits()).toBe(before);
    expect(before).toBe(warm + 1);
  });

  it("a consulta de participação tem prazo: o Clerk que não responde vira 503, não uma vaga presa", async () => {
    const token = await setup("write");
    h.app().get(AccessTokenService).membershipTimeoutMs = 80;
    h.directory().onCall = () => new Promise<void>(() => undefined);
    const started = Date.now();
    expect((await write(token)).status).toBe(503);
    expect(Date.now() - started).toBeLessThan(3000);
    // a vaga voltou: com o Clerk de volta, a próxima chamada passa
    h.directory().onCall = null;
    expect((await write(token)).status).toBe(200);
  });
});

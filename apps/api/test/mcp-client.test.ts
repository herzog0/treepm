/* eslint-disable @typescript-eslint/no-explicit-any -- resultados do cliente do SDK */
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";

const h = useMcpHarness();
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

async function connect(token: string, key: string, mode: "legacy" | "auto"): Promise<Client> {
  const app = h.app();
  const server = app.getHttpServer();
  if (!server.listening) await app.listen(0, "127.0.0.1");
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: "teste-treepm", version: "1.0.0" }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp/${key}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

async function setup(): Promise<string> {
  await seedProject(h.pool, h.world().projects.priv, h.world().people.manager, h.world().people.contributor);
  return (await h.issue("contributor")).token;
}

describe("cliente oficial do SDK contra a aplicação de teste", () => {
  it("cliente da revisão atual (discover, tools/list, tools/call)", async () => {
    const token = await setup();
    const client = await connect(token, "PRIV", "auto");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["get_project_overview", "get_ticket", "get_work_queue", "list_labels", "list_tickets", "search_tickets"]);
    const result: any = await client.callTool({ name: "get_ticket", arguments: { key: "PRIV-2" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.key).toBe("PRIV-2");
    expect(result.structuredContent.parent).toBe("PRIV-1");
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    const bad: any = await client.callTool({ name: "get_ticket", arguments: { key: "PRIV-404" } });
    expect(bad.isError).toBe(true);
  });

  it("cliente da geração anterior (initialize e depois tools/list e tools/call)", async () => {
    const token = await setup();
    const client = await connect(token, "PRIV", "legacy");
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    const result: any = await client.callTool({ name: "get_project_overview", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.total).toBe(4);
    const list: any = await client.callTool({ name: "list_tickets", arguments: { status: ["done"] } });
    expect(list.structuredContent.tickets.map((t: any) => t.key)).toEqual(["PRIV-2"]);
  });

  it("token errado: o cliente não conecta", async () => {
    await setup();
    await expect(connect("tpm_invalido", "PRIV", "auto")).rejects.toThrow();
  });
});

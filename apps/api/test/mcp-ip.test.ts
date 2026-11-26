import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { McpGateway } from "../src/mcp/mcp-gateway.js";
import { FakeClock } from "./access-token-support.js";
import { TEST_CONFIG, createTestApp } from "./helpers.js";
import { rpcBody, rpcHeaders } from "./mcp-support.js";

const apps: INestApplication[] = [];
async function build(header?: string): Promise<INestApplication> {
  const { app } = await createTestApp([], header ? { ...TEST_CONFIG, CLIENT_IP_HEADER: header } : TEST_CONFIG, { clock: new FakeClock() });
  apps.push(app);
  return app;
}
afterAll(async () => {
  for (const app of apps) await app.close();
});

const hit = (app: INestApplication, headers: Record<string, string> = {}) => {
  let req = request(app.getHttpServer()).post("/api/mcp/PRIV");
  for (const [name, value] of Object.entries({ ...rpcHeaders("tools/list"), ...headers })) req = req.set(name, value);
  return req.send(rpcBody("tools/list"));
};
async function fill(app: INestApplication, headers: Record<string, string>, n = 120): Promise<void> {
  for (let i = 0; i < n; i++) expect((await hit(app, headers)).status).toBe(401);
}

describe("com CLIENT_IP_HEADER", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await build("Fly-Client-IP");
  });
  beforeEach(() => app.get(McpGateway).resetMemory());

  it("mesmo IP de conexão, cabeçalhos diferentes: baldes separados", async () => {
    await fill(app, { "fly-client-ip": "203.0.113.1" });
    expect((await hit(app, { "fly-client-ip": "203.0.113.1" })).status).toBe(429);
    expect((await hit(app, { "fly-client-ip": "203.0.113.2" })).status).toBe(401);
  });

  it("sem o cabeçalho na requisição: cai no IP da conexão (e esse balde é compartilhado entre quem não manda)", async () => {
    await fill(app, {});
    expect((await hit(app, {})).status).toBe(429);
    expect((await hit(app, { "fly-client-ip": "203.0.113.9" })).status).toBe(401);
  });

  it("valor que não é endereço IP é tratado como ausente (não escapa do balde da conexão)", async () => {
    await fill(app, {});
    expect((await hit(app, { "fly-client-ip": "não-é-ip" })).status).toBe(429);
    expect((await hit(app, { "fly-client-ip": "" })).status).toBe(429);
  });

  it("IPv6 é agrupado por /64; IPv4 inteiro", async () => {
    await fill(app, { "fly-client-ip": "2001:db8:0:1::1" });
    expect((await hit(app, { "fly-client-ip": "2001:db8:0:1:ffff::2" })).status).toBe(429);
    expect((await hit(app, { "fly-client-ip": "2001:db8:0:2::1" })).status).toBe(401);
    expect((await hit(app, { "fly-client-ip": "::ffff:203.0.113.5" })).status).toBe(401);
  });
});

describe("sem CLIENT_IP_HEADER", () => {
  it("o cabeçalho é ignorado: mandar IPs diferentes não escapa do limite", async () => {
    const app = await build();
    for (let i = 0; i < 120; i++) expect((await hit(app, { "fly-client-ip": `203.0.113.${i % 250}` })).status).toBe(401);
    expect((await hit(app, { "fly-client-ip": "198.51.100.1" })).status).toBe(429);
  });
});

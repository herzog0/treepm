import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Controller, Get, Head, Res } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { Response } from "express";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Public } from "../src/auth/public.decorator.js";
import { shouldCompress } from "../src/compression.js";
import { AI_CONFIG, createTestApp } from "./helpers.js";
import { useMcpHarness } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// ADR 0046 / TREEPM-255: o servidor comprime as respostas grandes (brotli ou gzip pelo Accept-Encoding), menos fluxo,
// MCP, `no-transform` e as respostas que carregam segredo (BREACH).
const BIG = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i, text: "texto repetido ".repeat(4) })) });
const SMALL = JSON.stringify({ ok: true });

@Public()
@Controller("probe")
class ProbeController {
  @Get("big") big(@Res() res: Response): void { res.type("application/json").send(BIG); }
  @Head("big-head") bigHead(@Res() res: Response): void { res.type("application/json").send(BIG); }
  @Get("small") small(@Res() res: Response): void { res.type("application/json").send(SMALL); }
  @Get("no-transform") noTransform(@Res() res: Response): void { res.set("Cache-Control", "no-transform").type("application/json").send(BIG); }
  @Get("stream") stream(@Res() res: Response): void {
    res.status(200).type("text/event-stream");
    res.write(`data: ${"x".repeat(3000)}\n\n`);
    res.end();
  }
  @Get("png") png(@Res() res: Response): void { res.type("image/png").send(Buffer.alloc(5000, 1)); }
}

type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** Pede com o `Accept-Encoding` dado e devolve os bytes como chegaram, sem o cliente descomprimir (o supertest descomprime). */
async function raw(app: INestApplication, path: string, encoding = "identity", headers: Record<string, string> = {}, method = "GET", payload?: unknown): Promise<Raw> {
  const server = app.getHttpServer() as Server;
  if (!server.listening) await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const data = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise<Raw>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { "accept-encoding": encoding, ...(data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) }), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
const inflate = (res: Raw): string => {
  const body = res.body;
  const encoding = res.headers["content-encoding"];
  if (encoding === "br") return brotliDecompressSync(body).toString("utf8");
  if (encoding === "gzip") return gunzipSync(body).toString("utf8");
  return body.toString("utf8");
};

describe("compressão: regras gerais", () => {
  let app: INestApplication;
  beforeAll(async () => {
    ({ app } = await createTestApp([ProbeController]));
  });
  afterAll(async () => {
    await app.close();
  });

  it("brotli e gzip pelo Accept-Encoding, e descomprimem no mesmo corpo", async () => {
    const br = await raw(app, "/api/probe/big", "br, gzip");
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["vary"]).toMatch(/Accept-Encoding/i);
    expect((br.body as Buffer).length).toBeLessThan(BIG.length / 4);
    expect(inflate(br)).toBe(BIG);
    const gz = await raw(app, "/api/probe/big", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(inflate(gz)).toBe(BIG);
  });

  it("sem Accept-Encoding comprimível vem igual a hoje, mas com Vary", async () => {
    const res = await raw(app, "/api/probe/big", "identity");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["vary"]).toMatch(/Accept-Encoding/i);
    expect(inflate(res)).toBe(BIG);
  });

  it("resposta pequena, imagem, no-transform e fluxo não são comprimidos", async () => {
    for (const path of ["/api/probe/small", "/api/probe/png", "/api/probe/no-transform", "/api/probe/stream"]) {
      const res = await raw(app, path, "br, gzip");
      expect(res.status, path).toBe(200);
      expect(res.headers["content-encoding"], path).toBeUndefined();
    }
  });

  it("HEAD de rota grande não traz corpo nem Content-Encoding quebrado", async () => {
    const res = await raw(app, "/api/probe/big-head", "br", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });
});

describe("compressão: rotas reais", () => {
  const h = useMcpHarness(AI_CONFIG);
  const P = () => h.world().projects.priv;
  const items = Array.from({ length: 300 }, (_, i) => ({ title: `Ticket ${i} com um título razoável`, description: "descrição repetida ".repeat(10) }));
  const bulk = async (): Promise<void> => {
    const res = await request(h.app().getHttpServer()).post(`/api/projects/${P()}/tickets/import`).set("x-test-session", as("admin", ORG)).send({ items });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  };
  const list = (encoding: string | undefined, headers: Record<string, string> = {}) =>
    raw(h.app(), `/api/projects/${P()}/tickets`, encoding, { "x-test-session": as("admin", ORG), ...headers });

  it("a lista grande vem comprimida e descomprime no mesmo JSON que a sem compressão", async () => {
    await bulk();
    const plain = await list("identity");
    expect(plain.status).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    for (const encoding of ["br", "gzip"]) {
      const res = await list(encoding);
      expect(res.headers["content-encoding"]).toBe(encoding);
      expect(JSON.parse(inflate(res))).toEqual(JSON.parse(inflate(plain)));
      expect(res.body.length).toBeLessThan(plain.body.length / 3);
      expect(res.headers["etag"]).toBe(plain.headers["etag"]);
      expect(res.headers["cache-control"]).toBe("private, no-cache");
    }
  });

  it("If-None-Match com compressão: 304 sem corpo, ETag fraco igual", async () => {
    await bulk();
    const first = await list("br");
    const tag = first.headers["etag"] as string;
    expect(tag).toMatch(/^W\/"/);
    const res = await list("br", { "If-None-Match": tag });
    expect(res.status).toBe(304);
    expect(res.body.length).toBe(0);
    expect(res.headers["etag"]).toBe(tag);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("o token recém-criado (segredo mostrado uma vez) nunca é comprimido", async () => {
    await h.enableMcp();
    const res = await raw(h.app(), "/api/access-tokens", "br, gzip", { "x-test-session": as("contributor", ORG) }, "POST", { projectId: P(), name: "N".repeat(80), expiresInDays: 90 });
    expect(res.status, inflate(res)).toBe(201);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(inflate(res)).token).toMatch(/\S+/);
  });

  it("o MCP não é comprimido, mesmo com resposta grande", async () => {
    await bulk();
    const { token } = await h.issue("admin");
    const res = await raw(h.app(), `/api/mcp/${(await h.rows("select key from projects where id = $1", [P()]))[0]?.["key"] as string}`, "br, gzip", {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
    }, "POST", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.headers["content-encoding"]).toBeUndefined();
  });
});

describe("compressão: filtro", () => {
  const req = (method: string, path: string) => ({ method, path, headers: {} }) as never;
  const res = (type: string, status = 200) => ({ statusCode: status, getHeader: (n: string) => (n.toLowerCase() === "content-type" ? type : undefined) }) as never;

  it("recusa as respostas que carregam segredo, o fluxo e o MCP", () => {
    expect(shouldCompress(req("POST", "/api/access-tokens"), res("application/json"))).toBe(false);
    expect(shouldCompress(req("POST", "/api/github/connect"), res("application/json"))).toBe(false);
    expect(shouldCompress(req("POST", "/api/mcp/KEY"), res("application/json"))).toBe(false);
    expect(shouldCompress(req("GET", "/api/anything"), res("text/event-stream"))).toBe(false);
    expect(shouldCompress(req("GET", "/api/anything"), res("application/json", 206))).toBe(false);
  });
  it("aceita o resto do JSON e do texto", () => {
    expect(shouldCompress(req("GET", "/api/projects/x/tickets"), res("application/json; charset=utf-8"))).toBe(true);
    expect(shouldCompress(req("GET", "/assets/a.js"), res("text/javascript; charset=utf-8"))).toBe(true);
    expect(shouldCompress(req("GET", "/api/access-tokens"), res("application/json"))).toBe(true);
    expect(shouldCompress(req("GET", "/x.png"), res("image/png"))).toBe(false);
  });
});

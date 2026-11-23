import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TEST_CONFIG, createTestApp } from "./helpers.js";

const INDEX = "<!doctype html><html><body>treepm-spa</body></html>";
const webDir = mkdtempSync(join(tmpdir(), "treepm-web-"));
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "index.html"), INDEX);
writeFileSync(join(webDir, "assets", "x.js"), "console.log('x');");
const BIG_JS = "console.log('grande');\n".repeat(400);
writeFileSync(join(webDir, "assets", "big.js"), BIG_JS);
writeFileSync(join(webDir, "assets", "p.png"), Buffer.alloc(5000, 7));

let withWeb: INestApplication;
let withoutWeb: INestApplication;

beforeAll(async () => {
  ({ app: withWeb } = await createTestApp([], { ...TEST_CONFIG, WEB_DIST_DIR: webDir }));
  ({ app: withoutWeb } = await createTestApp());
});
afterAll(async () => {
  await withWeb.close();
  await withoutWeb.close();
  rmSync(webDir, { recursive: true, force: true });
});

describe("WEB_DIST_DIR na configuração", () => {
  it("é opcional", () => {
    const base = {
      DATABASE_URL: "postgresql://x:y@localhost:5432/db",
      CLERK_SECRET_KEY: "sk",
      CLERK_PUBLISHABLE_KEY: "pk",
      APP_ORIGIN: "https://treepm.ai",
    };
    expect(loadConfig(base).WEB_DIST_DIR).toBeUndefined();
    expect(loadConfig({ ...base, WEB_DIST_DIR: "/srv/web" }).WEB_DIST_DIR).toBe("/srv/web");
  });
});

describe("com WEB_DIST_DIR: compressão negociada (TREEPM-255)", () => {
  it("arquivo grande do web vem comprimido, com Vary, o mesmo cache e o mesmo conteúdo", async () => {
    const res = await request(withWeb.getHttpServer()).get("/assets/big.js").set("Accept-Encoding", "gzip");
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["vary"]).toMatch(/Accept-Encoding/i);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.text).toBe(BIG_JS);
    const plain = await request(withWeb.getHttpServer()).get("/assets/big.js").set("Accept-Encoding", "identity");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers["content-length"]).toBe(String(BIG_JS.length));
  });

  it("o index.html continua sem cache e a imagem não é comprimida", async () => {
    const res = await request(withWeb.getHttpServer()).get("/qualquer").set("Accept-Encoding", "gzip, br");
    expect(res.headers["cache-control"]).toBe("no-cache");
    const png = await request(withWeb.getHttpServer()).get("/assets/p.png").set("Accept-Encoding", "gzip, br");
    expect(png.status).toBe(200);
    expect(png.headers["content-encoding"]).toBeUndefined();
  });

  it("If-None-Match no arquivo comprimido continua dando 304 sem corpo", async () => {
    const first = await request(withWeb.getHttpServer()).get("/assets/big.js").set("Accept-Encoding", "gzip");
    const tag = first.headers["etag"] as string;
    expect(tag).toBeTruthy();
    const res = await request(withWeb.getHttpServer()).get("/assets/big.js").set("Accept-Encoding", "gzip").set("If-None-Match", tag);
    expect(res.status).toBe(304);
    expect(res.text).toBe("");
  });
});

describe("com WEB_DIST_DIR (uma origem)", () => {
  it("/ devolve o index.html sem cache", async () => {
    const res = await request(withWeb.getHttpServer()).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toBe(INDEX);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("rota qualquer do SPA cai no index.html, preservando a query string", async () => {
    for (const path of ["/qualquer/rota", "/?demo", "/?auth=abc", "/projeto/1?x=2", "/github/callback", "/github/callback?code=c&state=s.t&installation_id=101&setup_action=install"]) {
      const res = await request(withWeb.getHttpServer()).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toBe(INDEX);
      expect(res.headers["cache-control"], path).toBe("no-cache");
    }
  });

  it("/assets/x.js devolve o arquivo com cache longo e imutável", async () => {
    const res = await request(withWeb.getHttpServer()).get("/assets/x.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("/assets/ inexistente responde 404 em vez do index.html", async () => {
    const res = await request(withWeb.getHttpServer()).get("/assets/nao-existe.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("treepm-spa");
  });

  it("/api/health continua respondendo 200", async () => {
    const res = await request(withWeb.getHttpServer()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("/api/* desconhecida responde 404 JSON no formato de erro, nunca o index.html", async () => {
    for (const path of ["/api/nao-existe", "/api", "/api/"]) {
      const res = await request(withWeb.getHttpServer()).get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers["content-type"], path).toMatch(/application\/json/);
      expect(res.body, path).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    }
  });

  it("/api/me sem sessão mantém o guard global (401)", async () => {
    const res = await request(withWeb.getHttpServer()).get("/api/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("métodos que não são GET/HEAD fora de /api não viram index.html", async () => {
    const res = await request(withWeb.getHttpServer()).post("/qualquer");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("sem WEB_DIST_DIR (desenvolvimento)", () => {
  it("a raiz responde 404 JSON", async () => {
    const res = await request(withoutWeb.getHttpServer()).get("/");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("/assets/x.js também responde 404 JSON", async () => {
    const res = await request(withoutWeb.getHttpServer()).get("/assets/x.js");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

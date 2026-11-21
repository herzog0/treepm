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

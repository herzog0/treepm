import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { CONFIG } from "../src/config.js";
import { SESSION_VERIFIER } from "../src/auth/session-verifier.js";
import { ClerkSessionVerifier } from "../src/auth/clerk-session-verifier.js";
import { TEST_CONFIG } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inicialização", () => {
  it("falha de forma explícita quando falta variável obrigatória", async () => {
    for (const name of ["DATABASE_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "APP_ORIGIN"]) {
      vi.stubEnv(name, "");
    }
    await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(/DATABASE_URL/);
  });

  it("com a configuração completa usa a implementação real do Clerk", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG)
      .useValue(TEST_CONFIG)
      .compile();
    expect(moduleRef.get(SESSION_VERIFIER)).toBeInstanceOf(ClerkSessionVerifier);
    await moduleRef.close();
  });

  it("DATABASE_MIGRATION_URL no ambiente não afeta a configuração carregada", async () => {
    vi.stubEnv("DATABASE_URL", TEST_CONFIG.DATABASE_URL);
    vi.stubEnv("CLERK_SECRET_KEY", "sk");
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "pk");
    vi.stubEnv("APP_ORIGIN", TEST_CONFIG.APP_ORIGIN);
    vi.stubEnv("DATABASE_MIGRATION_URL", "postgresql://owner:segredo@127.0.0.1:1/x");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const config = moduleRef.get(CONFIG) as Record<string, unknown>;
    expect(JSON.stringify(config)).not.toContain("segredo");
    expect(config["DATABASE_URL"]).toBe(TEST_CONFIG.DATABASE_URL);
    await moduleRef.close();
  });
});

describe("o PrismaClient cru é inalcançável fora do módulo de banco", () => {
  it("só src/db referencia PRISMA, createPrismaClient ou withTenant", () => {
    const root = new URL("../src", import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !relative(root, path).startsWith("db/")) {
          const text = readFileSync(path, "utf8");
          if (/\b(PRISMA|createPrismaClient|withTenant|PrismaClient)\b/.test(text)) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

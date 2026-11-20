import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, assistantEnabled, loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgresql://treepm_app:x@localhost:5432/db",
  CLERK_SECRET_KEY: "sk_test_x",
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  APP_ORIGIN: "https://treepm.ai",
};

describe("loadConfig", () => {
  it("aceita o mínimo, com PORT padrão 4310", () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(4310);
    expect(config.APP_ORIGIN).toBe("https://treepm.ai");
    expect(config.CLERK_JWT_KEY).toBeUndefined();
  });

  it("lê PORT e CLERK_JWT_KEY opcionais", () => {
    const config = loadConfig({ ...valid, PORT: "8080", CLERK_JWT_KEY: "chave" });
    expect(config.PORT).toBe(8080);
    expect(config.CLERK_JWT_KEY).toBe("chave");
  });

  it.each(["DATABASE_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "APP_ORIGIN"])(
    "falha de forma explícita sem %s",
    (name) => {
      const env: Record<string, string | undefined> = { ...valid };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(name);
    },
  );

  it("não vaza valores de segredo na mensagem de erro", () => {
    expect(() => loadConfig({ ...valid, CLERK_SECRET_KEY: "", APP_ORIGIN: "não é url" })).toThrow(/CLERK_SECRET_KEY/);
    try {
      loadConfig({ ...valid, CLERK_SECRET_KEY: "", DATABASE_URL: "segredo-invalido" });
    } catch (error) {
      expect(String(error)).not.toContain("segredo-invalido");
    }
  });

  it("normaliza APP_ORIGIN para a origem", () => {
    expect(loadConfig({ ...valid, APP_ORIGIN: "https://treepm.ai/" }).APP_ORIGIN).toBe("https://treepm.ai");
  });

  it("as chaves da IA são opcionais: a API sobe sem elas e a IA fica desligada", () => {
    const config = loadConfig(valid);
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
    expect(config.TYPESAFE_API_KEY).toBeUndefined();
    expect(assistantEnabled(config)).toBe(false);
  });

  it("a IA só liga com as duas chaves", () => {
    const only = (name: string) => loadConfig({ ...valid, [name]: "chave" });
    expect(assistantEnabled(only("ANTHROPIC_API_KEY"))).toBe(false);
    expect(assistantEnabled(only("TYPESAFE_API_KEY"))).toBe(false);
    expect(assistantEnabled(loadConfig({ ...valid, ANTHROPIC_API_KEY: "a", TYPESAFE_API_KEY: "t" }))).toBe(true);
  });

  it("chave vazia vale como ausente", () => {
    const config = loadConfig({ ...valid, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "" });
    expect(assistantEnabled(config)).toBe(false);
  });

  it("ignora DATABASE_MIGRATION_URL do ambiente", () => {
    const config = loadConfig({ ...valid, DATABASE_MIGRATION_URL: "postgresql://owner:x@host/db" });
    expect(Object.keys(config)).not.toContain("DATABASE_MIGRATION_URL");
    expect(JSON.stringify(config)).not.toContain("owner:x");
  });

  it("nenhum arquivo de src/ referencia DATABASE_MIGRATION_URL", () => {
    const root = new URL("../src", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toContain("DATABASE_MIGRATION_URL");
    }
  });
});

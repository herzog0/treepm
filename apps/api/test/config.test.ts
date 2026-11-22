import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, allowedOrigins, assistantEnabled, githubEnabled, loadConfig } from "../src/config.js";

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

describe("loadConfig — GitHub (ADR 0032)", () => {
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY-----\n";
  const github = {
    GITHUB_APP_ID: "5858226",
    GITHUB_APP_SLUG: "treepm-dev",
    GITHUB_APP_CLIENT_ID: "Iv1.cliente",
    GITHUB_APP_CLIENT_SECRET: "segredo-do-cliente",
    GITHUB_APP_PRIVATE_KEY: PEM,
  };
  const NAMES = Object.keys(github);

  it("sem nenhuma das cinco, a API sobe e a ligação fica desligada", () => {
    const config = loadConfig(valid);
    expect(typeof githubEnabled).toBe("function");
    expect(githubEnabled(config)).toBe(false);
    for (const name of NAMES) expect(config).not.toHaveProperty(name, expect.any(String));
  });

  it("com as cinco, lê os valores e liga", () => {
    const config = loadConfig({ ...valid, ...github });
    expect(config.GITHUB_APP_ID).toBe("5858226");
    expect(config.GITHUB_APP_SLUG).toBe("treepm-dev");
    expect(config.GITHUB_APP_CLIENT_ID).toBe("Iv1.cliente");
    expect(config.GITHUB_APP_CLIENT_SECRET).toBe("segredo-do-cliente");
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
    expect(githubEnabled(config)).toBe(true);
  });

  it.each([1, 2, 3, 4])("com %i das cinco, a API não sobe e diz quais faltam", (count) => {
    const present = NAMES.slice(0, count);
    const missing = NAMES.slice(count);
    const env: Record<string, string> = { ...valid };
    for (const name of present) env[name] = github[name as keyof typeof github];
    expect(() => loadConfig(env)).toThrow(ConfigError);
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = String((error as Error).message);
    }
    for (const name of missing) expect(message).toContain(name);
    for (const name of present) expect(message).not.toContain(name);
    for (const value of Object.values(github)) expect(message).not.toContain(value.slice(0, 12));
  });

  it("valor vazio vale como ausente: as cinco vazias desligam; uma vazia entre as presentes é falta", () => {
    const empty = Object.fromEntries(NAMES.map((name) => [name, ""]));
    expect(githubEnabled(loadConfig({ ...valid, ...empty }))).toBe(false);
    expect(() => loadConfig({ ...valid, ...github, GITHUB_APP_SLUG: "" })).toThrow(/faltam: GITHUB_APP_SLUG/);
  });

  it("a chave privada com \\n literais (variável de uma linha só) volta a ter quebras de linha", () => {
    const config = loadConfig({ ...valid, ...github, GITHUB_APP_PRIVATE_KEY: PEM.replaceAll("\n", "\\n") });
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
  });

  it("a chave privada com CRLF e espaços nas pontas é normalizada, não recusada", () => {
    const config = loadConfig({ ...valid, ...github, GITHUB_APP_PRIVATE_KEY: `  ${PEM.replaceAll("\n", "\r\n")}  \r\n` });
    expect(config.GITHUB_APP_PRIVATE_KEY).toBe(PEM);
  });

  it("a chave privada tem que ser um PEM", () => {
    expect(() => loadConfig({ ...valid, ...github, GITHUB_APP_PRIVATE_KEY: "não é pem" })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    try {
      loadConfig({ ...valid, ...github, GITHUB_APP_PRIVATE_KEY: "não é pem" });
    } catch (error) {
      expect(String(error)).not.toContain("não é pem");
    }
  });

  it("o identificador do app é numérico", () => {
    expect(() => loadConfig({ ...valid, ...github, GITHUB_APP_ID: "abc" })).toThrow(/GITHUB_APP_ID/);
  });

  it(".env.example lista as cinco variáveis sem valor", () => {
    const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    for (const name of NAMES) expect(text).toMatch(new RegExp(`^${name}=$`, "m"));
  });
});

describe("APP_EXTRA_ORIGINS", () => {
  it("sem a variável, vale só APP_ORIGIN (como antes)", () => {
    const config = loadConfig(valid);
    expect(config.APP_EXTRA_ORIGINS).toBeUndefined();
    expect(allowedOrigins(config)).toEqual(["https://treepm.ai"]);
    expect(allowedOrigins(loadConfig({ ...valid, APP_EXTRA_ORIGINS: "" }))).toEqual(["https://treepm.ai"]);
  });

  it("aceita extras separados por vírgula, na ordem, depois da principal", () => {
    const config = loadConfig({ ...valid, APP_EXTRA_ORIGINS: "http://localhost:5173, https://dev.tailnet.ts.net:8443 ,http://127.0.0.1:4310" });
    expect(config.APP_ORIGIN).toBe("https://treepm.ai");
    expect(allowedOrigins(config)).toEqual(["https://treepm.ai", "http://localhost:5173", "https://dev.tailnet.ts.net:8443", "http://127.0.0.1:4310"]);
  });

  it("normaliza a barra final e ignora repetidos e a própria APP_ORIGIN, sem erro", () => {
    const config = loadConfig({ ...valid, APP_EXTRA_ORIGINS: "https://a.example/,https://a.example,https://treepm.ai,https://treepm.ai/,,https://b.example" });
    expect(config.APP_EXTRA_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
  });

  it.each([
    ["http fora de localhost", "http://dev.example", /APP_EXTRA_ORIGINS.*item 1.*https/],
    ["http em 192.168.0.5", "http://192.168.0.5:3000", /APP_EXTRA_ORIGINS.*item 1.*https/],
    ["com caminho", "https://a.example/app", /APP_EXTRA_ORIGINS.*item 1.*caminho/],
    ["com consulta", "https://a.example?x=1", /APP_EXTRA_ORIGINS.*item 1.*caminho/],
    ["com fragmento", "https://a.example#x", /APP_EXTRA_ORIGINS.*item 1.*caminho/],
    ["com credenciais", "https://u:SENHA-SECRETA@a.example", /APP_EXTRA_ORIGINS.*item 1/],
    ["curinga", "https://*.example.com", /APP_EXTRA_ORIGINS.*item 1.*curinga/],
    ["curinga solto", "*", /APP_EXTRA_ORIGINS.*item 1.*curinga/],
    ["texto que não é URL", "não é url", /APP_EXTRA_ORIGINS.*item 1.*URL/],
    ["outro esquema", "ftp://a.example", /APP_EXTRA_ORIGINS.*item 1.*https/],
  ])("derruba a partida: %s", (_name, value, pattern) => {
    expect(() => loadConfig({ ...valid, APP_EXTRA_ORIGINS: value })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, APP_EXTRA_ORIGINS: value })).toThrow(pattern);
  });

  it("diz qual item está errado e não repete o valor", () => {
    try {
      loadConfig({ ...valid, APP_EXTRA_ORIGINS: "https://ok.example,https://u:SENHA-SECRETA@a.example/x" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/item 2/);
      expect(String(error)).not.toContain("SENHA-SECRETA");
    }
  });

  it("aceita até 5 itens e recusa 6", () => {
    const five = ["a", "b", "c", "d", "e"].map((x) => `https://${x}.example`).join(",");
    expect(loadConfig({ ...valid, APP_EXTRA_ORIGINS: five }).APP_EXTRA_ORIGINS).toHaveLength(5);
    expect(() => loadConfig({ ...valid, APP_EXTRA_ORIGINS: `${five},https://f.example` })).toThrow(/APP_EXTRA_ORIGINS.*no máximo 5/);
  });

  it("repetidos e a principal não contam para o limite de 5", () => {
    const five = ["a", "b", "c", "d", "e"].map((x) => `https://${x}.example`).join(",");
    expect(loadConfig({ ...valid, APP_EXTRA_ORIGINS: `${five},https://a.example,https://treepm.ai` }).APP_EXTRA_ORIGINS).toHaveLength(5);
  });
});

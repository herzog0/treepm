import { createPrismaClient, withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { APP_URL } from "@treepm/db/testing";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runEmbeddingsCommand, embeddingsReindexCommand, embeddingsStatusCommand } from "../scripts/placement-rebuild/embeddings-commands.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import { FakeEmbeddingProvider } from "../scripts/placement-rebuild/fakes.js";
import { EmbeddingError } from "../src/assistant/ports.js";
import type { EmbeddingStore } from "../src/assistant/ticket-embeddings.js";
import { ownerPoolWithCleanup, truncateAll } from "./helpers.js";
import { ORG, seedWorld } from "./world.js";
import type { World } from "./world.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";

const pool: pg.Pool = ownerPoolWithCleanup();
let prisma: PrismaClient;
let world: World;
const store: EmbeddingStore = { run: (fn) => withTenant(prisma, { orgId: ORG, userId: "placement-rebuild" }, (tx) => fn(tx, ORG)) };
let lines: string[] = [];
const log = (line: string) => lines.push(line);

beforeAll(() => {
  prisma = createPrismaClient(APP_URL);
});
afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});
beforeEach(async () => {
  await truncateAll(pool);
  world = await seedWorld(pool);
  lines = [];
});

const seed = async (count: number) => {
  for (let i = 1; i <= count; i += 1) {
    await pool.query("insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ($1,$2,$3,$4,$5,$6)", [ORG, world.projects.priv, i, `Título secreto ${i}`, `Descrição confidencial ${i}`, world.people.admin]);
  }
};
const ctx = (provider: FakeEmbeddingProvider | null, dryRun = false, model = "fake") => ({ store, projectId: world.projects.priv, provider, dryRun, model, log });

describe("embeddings-status", () => {
  it("imprime só números e não chama provedor", async () => {
    await seed(3);
    await embeddingsStatusCommand(ctx(null));
    expect(lines.join("\n")).toMatch(/vivos: 3/);
    expect(lines.join("\n")).toMatch(/em dia: 0/);
    expect(lines.join("\n")).toMatch(/faltando: 3/);
    expect(lines.join("\n")).not.toMatch(/secreto|confidencial/);
  });

  it("depois de reindexar com o falso, o estado do modelo de verdade diz desatualizados, não em dia", async () => {
    await seed(2);
    await embeddingsReindexCommand(ctx(new FakeEmbeddingProvider()));
    lines = [];
    await embeddingsStatusCommand(ctx(null, false, "fake"));
    expect(lines.join("\n")).toMatch(/em dia: 2/);
    lines = [];
    await embeddingsStatusCommand(ctx(null, false, "voyage-4-lite"));
    expect(lines.join("\n")).toMatch(/em dia: 0/);
    expect(lines.join("\n")).toMatch(/desatualizados: 2/);
    expect(lines.join("\n")).toMatch(/faltando: 0/);
  });
});

describe("embeddings-reindex", () => {
  it("--dry-run não chama o provedor e diz quantos textos e caracteres iriam", async () => {
    await seed(2);
    const provider = new FakeEmbeddingProvider();
    await embeddingsReindexCommand(ctx(provider, true));
    expect(provider.calls).toHaveLength(0);
    const text = lines.join("\n");
    expect(text).toMatch(/2 textos/);
    // "Título secreto 1\n\nDescrição confidencial 1" = 16 + 2 + 24 = 42 caracteres, duas vezes.
    expect(text).toMatch(/84 caracteres/);
    expect((await pool.query("select 1 from ticket_embeddings")).rowCount).toBe(0);
  });

  it("--dry-run funciona sem provedor nenhum (sem chave)", async () => {
    await seed(1);
    await expect(embeddingsReindexCommand(ctx(null, true))).resolves.toBe(0);
  });

  it("põe o projeto inteiro em dia em lotes, com progresso em números", async () => {
    await seed(5);
    const provider = new FakeEmbeddingProvider();
    expect(await embeddingsReindexCommand({ ...ctx(provider), max: 2 })).toBe(0);
    expect((await pool.query("select 1 from ticket_embeddings")).rowCount).toBe(5);
    const text = lines.join("\n");
    expect(text).toMatch(/lote 1/);
    expect(text).toMatch(/lote 3/);
    expect(text).toMatch(/pendentes: 0/);
    expect(text).not.toMatch(/secreto|confidencial/);
    // Rodar de novo não envia nada.
    const again = new FakeEmbeddingProvider();
    await embeddingsReindexCommand(ctx(again));
    expect(again.calls).toHaveLength(0);
  });

  it("falha do provedor: para, diz o código e não lança", async () => {
    await seed(3);
    const provider = new FakeEmbeddingProvider();
    provider.fail = "unauthorized";
    expect(await embeddingsReindexCommand(ctx(provider))).toBe(1);
    expect(lines.join("\n")).toMatch(/falha: unauthorized/);
    expect((await pool.query("select 1 from ticket_embeddings")).rowCount).toBe(0);
  });

  it("sem provedor e sem --dry-run, recusa com mensagem clara", async () => {
    await seed(1);
    await expect(embeddingsReindexCommand(ctx(null))).rejects.toThrow(/VOYAGE_API_KEY/);
  });
});

describe("embeddings-reindex: texto que o provedor recusa", () => {
  it("termina com falha e pendentes: código de saída 1, e o resto do projeto fica em dia", async () => {
    await seed(3);
    await pool.query("update tickets set title = 'VENENO' where number = 2");
    class Poison extends FakeEmbeddingProvider {
      override async embed(texts: readonly string[], kind: "document" | "query", options?: { signal?: AbortSignal }): Promise<number[][]> {
        if (texts.some((text) => text.includes("VENENO"))) throw new EmbeddingError("bad_request");
        return super.embed(texts, kind, options);
      }
    }
    expect(await embeddingsReindexCommand(ctx(new Poison()))).toBe(1);
    expect((await pool.query("select 1 from ticket_embeddings")).rowCount).toBe(2);
    expect(lines.join("\n")).toMatch(/falha: bad_request/);
    expect(lines.join("\n")).toMatch(/pendentes: 1/);
  });
});

describe("conferência do aceite nos comandos", () => {
  const orgOptions = { org: ORG, user: "u_admin", project: "", fakeProviders: true } as const;
  const spy = () => {
    const state = { providers: 0, provider: new FakeEmbeddingProvider(), connections: 0 };
    return {
      state,
      deps: {
        log,
        providerFor: () => {
          state.providers += 1;
          return state.provider;
        },
        onConnect: () => {
          state.connections += 1;
        },
      },
    };
  };

  it.each(["embeddings-status", "embeddings-reindex"] as const)("%s recusa numa organização sem aceite em vigor: nenhum provedor, nenhuma conexão com o banco, nenhuma leitura", async (command) => {
    await seed(2);
    await pool.query("truncate organization_consents");
    const { state, deps } = spy();
    await expect(runEmbeddingsCommand(command, { ...orgOptions, project: world.projects.priv }, deps)).rejects.toThrow(/aceite do assistente de IA/);
    expect(state).toMatchObject({ providers: 0, connections: 0 });
    expect(state.provider.calls).toHaveLength(0);
    expect(lines).toEqual([]);
  });

  it("aceite de versão antiga (rascunho-1) também recusa", async () => {
    await seed(1);
    await pool.query("update organization_consents set document_version = 'rascunho-1'");
    const { state, deps } = spy();
    await expect(runEmbeddingsCommand("embeddings-reindex", { ...orgOptions, project: world.projects.priv }, deps)).rejects.toThrow(/aceite/);
    expect(state.provider.calls).toHaveLength(0);
  });

  it("com o aceite em vigor, o status roda e o reindex usa o provedor", async () => {
    await seed(2);
    const { state, deps } = spy();
    expect(await runEmbeddingsCommand("embeddings-status", { ...orgOptions, project: world.projects.priv }, deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/faltando: 2/);
    expect(await runEmbeddingsCommand("embeddings-reindex", { ...orgOptions, project: world.projects.priv }, deps)).toBe(0);
    expect(state.provider.calls.length).toBeGreaterThan(0);
  });
});

describe("argumentos", () => {
  it("os dois comandos pedem --org --user --project, e --dry-run só existe no reindex", () => {
    expect(parseCliArgs(["embeddings-status", "--org", "o", "--user", "u", "--project", "p"]).ok).toBe(true);
    expect(parseCliArgs(["embeddings-reindex", "--org", "o", "--user", "u", "--project", "p", "--dry-run"]).ok).toBe(true);
    expect(parseCliArgs(["embeddings-status", "--org", "o", "--user", "u", "--project", "p", "--dry-run"]).ok).toBe(false);
    expect(parseCliArgs(["embeddings-reindex", "--org", "o", "--user", "u"]).ok).toBe(false);
  });
});

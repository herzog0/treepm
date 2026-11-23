import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AssistantGate } from "../src/assistant/assistant-gate.js";
import { EMBEDDING_PROVIDER } from "../src/assistant/ports.js";
import { VoyageEmbeddingProvider } from "../src/assistant/voyage-embedding-provider.js";
import { AI_CONFIG, TEST_CONFIG, createTestApp } from "./helpers.js";

/** Abre o portão como a rota abriria, mas sem a conferência do aceite (só `configured`, que é o que se confere aqui). */
const providersOf = (app: INestApplication) => (app.get(AssistantGate) as unknown as { configured(): { embedder: unknown } }).configured();

describe("a porta de vetores no portão do assistente (ADR 0053)", () => {
  it("sem VOYAGE_API_KEY o assistente continua configurado e o embedder é nulo", async () => {
    const { app } = await createTestApp([], AI_CONFIG);
    expect(providersOf(app).embedder).toBeNull();
    await app.close();
  });

  it("com VOYAGE_API_KEY o embedder chega pelo portão", async () => {
    const { app, embedder } = await createTestApp([], { ...AI_CONFIG, VOYAGE_API_KEY: "v" });
    expect(providersOf(app).embedder).toBe(embedder);
    await app.close();
  });

  it("no módulo real: sem a chave não há provedor; com a chave é o adaptador da Voyage", async () => {
    const off = await createTestApp([], AI_CONFIG, { realAssistant: true });
    const on = await createTestApp([], { ...AI_CONFIG, VOYAGE_API_KEY: "v" }, { realAssistant: true });
    expect(off.app.get(EMBEDDING_PROVIDER)).toBeNull();
    expect(on.app.get(EMBEDDING_PROVIDER)).toBeInstanceOf(VoyageEmbeddingProvider);
    await off.app.close();
    await on.app.close();
  });

  it("só com VOYAGE_API_KEY, com o assistente desligado (faltam as chaves da IA), não há provedor de vetores", async () => {
    const onlyVoyage = await createTestApp([], { ...TEST_CONFIG, VOYAGE_API_KEY: "v" }, { realAssistant: true });
    expect(onlyVoyage.app.get(EMBEDDING_PROVIDER)).toBeNull();
    const oneAiKey = await createTestApp([], { ...TEST_CONFIG, ANTHROPIC_API_KEY: "a", VOYAGE_API_KEY: "v" }, { realAssistant: true });
    expect(oneAiKey.app.get(EMBEDDING_PROVIDER)).toBeNull();
    await onlyVoyage.app.close();
    await oneAiKey.app.close();
  });

  it("só o portão, o módulo e ports.ts mencionam EMBEDDING_PROVIDER", () => {
    const src = join(__dirname, "..", "src");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
    const users = walk(src)
      .filter((f) => /\bEMBEDDING_PROVIDER\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(join(__dirname, ".."), f))
      .sort();
    expect(users).toEqual(["src/assistant/assistant-gate.ts", "src/assistant/assistant.module.ts", "src/assistant/ports.ts"]);
  });
});

import { createPrismaClient, withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { APP_URL } from "@treepm/db/testing";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider } from "../scripts/placement-rebuild/fakes.js";
import type { EmbeddingKind } from "../src/assistant/ports.js";
import { boundedSearch, SEMANTIC_MAX_DISTANCE, SEMANTIC_QUERY_RESERVE_MS, SEMANTIC_TRIAGE_DEADLINE_MS, semanticNeighbours, semanticSearchOf } from "../src/assistant/semantic-triage.js";
import type { EmbeddingStore } from "../src/assistant/ticket-embeddings.js";
import { ownerPoolWithCleanup, openApiTransactions, truncateAll } from "./helpers.js";
import { ORG, seedWorld } from "./world.js";
import type { World } from "./world.js";

const pool: pg.Pool = ownerPoolWithCleanup();
let prisma: PrismaClient;
let world: World;
let number = 0;
const store: EmbeddingStore = { run: (fn) => withTenant(prisma, { orgId: ORG, userId: `u_${ORG}` }, (tx) => fn(tx, ORG)) };

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
  number = 0;
});

async function ticket(title: string, description = "", status = "todo"): Promise<string> {
  const r = await pool.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, description, status, created_by_person_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [ORG, world.projects.priv, ++number, title, description, status, world.people.admin],
  );
  return r.rows[0]?.id ?? "";
}
const ask = (embedder: FakeEmbeddingProvider | null, extra: Partial<Parameters<typeof semanticNeighbours>[0]> = {}) =>
  semanticNeighbours({ store, embedder, projectId: world.projects.priv, queries: [{ title: "Guardar a origem de cada ticket", description: "" }], k: 5, ...extra });

describe("semanticNeighbours", () => {
  it("põe os vetores em dia, faz UMA chamada de consulta e devolve os vizinhos em ordem de distância, com números", async () => {
    const origin = await ticket("Guardar a origem de cada ticket", "Reimportar sem duplicar");
    await ticket("Tema escuro do painel");
    const embedder = new FakeEmbeddingProvider();
    const result = await ask(embedder, { queries: [{ title: "Guardar a origem de cada ticket", description: "" }, { title: "Tema escuro do painel", description: "" }] });
    expect(result.neighbours).toHaveLength(2);
    expect(result.neighbours[0]?.[0]?.ticketId).toBe(origin);
    expect(result.neighbours[0]?.[0]?.distance).toBeLessThan(result.neighbours[0]?.[1]?.distance ?? 0);
    expect(result.diagnostics).toMatchObject({ synced: 2, embedded: 2, pending: 0, syncMs: expect.any(Number), queryMs: expect.any(Number) });
    expect(result.diagnostics.failure).toBeUndefined();
    // Uma chamada de documentos (a sincronização) e UMA de consulta com as duas consultas.
    expect(embedder.calls.map((call) => call.kind)).toEqual(["document", "query"]);
    expect(embedder.calls[1]?.texts).toEqual(["Guardar a origem de cada ticket", "Tema escuro do painel"]);
  });

  it("a consulta é o título, uma linha em branco e a descrição: nada além disso chega à porta", async () => {
    await ticket("Alvo");
    const embedder = new FakeEmbeddingProvider();
    await ask(embedder, { queries: [{ title: "  Sincronizar com o Jira ", description: "Receber só o diff." }] });
    expect(embedder.calls.find((call) => call.kind === "query")?.texts).toEqual(["Sincronizar com o Jira\n\nReceber só o diff."]);
  });

  it("queryKind troca o tipo da consulta ao provedor; sem ele vale `query`", async () => {
    await ticket("Alvo");
    const document = new FakeEmbeddingProvider();
    await ask(document, { queryKind: "document" });
    expect(document.calls.map((call) => call.kind)).toEqual(["document", "document"]);
    // Os vetores dos tickets já estão em dia: só a consulta é chamada, agora com o tipo padrão.
    const plain = new FakeEmbeddingProvider();
    await ask(plain);
    expect(plain.calls.map((call) => call.kind)).toEqual(["query"]);
  });

  it("sem embedder: nada é lido nem chamado, lista vazia e o código no_embedder", async () => {
    await ticket("A");
    let reads = 0;
    const counting: EmbeddingStore = { run: (fn) => (reads++, store.run(fn)) };
    const result = await ask(null, { store: counting });
    expect(reads).toBe(0);
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics).toEqual({ synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "no_embedder" });
  });

  it("falha do provedor na consulta nunca lança: lista vazia e o código", async () => {
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    embedder.failCall = 2; // a 1ª é a sincronização; a 2ª é a consulta
    const result = await ask(embedder);
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics).toMatchObject({ failure: "server_error", embedded: 1 });
  });

  it("falha dura na sincronização (chave recusada): não chama de novo, lista vazia e o código", async () => {
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    embedder.fail = "unauthorized";
    const result = await ask(embedder);
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics.failure).toBe("unauthorized");
    expect(embedder.calls).toHaveLength(1);
  });

  it("falha do banco vira storage, sem lançar nem chamar o provedor", async () => {
    const embedder = new FakeEmbeddingProvider();
    const broken: EmbeddingStore = { run: () => Promise.reject(new Error("banco fora")) };
    const result = await ask(embedder, { store: broken });
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics.failure).toBe("storage");
    expect(embedder.calls).toHaveLength(0);
  });

  it("o prazo total vale: provedor lento vira timeout dentro do prazo, sem lançar", async () => {
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    embedder.delayMs = 2000;
    const started = Date.now();
    const result = await ask(embedder, { deadlineMs: 300, syncDeadlineMs: 200 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics.failure).toBe("timeout");
  });

  it("sem tempo para o passo de vetor: skipped_no_time, nenhuma chamada", async () => {
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    const result = await ask(embedder, { deadlineMs: 0 });
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics.failure).toBe("skipped_no_time");
    expect(embedder.calls).toHaveLength(0);
  });

  it("o sinal de fora vale: abortado antes de começar, nenhuma chamada; abortado no meio, para", async () => {
    await ticket("A");
    const before = new FakeEmbeddingProvider();
    const early = AbortSignal.abort();
    expect((await ask(before, { signal: early })).diagnostics.failure).toBe("timeout");
    expect(before.calls).toHaveLength(0);
    const during = new FakeEmbeddingProvider();
    during.delayMs = 2000;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await ask(during, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.diagnostics.failure).toBe("timeout");
  });

  it("a sincronização usa no máximo o prazo dela e a consulta ainda cabe no total", async () => {
    expect(SEMANTIC_TRIAGE_DEADLINE_MS).toBe(5000);
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    const result = await ask(embedder, { syncDeadlineMs: 4000 });
    expect(result.diagnostics.failure).toBeUndefined();
  });

  it("ticket cancelado não vem como vizinho", async () => {
    await ticket("Guardar a origem de cada ticket", "", "cancelled");
    const other = await ticket("Origem de cada ticket");
    const result = await ask(new FakeEmbeddingProvider());
    expect(result.neighbours[0]?.map((n) => n.ticketId)).toEqual([other]);
  });

  it("a chamada ao provedor acontece fora de transação do banco, na sincronização e na consulta", async () => {
    await ticket("A");
    const seen: number[] = [];
    class Probe extends FakeEmbeddingProvider {
      override async embed(texts: readonly string[], kind: EmbeddingKind, options?: { signal?: AbortSignal }): Promise<number[][]> {
        seen.push(await openApiTransactions(pool));
        return super.embed(texts, kind, options);
      }
    }
    await ask(new Probe());
    expect(seen).toEqual([0, 0]);
  });

  it("sem consulta nenhuma: nada é chamado", async () => {
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    const result = await ask(embedder, { queries: [] });
    expect(result.neighbours).toEqual([]);
    expect(embedder.calls).toHaveLength(0);
  });

  it("banco lento: o passo inteiro corre contra o prazo e a busca segue (timeout), sem rejeição solta", async () => {
    await ticket("A");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const slow: EmbeddingStore = { run: (fn) => new Promise((resolve, reject) => setTimeout(() => store.run(fn).then(resolve, reject), 1500)) };
    const started = Date.now();
    const result = await ask(new FakeEmbeddingProvider(), { store: slow, deadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(1200);
    expect(result.neighbours).toEqual([[]]);
    expect(result.diagnostics.failure).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("reserva para a consulta: sobrando menos que 1 500 ms, a sincronização é pulada e só a consulta roda", async () => {
    expect(SEMANTIC_QUERY_RESERVE_MS).toBe(1500);
    await ticket("A");
    const embedder = new FakeEmbeddingProvider();
    await ask(embedder, { deadlineMs: 1500 });
    expect(embedder.calls.map((c) => c.kind)).toEqual(["query"]);
    const rich = new FakeEmbeddingProvider();
    await ask(rich, { deadlineMs: 5000 });
    expect(rich.calls.map((c) => c.kind)).toEqual(["document", "query"]);
  });

  it("limiar de distância: acima dele o vizinho não entra", async () => {
    expect(SEMANTIC_MAX_DISTANCE).toBe(1);
    await ticket("Guardar a origem de cada ticket");
    await ticket("Tema escuro do painel");
    const all = await ask(new FakeEmbeddingProvider());
    expect(all.neighbours[0]).toHaveLength(2);
    const near = await ask(new FakeEmbeddingProvider(), { maxDistance: 0.5 });
    expect(near.neighbours[0]).toHaveLength(1);
    expect((await ask(new FakeEmbeddingProvider(), { maxDistance: -1 })).neighbours).toEqual([[]]);
  });

  it("boundedSearch: fonte que trava ou lança vira vazio com código, dentro do prazo", async () => {
    const hang = () => new Promise<never>(() => undefined);
    const started = Date.now();
    const a = await boundedSearch(hang, [{ title: "x", description: "" }], 5, { deadlineMs: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(a).toMatchObject({ neighbours: [[]], diagnostics: { failure: "timeout" } });
    const b = await boundedSearch(() => Promise.reject(new Error("boom")), [{ title: "x", description: "" }], 5, { deadlineMs: 200 });
    expect(b.diagnostics.failure).toBe("storage");
  });
});

describe("semanticSearchOf com SEMANTIC_TRIAGE=off", () => {
  it("não lê vetores, não sincroniza e não chama o provedor: listas vazias e o código disabled", async () => {
    await ticket("Guardar a origem de cada ticket");
    let reads = 0;
    const counting: EmbeddingStore = { run: (fn) => (reads++, store.run(fn)) };
    const embedder = new FakeEmbeddingProvider();
    const search = semanticSearchOf(counting, embedder, world.projects.priv, { mode: "off", queryKind: "query" });
    const result = await search([{ title: "Guardar a origem de cada ticket", description: "" }, { title: "Outra", description: "" }], 5, {});
    expect(reads).toBe(0);
    expect(embedder.calls).toHaveLength(0);
    expect(result.neighbours).toEqual([[], []]);
    expect(result.diagnostics).toEqual({ synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "disabled" });
    expect((await pool.query("select count(*)::int as n from ticket_embeddings")).rows[0].n).toBe(0);
  });

  it("rrf e interleave usam o provedor, com o tipo de consulta escolhido", async () => {
    await ticket("Guardar a origem de cada ticket");
    for (const mode of ["rrf", "interleave"] as const) {
      const embedder = new FakeEmbeddingProvider();
      const result = await semanticSearchOf(store, embedder, world.projects.priv, { mode, queryKind: "document" })([{ title: "Guardar a origem de cada ticket", description: "" }], 5, {});
      expect(result.neighbours[0]).toHaveLength(1);
      // Na primeira rodada sincroniza (documento) e consulta; na segunda os vetores já estão em dia.
      expect(embedder.calls.at(-1)?.kind).toBe("document");
      expect(embedder.calls.length).toBeGreaterThan(0);
    }
  });
});

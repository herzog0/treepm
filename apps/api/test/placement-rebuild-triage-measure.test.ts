import { createPrismaClient, withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { APP_URL } from "@treepm/db/testing";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import { FakeEmbeddingProvider } from "../scripts/placement-rebuild/fakes.js";
import { exitCodeOf, measureTriage, parsePairsFile, renderTriage, runTriageMeasure, TriageMeasureError } from "../scripts/placement-rebuild/triage-measure.js";
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
let n = 0;
const store: EmbeddingStore = { run: (fn) => withTenant(prisma, { orgId: ORG, userId: "triage-measure" }, (tx) => fn(tx, ORG)) };
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
  n = 0;
});

const ticket = async (title: string, description = "", extra: { parent?: string; status?: string } = {}): Promise<string> =>
  (
    await pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, description, status, parent_id, created_by_person_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
      [ORG, world.projects.priv, ++n, title, description, extra.status ?? "todo", extra.parent ?? null, world.people.admin],
    )
  ).rows[0]!.id;
const dependsOn = (from: string, to: string) => pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1,$2,$3,$4,'depends_on')", [ORG, world.projects.priv, from, to]);
const measure = (provider: FakeEmbeddingProvider, over: Partial<Parameters<typeof measureTriage>[0]> = {}) => measureTriage({ store, projectId: world.projects.priv, provider, kind: "query", extra: [], log, ...over });

describe("triage-measure", () => {
  it("cada ligação 'depende de' vira um par: a origem é a consulta e fica fora; o alvo é o esperado, com as três posições", async () => {
    const target = await ticket("Reimportar sem duplicar", "guardar a origem de cada ticket externo");
    const origin = await ticket("Sincronizar com o Jira", "guardar origem externa para receber diff");
    await ticket("Tema escuro", "cores");
    await dependsOn(origin, target);
    const report = await measure(new FakeEmbeddingProvider());
    expect(report.items).toEqual([{ pair: "PRIV-2", origin: "dependency", expected: "PRIV-1", words: expect.any(Number), vector: expect.any(Number), fused: expect.any(Number), distance: expect.any(Number) }]);
    // A origem nunca aparece como candidata: sem ela, o alvo é o primeiro das palavras e do vetor.
    expect(report.items[0]).toMatchObject({ words: 1, vector: 1, fused: 1 });
    expect(report.summary).toMatchObject({ items: 1, top10: { words: 1, vector: 1, fused: 1 }, top30: { words: 1, vector: 1, fused: 1 }, lostByFusion: 0, gainedByFusion: 0 });
  });

  it("pares do arquivo: o esperado sem palavra em comum só entra pelo vetor; `omit` tira o ticket e os descendentes dos candidatos", async () => {
    const sync = await ticket("Reimportar sem duplicar", "guardar a origem");
    await ticket("Tema escuro", "cores do painel");
    const omitted = await ticket("O próprio pedido", "sincronizar tickets");
    await ticket("Filho do omitido", "sincronizar tickets", { parent: omitted });
    const provider = new FakeEmbeddingProvider();
    provider.concepts = { sincronizar: "c", reimportar: "c", guardar: "c" };
    const report = await measure(provider, { extra: [{ query: { title: "Sincronizar com outro sistema", description: "" }, expect: ["PRIV-1"], omit: ["PRIV-3"] }] });
    expect(report.items).toEqual([{ pair: "extra-1", origin: "file", expected: "PRIV-1", words: null, vector: 1, fused: 1, distance: expect.any(Number) }]);
    expect(report.summary).toMatchObject({ top10: { words: 0, vector: 1, fused: 1 }, lostByFusion: 0, gainedByFusion: 1 });
    expect(sync).toBeTruthy();
  });

  it("a fusão perde um achado das palavras (união > 30): lostByFusion = 1 e o código de saída é 1", async () => {
    const junk = Array.from({ length: 60 }, (_, i) => `jk${i}x`).join(" ");
    for (let i = 0; i < 30; i += 1) await ticket(`Webhook ${i}`, junk); // 1..30: achados por palavras, longe no vetor
    for (let i = 0; i < 30; i += 1) await ticket(`Gancho ${i}`, ""); // 31..60: só o vetor
    const provider = new FakeEmbeddingProvider();
    provider.concepts = { gancho: "webhook" };
    const report = await measure(provider, { extra: [{ query: { title: "Webhook de saída", description: "" }, expect: ["PRIV-30"] }] });
    expect(report.items[0]).toMatchObject({ words: 30, fused: null });
    expect(report.summary).toMatchObject({ lostByFusion: 1, lostKeys: ["extra-1>PRIV-30"] });
    expect(exitCodeOf(report)).toBe(1);
    const out = renderTriage(report).join("\n");
    expect(out).toMatch(/perdeu: 1 \(extra-1>PRIV-30\)/);
    expect(out).not.toMatch(/Webhook|Gancho/);
  });

  it("sem perda o código de saída é 0; mostra distância do esperado e o resumo de distâncias", async () => {
    const target = await ticket("Reimportar sem duplicar", "guardar a origem");
    const origin = await ticket("Sincronizar", "guardar origem");
    await dependsOn(origin, target);
    const report = await measure(new FakeEmbeddingProvider());
    expect(exitCodeOf(report)).toBe(0);
    expect(report.items[0]!.distance).toBeGreaterThanOrEqual(0);
    expect(report.summary.distances.expectedMedian).toBe(report.items[0]!.distance);
    expect(renderTriage(report).join("\n")).toMatch(/distância=\d\.\d{4}[\s\S]*limiar de distância: 1;/);
  });

  it("limiar de distância: abaixo dele o esperado some da lista de vetor", async () => {
    const target = await ticket("Reimportar sem duplicar", "guardar a origem");
    const origin = await ticket("Outro assunto", "zzzz yyyy");
    await dependsOn(origin, target);
    const report = await measure(new FakeEmbeddingProvider(), { maxDistance: 0.1 });
    expect(report.items[0]).toMatchObject({ vector: null, fused: null });
    expect(report.items[0]!.distance).not.toBeNull();
  });

  it("provedor falso recusa projeto com vetor de modelo de verdade, antes de gravar qualquer coisa", async () => {
    const t = await ticket("Alvo", "");
    const o = await ticket("Origem", "");
    await dependsOn(o, t);
    await measure(new FakeEmbeddingProvider());
    await pool.query("update ticket_embeddings set model = 'voyage-4-lite' where ticket_id = $1", [t]);
    const before = (await pool.query("select ticket_id, model, content_hash from ticket_embeddings order by ticket_id")).rows;
    const fake = new FakeEmbeddingProvider();
    await expect(measure(fake)).rejects.toThrow(/Recusado/);
    expect(fake.calls).toHaveLength(0);
    expect((await pool.query("select ticket_id, model, content_hash from ticket_embeddings order by ticket_id")).rows).toEqual(before);
  });

  it("`--max-distance` valida", () => {
    expect(parseCliArgs(["triage-measure", "--org", "o", "--user", "u", "--project", "p", "--max-distance", "0.8"])).toMatchObject({ ok: true, options: { maxDistance: 0.8 } });
    expect(parseCliArgs(["triage-measure", "--org", "o", "--user", "u", "--project", "p", "--max-distance", "x"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["export", "--org", "o", "--user", "u", "--dir", "d", "--project", "p", "--max-distance", "1"])).toMatchObject({ ok: false });
  });

  it("a saída mostra chaves e números, nunca título ou texto", async () => {
    const target = await ticket("Título secreto do alvo", "descrição confidencial");
    const origin = await ticket("Título secreto da origem", "descrição confidencial");
    await dependsOn(origin, target);
    const lines2 = renderTriage(await measure(new FakeEmbeddingProvider())).join("\n");
    expect(lines2).toMatch(/PRIV-2 -> PRIV-1 {2}palavras=1 {2}vetor=1 {2}fusão=1 {2}distância=/);
    expect(lines2).not.toMatch(/secreto|confidencial/);
  });

  it("chave que não é ticket vivo nos pares do arquivo é erro, sem enviar nada", async () => {
    await ticket("Um", "");
    const provider = new FakeEmbeddingProvider();
    await expect(measure(provider, { extra: [{ query: { title: "x", description: "" }, expect: ["PRIV-99"] }] })).rejects.toThrow(TriageMeasureError);
    await ticket("Cancelado", "", { status: "cancelled" });
    await expect(measure(provider, { extra: [{ query: { title: "x", description: "" }, expect: ["PRIV-2"] }] })).rejects.toThrow(/não é um ticket vivo/);
  });

  it("sem par nenhum a medição recusa; falha do provedor na sincronização não mede nada", async () => {
    await ticket("Um", "");
    await expect(measure(new FakeEmbeddingProvider())).rejects.toThrow(/Não há pares/);
    const broken = new FakeEmbeddingProvider();
    broken.fail = "unauthorized";
    await expect(measure(broken, { extra: [{ query: { title: "x", description: "" }, expect: ["PRIV-1"] }] })).rejects.toThrow(/unauthorized/);
  });

  it("`--kinds document` troca o tipo da consulta ao provedor", async () => {
    const t = await ticket("Alvo", "");
    const o = await ticket("Origem", "");
    await dependsOn(o, t);
    const provider = new FakeEmbeddingProvider();
    await measure(provider, { kind: "document" });
    expect(provider.calls.map((c) => c.kind)).toEqual(["document", "document"]);
    const q = new FakeEmbeddingProvider();
    await measure(q);
    // Os vetores do modelo já estão em dia (gravados na primeira medição): só a consulta vai ao provedor, como `query` (o padrão).
    expect(q.calls.map((c) => c.kind)).toEqual(["query"]);
  });
});

describe("arquivo de pares e linha de comando", () => {
  it("o arquivo de pares valida a forma", () => {
    expect(parsePairsFile('[{"query":{"title":"A","description":"B"},"expect":["X-1"],"omit":["X-2"]}]')).toEqual([{ query: { title: "A", description: "B" }, expect: ["X-1"], omit: ["X-2"] }]);
    expect(() => parsePairsFile("{")).toThrow(TriageMeasureError);
    expect(() => parsePairsFile('[{"query":{"title":""},"expect":["X-1"]}]')).toThrow(/query.title/);
    expect(() => parsePairsFile('[{"query":{"title":"A"},"expect":[]}]')).toThrow(/expect/);
  });

  it("os parâmetros do comando: --pairs e --json levam arquivo aqui e só aqui; --kinds valida", () => {
    const parsed = parseCliArgs(["triage-measure", "--org", "o", "--user", "u", "--project", "p", "--pairs", "a.json", "--json", "b.json", "--kinds", "document", "--fake-providers"]);
    expect(parsed).toMatchObject({ ok: true, command: "triage-measure", options: { pairsFile: "a.json", jsonFile: "b.json", kinds: "document", fakeProviders: true } });
    expect(parseCliArgs(["triage-measure", "--org", "o", "--user", "u", "--project", "p", "--kinds", "x"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["triage-measure", "--org", "o", "--user", "u"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["export", "--org", "o", "--user", "u", "--dir", "d", "--project", "p", "--kinds", "query"])).toMatchObject({ ok: false });
  });

  it("sem aceite em vigor nada é lido nem criado (conferência antes de tudo)", async () => {
    let connected = false;
    await expect(
      runTriageMeasure({ org: "org_SEM_ACEITE", user: "u", project: world.projects.priv, fakeProviders: true }, { log, onConnect: () => (connected = true) }),
    ).rejects.toThrow();
    expect(connected).toBe(false);
  });
});

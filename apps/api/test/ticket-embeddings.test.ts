import { createPrismaClient, withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { APP_URL } from "@treepm/db/testing";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeEmbeddingProvider, fakeVector } from "../scripts/placement-rebuild/fakes.js";
import { EMBEDDING_DIMENSIONS, EmbeddingError } from "../src/assistant/ports.js";
import type { EmbeddingKind } from "../src/assistant/ports.js";
import { EMBEDDING_SYNC_DEADLINE_MS, EMBEDDING_SYNC_MAX, embeddingStatus, ticketEmbeddingHash, loadEmbeddableTickets, nearestTickets, syncEmbeddings } from "../src/assistant/ticket-embeddings.js";
import type { EmbeddingStore } from "../src/assistant/ticket-embeddings.js";
import { ownerPoolWithCleanup, openApiTransactions, truncateAll } from "./helpers.js";
import { ORG, OTHER_ORG, seedWorld } from "./world.js";
import type { World } from "./world.js";

const pool: pg.Pool = ownerPoolWithCleanup();
let prisma: PrismaClient;
let world: World;
let number = 0;

const storeOf = (orgId = ORG): EmbeddingStore => ({ run: (fn) => withTenant(prisma, { orgId, userId: `u_${orgId}` }, (tx) => fn(tx, orgId)) });
const store = storeOf();

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

type Seed = { parent?: string | null; status?: string; ideaStage?: string | null; description?: string; project?: string; org?: string };
async function ticket(title: string, seed: Seed = {}): Promise<string> {
  const org = seed.org ?? ORG;
  const r = await pool.query<{ id: string }>(
    "insert into tickets (org_id, project_id, number, title, description, status, parent_id, idea_stage, created_by_person_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
    [org, seed.project ?? world.projects.priv, ++number, title, seed.description ?? "", seed.status ?? "todo", seed.parent ?? null, seed.ideaStage ?? null, org === ORG ? world.people.admin : world.other.person],
  );
  return r.rows[0]?.id ?? "";
}
const live = (project = world.projects.priv, orgId = ORG) => storeOf(orgId).run((tx) => loadEmbeddableTickets(tx, project));
const rows = async () => (await pool.query<{ ticket_id: string; model: string; dimensions: number; content_hash: string }>("select ticket_id, model, dimensions, content_hash from ticket_embeddings order by ticket_id")).rows;
const sync = async (provider: FakeEmbeddingProvider, extra: Partial<Parameters<typeof syncEmbeddings>[1]> = {}) =>
  syncEmbeddings(store, { projectId: world.projects.priv, tickets: await live(), provider, ...extra });

describe("loadEmbeddableTickets", () => {
  it("lê os vivos: sem cancelado (e seus filhos), sem ideia (e o que está dentro); a descrição vem inteira até 8 000 caracteres", async () => {
    const a = await ticket("A", { description: "x".repeat(9000) });
    const b = await ticket("B", { status: "cancelled" });
    await ticket("Filho do cancelado", { parent: b });
    const idea = await ticket("Ideia", { ideaStage: "new" });
    await ticket("Dentro da ideia", { parent: idea });
    await ticket("Descartada", { ideaStage: "discarded" });
    const c = await ticket("C", { parent: a });
    const tickets = await live();
    expect(tickets.map((t) => t.title)).toEqual(["A", "C"]);
    expect(tickets[0]?.description).toHaveLength(8000);
    expect(tickets[1]?.id).toBe(c);
  });
});

describe("syncEmbeddings", () => {
  it("põe em dia os tickets que faltam, só com o texto do ticket, e devolve só números", async () => {
    const a = await ticket("Sincronizar com o Jira", { description: "Receber só o diff." });
    await ticket("Importar do GitHub");
    const provider = new FakeEmbeddingProvider();
    const result = await sync(provider);
    expect(result).toEqual({ upToDate: 0, embedded: 2, pending: 0, ms: expect.any(Number) });
    expect(Object.keys(result).sort()).toEqual(["embedded", "ms", "pending", "upToDate"]);
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.ticket_id === a)).toMatchObject({ model: "fake", dimensions: EMBEDDING_DIMENSIONS, content_hash: ticketEmbeddingHash({ title: "Sincronizar com o Jira", description: "Receber só o diff." }) });
    expect(stored.every((r) => r.model === "fake")).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.kind).toBe("document");
  });

  it("o que chega à porta é só título e descrição: sem id, chave, pessoa, comentário nem nota", async () => {
    const parent = await ticket("Pai");
    const id = await ticket("Reimportar sem duplicar", { description: "Guardar a origem.", parent });
    await pool.query("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) values ($1,$2,$3,$4,'COMENTARIO-SECRETO')", [ORG, world.projects.priv, id, world.people.admin]);
    const provider = new FakeEmbeddingProvider();
    await sync(provider);
    const sent = provider.calls.flatMap((call) => call.texts).sort();
    expect(sent).toEqual(["Pai", "Reimportar sem duplicar\n\nGuardar a origem."]);
    const everything = JSON.stringify(provider.calls);
    for (const forbidden of [id, parent, ORG, world.projects.priv, world.people.admin, "Nome admin", "admin@exemplo.test", "COMENTARIO-SECRETO", "PRIV-", "todo"]) expect(everything).not.toContain(forbidden);
  });

  it("só o que mudou vai: a segunda chamada não envia nada, e editar o título reenvia só aquele", async () => {
    const a = await ticket("Primeiro");
    await ticket("Segundo");
    const first = new FakeEmbeddingProvider();
    await sync(first);
    const second = new FakeEmbeddingProvider();
    expect(await sync(second)).toMatchObject({ upToDate: 2, embedded: 0, pending: 0 });
    expect(second.calls).toHaveLength(0);
    await pool.query("update tickets set title = 'Primeiro editado' where id = $1", [a]);
    const third = new FakeEmbeddingProvider();
    expect(await sync(third)).toMatchObject({ upToDate: 1, embedded: 1, pending: 0 });
    expect(third.calls.flatMap((c) => c.texts)).toEqual(["Primeiro editado"]);
    // Situação e prioridade não mudam o resumo: nada a reenviar.
    await pool.query("update tickets set status = 'done', priority = 5 where id = $1", [a]);
    const fourth = new FakeEmbeddingProvider();
    expect(await sync(fourth)).toMatchObject({ upToDate: 2, embedded: 0 });
    expect(fourth.calls).toHaveLength(0);
  });

  it("linha de outro modelo ou de outra dimensão conta como desatualizada", async () => {
    const a = await ticket("Primeiro");
    const b = await ticket("Segundo");
    await sync(new FakeEmbeddingProvider());
    await pool.query("update ticket_embeddings set model = 'outro-modelo' where ticket_id = $1", [a]);
    await pool.query("update ticket_embeddings set dimensions = 256 where ticket_id = $1", [b]);
    const provider = new FakeEmbeddingProvider();
    expect(await sync(provider)).toMatchObject({ upToDate: 0, embedded: 2 });
    expect((await rows()).every((r) => r.model === "fake" && r.dimensions === EMBEDDING_DIMENSIONS)).toBe(true);
  });

  it("ticket cancelado ou dentro de ideia não é enviado", async () => {
    await ticket("Vivo");
    await ticket("Cancelado", { status: "cancelled" });
    const idea = await ticket("Ideia", { ideaStage: "refining" });
    await ticket("Na ideia", { parent: idea });
    const provider = new FakeEmbeddingProvider();
    await sync(provider);
    expect(provider.calls.flatMap((c) => c.texts)).toEqual(["Vivo"]);
  });

  it("respeita o teto por chamada: o resto fica pendente e a próxima chamada continua", async () => {
    expect(EMBEDDING_SYNC_MAX).toBe(256);
    for (let i = 0; i < 7; i += 1) await ticket(`Ticket ${i}`);
    const provider = new FakeEmbeddingProvider();
    expect(await sync(provider, { max: 3, batchSize: 2 })).toMatchObject({ upToDate: 0, embedded: 3, pending: 4 });
    expect(provider.calls.map((c) => c.texts.length)).toEqual([2, 1]);
    expect(await sync(new FakeEmbeddingProvider(), { max: 3 })).toMatchObject({ upToDate: 3, embedded: 3, pending: 1 });
    expect(await sync(new FakeEmbeddingProvider(), { max: 3 })).toMatchObject({ upToDate: 6, embedded: 1, pending: 0 });
    expect(await rows()).toHaveLength(7);
  });

  it("falha do provedor não lança, não grava lixo e devolve o código; os lotes já gravados ficam", async () => {
    for (let i = 0; i < 5; i += 1) await ticket(`Ticket ${i}`);
    const failing = new FakeEmbeddingProvider();
    failing.fail = "rate_limited";
    const result = await sync(failing);
    expect(result).toMatchObject({ upToDate: 0, embedded: 0, pending: 5, failure: "rate_limited" });
    expect(await rows()).toHaveLength(0);
    const half = new FakeEmbeddingProvider();
    half.failCall = 2;
    expect(await sync(half, { batchSize: 2 })).toMatchObject({ embedded: 2, pending: 3, failure: "server_error" });
    expect(await rows()).toHaveLength(2);
  });

  it("vetor de tamanho errado ou não finito é descartado como malformado, sem gravar", async () => {
    await ticket("A");
    const bad = new FakeEmbeddingProvider();
    bad.embed = () => Promise.resolve([[1, 2, 3]]);
    expect(await sync(bad)).toMatchObject({ embedded: 0, pending: 1, failure: "malformed" });
    const nan = new FakeEmbeddingProvider();
    nan.embed = () => Promise.resolve([Array.from({ length: EMBEDDING_DIMENSIONS }, () => Number.NaN)]);
    expect(await sync(nan)).toMatchObject({ embedded: 0, failure: "malformed" });
    expect(await rows()).toHaveLength(0);
  });

  it("o prazo da chamada vale: provedor lento vira timeout, sem lançar", async () => {
    expect(EMBEDDING_SYNC_DEADLINE_MS).toBe(4000);
    await ticket("A");
    const slow = new FakeEmbeddingProvider();
    slow.delayMs = 2000;
    const result = await sync(slow, { deadlineMs: 30 });
    expect(result).toMatchObject({ embedded: 0, pending: 1, failure: "timeout" });
    expect(result.ms).toBeLessThan(1000);
  });

  describe("lote que falha", () => {
    class Poison extends FakeEmbeddingProvider {
      constructor(private readonly code: "bad_request" | "timeout" | "unauthorized" | "rate_limited" | "server_error" | "network") {
        super();
      }
      override async embed(texts: readonly string[], kind: EmbeddingKind, options?: { signal?: AbortSignal }): Promise<number[][]> {
        if (texts.some((text) => text.includes("VENENO"))) {
          this.calls.push({ texts: [...texts], kind });
          throw new EmbeddingError(this.code);
        }
        return super.embed(texts, kind, options);
      }
    }
    const seedFive = async () => {
      for (const title of ["Um", "Dois", "VENENO três", "Quatro", "Cinco"]) await ticket(title);
    };

    it.each(["bad_request", "timeout"] as const)("%s: divide o lote ao meio, pula o texto sozinho que falha e segue com os seguintes", async (code) => {
      await seedFive();
      const provider = new Poison(code);
      const result = await sync(provider, { batchSize: 5 });
      expect(result).toMatchObject({ upToDate: 0, embedded: 4, pending: 1, failure: code });
      expect((await rows()).length).toBe(4);
      const sent = provider.calls.map((call) => call.texts.length);
      expect(sent[0]).toBe(5);
      expect(sent.length).toBeGreaterThan(2);
      // A segunda chamada não repete o que já está em dia: só o texto que falha é reenviado.
      const again = new Poison(code);
      expect(await sync(again)).toMatchObject({ upToDate: 4, embedded: 0, pending: 1, failure: code });
      expect(again.calls.flatMap((c) => c.texts)).toEqual(["VENENO três"]);
    });

    it("um texto que falha não consome o resto do teto: os demais são postos em dia na mesma chamada", async () => {
      await seedFive();
      const result = await sync(new Poison("bad_request"), { batchSize: 2, max: 5 });
      expect(result).toMatchObject({ embedded: 4, pending: 1, failure: "bad_request" });
    });

    it.each(["unauthorized", "rate_limited", "server_error", "network"] as const)("%s: para na hora, sem dividir nem insistir", async (code) => {
      await seedFive();
      const provider = new Poison(code);
      const result = await sync(provider, { batchSize: 5 });
      expect(result).toMatchObject({ embedded: 0, pending: 5, failure: code });
      expect(provider.calls).toHaveLength(1);
    });

    it("erro do provedor que não é EmbeddingError ou vetor que não é lista vira malformed, não storage", async () => {
      await ticket("A");
      const throwing = new FakeEmbeddingProvider();
      throwing.embed = () => Promise.reject(new TypeError("estranho"));
      expect(await sync(throwing)).toMatchObject({ embedded: 0, pending: 1, failure: "malformed" });
      const notList = new FakeEmbeddingProvider();
      notList.embed = () => Promise.resolve([null as unknown as number[]]);
      expect(await sync(notList)).toMatchObject({ failure: "malformed" });
      const notArray = new FakeEmbeddingProvider();
      notArray.embed = () => Promise.resolve("texto" as unknown as number[][]);
      expect(await sync(notArray)).toMatchObject({ failure: "malformed" });
    });

    it("falha de gravação continua sendo storage", async () => {
      await ticket("A");
      let calls = 0;
      const flaky: EmbeddingStore = { run: (fn) => (++calls === 1 ? store.run(fn) : Promise.reject(new Error("banco caiu"))) };
      const result = await syncEmbeddings(flaky, { projectId: world.projects.priv, tickets: await live(), provider: new FakeEmbeddingProvider() });
      expect(result).toMatchObject({ embedded: 0, pending: 1, failure: "storage" });
    });
  });

  it("o modelo gravado vem do provedor: linha do falso conta como desatualizada para o de verdade", async () => {
    await ticket("A");
    await sync(new FakeEmbeddingProvider());
    class Real extends FakeEmbeddingProvider {
      override readonly model = "voyage-4-lite";
    }
    const real = new Real();
    expect(await store.run((tx) => embeddingStatus(tx, world.projects.priv, "voyage-4-lite"))).toEqual({ live: 1, upToDate: 0, outdated: 1, missing: 0 });
    expect(await sync(real)).toMatchObject({ upToDate: 0, embedded: 1 });
    expect((await rows())[0]?.model).toBe("voyage-4-lite");
  });

  it("falha do banco na leitura vira código storage, sem lançar nem chamar o provedor", async () => {
    await ticket("A");
    const provider = new FakeEmbeddingProvider();
    const broken: EmbeddingStore = { run: () => Promise.reject(new Error("banco fora")) };
    const result = await syncEmbeddings(broken, { projectId: world.projects.priv, tickets: await live(), provider });
    expect(result).toMatchObject({ pending: 1, failure: "storage" });
    expect(provider.calls).toHaveLength(0);
  });

  it("a chamada ao provedor acontece fora de transação do banco", async () => {
    await ticket("A");
    await ticket("B");
    const seen: number[] = [];
    class Probe extends FakeEmbeddingProvider {
      override async embed(texts: readonly string[], kind: EmbeddingKind, options?: { signal?: AbortSignal }): Promise<number[][]> {
        seen.push(await openApiTransactions(pool));
        return super.embed(texts, kind, options);
      }
    }
    await sync(new Probe(), { batchSize: 1 });
    expect(seen).toEqual([0, 0]);
  });

  it("o ticket apagado entre a leitura e a gravação não derruba o lote", async () => {
    const a = await ticket("A");
    await ticket("B");
    const provider = new FakeEmbeddingProvider();
    const original = provider.embed.bind(provider);
    provider.embed = async (texts, kind, options) => {
      await pool.query("delete from tickets where id = $1", [a]);
      return original(texts, kind, options);
    };
    // Só o que foi gravado de fato conta: o ticket apagado no meio não entra em `embedded` nem fica pendente.
    expect(await sync(provider)).toMatchObject({ embedded: 1, pending: 0 });
    expect(await rows()).toHaveLength(1);
  });

  it("o erro do provedor não carrega texto de ticket", async () => {
    await ticket("Texto muito confidencial");
    const provider = new FakeEmbeddingProvider();
    provider.embed = () => Promise.reject(new EmbeddingError("network"));
    const result = await sync(provider);
    expect(JSON.stringify(result)).not.toContain("confidencial");
  });
});

describe("embeddingStatus", () => {
  it("conta em dia, desatualizados e faltando, só números", async () => {
    const a = await ticket("A");
    await ticket("B");
    await ticket("C");
    await sync(new FakeEmbeddingProvider(), { max: 2 });
    await pool.query("update tickets set title = 'A novo' where id = $1", [a]);
    const status = await store.run((tx) => embeddingStatus(tx, world.projects.priv, "fake"));
    expect(status).toEqual({ live: 3, upToDate: 1, outdated: 1, missing: 1 });
  });
});

describe("nearestTickets", () => {
  const near = (text: string, k = 10, project = world.projects.priv, orgId = ORG) => storeOf(orgId).run((tx) => nearestTickets(tx, { orgId, projectId: project, model: "fake", vector: fakeVector(text), k }));

  it("devolve em ordem crescente de distância do cosseno, exata, e respeita k", async () => {
    const jira = await ticket("Sincronizar tickets com Jira e Linear", { description: "Receber só o diff" });
    const git = await ticket("Importar issues do GitHub");
    const css = await ticket("Cor do botão de login", { description: "Azul escuro" });
    await sync(new FakeEmbeddingProvider());
    const result = await near("sincronizar com Jira e Linear recebendo só o diff");
    expect(result.map((r) => r.ticketId)).toEqual([jira, expect.any(String), expect.any(String)]);
    expect(result[0]?.ticketId).toBe(jira);
    expect(result.map((r) => r.distance)).toEqual([...result.map((r) => r.distance)].sort((x, y) => x - y));
    expect(result[0]?.distance).toBeLessThan(result[1]?.distance as number);
    expect(new Set(result.map((r) => r.ticketId))).toEqual(new Set([jira, git, css]));
    expect(await near("sincronizar com Jira", 1)).toHaveLength(1);
    expect(await near("qualquer coisa", 0)).toEqual([]);
  });

  it("filtra pelo projeto", async () => {
    const mine = await ticket("Sincronizar com Jira");
    const other = await ticket("Sincronizar com Jira", { project: world.projects.org });
    await sync(new FakeEmbeddingProvider());
    await syncEmbeddings(store, { projectId: world.projects.org, tickets: await live(world.projects.org), provider: new FakeEmbeddingProvider() });
    expect((await near("Sincronizar com Jira")).map((r) => r.ticketId)).toEqual([mine]);
    expect((await near("Sincronizar com Jira", 5, world.projects.org)).map((r) => r.ticketId)).toEqual([other]);
  });

  it("ticket cancelado (ou dentro de cancelado) e ideia (com o que está dentro) ficam de fora mesmo com vetor guardado", async () => {
    const ok = await ticket("Sincronizar com Jira");
    const cancelled = await ticket("Sincronizar com Jira cancelado");
    const cancelledChild = await ticket("Sincronizar com Jira filho do cancelado", { parent: cancelled });
    const idea = await ticket("Sincronizar com Jira ideia");
    const ideaChild = await ticket("Sincronizar com Jira filho da ideia", { parent: idea });
    // Todos nascem vivos e ganham vetor; só depois o cancelamento e a ideia entram, sem apagar nenhum vetor.
    await sync(new FakeEmbeddingProvider());
    expect(await rows()).toHaveLength(5);
    expect((await near("Sincronizar com Jira")).map((r) => r.ticketId).sort()).toEqual([ok, cancelled, cancelledChild, idea, ideaChild].sort());
    await pool.query("update tickets set status = 'cancelled' where id = $1", [cancelled]);
    expect((await near("Sincronizar com Jira")).map((r) => r.ticketId).sort()).toEqual([ok, idea, ideaChild].sort());
    await pool.query("update tickets set idea_stage = 'new' where id = $1", [idea]);
    expect((await near("Sincronizar com Jira")).map((r) => r.ticketId)).toEqual([ok]);
    expect(await rows()).toHaveLength(5);
  });

  it("só linhas do modelo e da dimensão atuais", async () => {
    const a = await ticket("Sincronizar com Jira");
    const b = await ticket("Sincronizar com Jira de novo");
    await sync(new FakeEmbeddingProvider());
    await pool.query("update ticket_embeddings set model = 'outro' where ticket_id = $1", [a]);
    await pool.query("update ticket_embeddings set dimensions = 256 where ticket_id = $1", [b]);
    expect(await near("Sincronizar com Jira")).toEqual([]);
  });

  it("outra organização não aparece, nem pelo id do projeto", async () => {
    await ticket("Sincronizar com Jira");
    await ticket("Sincronizar com Jira", { org: OTHER_ORG, project: world.other.project });
    await sync(new FakeEmbeddingProvider());
    await syncEmbeddings(storeOf(OTHER_ORG), { projectId: world.other.project, tickets: await live(world.other.project, OTHER_ORG), provider: new FakeEmbeddingProvider() });
    expect(await rows()).toHaveLength(2);
    expect(await near("Sincronizar com Jira", 10, world.other.project, ORG)).toEqual([]);
    expect(await near("Sincronizar com Jira", 10, world.projects.priv, OTHER_ORG)).toEqual([]);
    expect(await near("Sincronizar com Jira", 10, world.other.project, OTHER_ORG)).toHaveLength(1);
  });

  it("recusa vetor de consulta de tamanho errado", async () => {
    await expect(store.run((tx) => nearestTickets(tx, { orgId: ORG, projectId: world.projects.priv, model: "fake", vector: [1, 2, 3], k: 1 }))).rejects.toThrow(RangeError);
  });
});

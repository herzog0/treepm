import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tenantTransaction } from "@treepm/db";
import { structureLock } from "../src/tickets/structure-lock.js";
import { structureQueue, structureQueueKeys } from "../src/tickets/structure-queue.js";
import { useHarness } from "./harness.js";
import { OTHER_ORG, as } from "./world.js";

/**
 * ADR 0045, adendo 1, contra o banco de verdade: quem vai mudar a estrutura espera NA MEMÓRIA, sem conexão; só 2 por projeto abrem
 * transação. O teste segura a trava consultiva do projeto com um cliente do dono (como em `structure-lock.test.ts`) e conta quantas
 * sessões do app esperam por ela: sem a fila seriam todas as requisições; com a fila, 2.
 */
const h = useHarness();
const P = () => h.world().projects.priv;
const O = () => h.world().projects.org;
const make = async (project: string, body: Record<string, unknown> = {}): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${project}/tickets`, as("admin"), { title: "Nó", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const limit = Date.now() + 10_000;
  while (Date.now() < limit) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Esperado, e não aconteceu: ${what}`);
}
/** Sessões esperando uma trava consultiva (a de estrutura) agora. */
const advisoryWaiting = async (): Promise<number> =>
  Number((await h.pool.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted")).rows[0].n);

async function holdStructureLock(projectId: string) {
  const client = await h.pool.connect();
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-structure:${projectId}`]);
  return {
    release: async () => {
      await client.query("commit");
      client.release();
    },
  };
}
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a fila na memória antes da transação", () => {
  const saved = { queue: { ...structureQueue }, lock: structureLock.timeoutMs, maxWait: tenantTransaction.maxWaitMs };
  afterEach(() => {
    Object.assign(structureQueue, saved.queue);
    structureLock.timeoutMs = saved.lock;
    tenantTransaction.maxWaitMs = saved.maxWait;
  });

  it("com a trava ocupada, N criações com pai no mesmo projeto deixam no máximo 2 transações esperando; as outras esperam sem conexão", async () => {
    const parent = await make(P());
    const hold = await holdStructureLock(P());
    const creates = Array.from({ length: 6 }, (_, i) => h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: `Filho ${i}`, parentId: parent }).then((r) => r));
    await until(async () => (await advisoryWaiting()) >= 2, "duas transações esperando a trava");
    await settle();
    expect(await advisoryWaiting()).toBe(2); // sem a fila seriam 6 (limitado só pelo pool)
    // outro projeto e edição sem estrutura no mesmo projeto não esperam ninguém
    const other = await make(O());
    expect((await h.call("PATCH", `/api/tickets/${other}`, as("admin"), { title: "Outro projeto" })).status).toBe(200);
    expect((await h.call("PATCH", `/api/tickets/${parent}`, as("admin"), { title: "Sem estrutura" })).status).toBe(200);
    expect((await h.call("POST", `/api/projects/${O()}/tickets`, as("admin"), { title: "Raiz em outro projeto" })).status).toBe(201);
    await hold.release();
    const results = await Promise.all(creates);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(structureQueueKeys()).toBe(0);
  });

  it("quem passa de 3 s na fila recebe 409 structure_busy (aqui 300 ms) enquanto a trava do banco segue valendo para os de dentro", async () => {
    structureQueue.waitMs = 300;
    structureLock.timeoutMs = 10_000; // a trava do banco não é quem estoura neste teste
    const parent = await make(P());
    const hold = await holdStructureLock(P());
    const body = (i: number) => ({ title: `Filho ${i}`, parentId: parent });
    const inside = [0, 1].map((i) => h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), body(i)).then((r) => r));
    await until(async () => (await advisoryWaiting()) >= 2, "dois dentro, esperando a trava");
    const started = Date.now();
    const late = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), body(2));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("structure_busy");
    expect(Date.now() - started).toBeLessThan(2500);
    await hold.release();
    expect((await Promise.all(inside)).map((r) => r.status)).toEqual([201, 201]);
    expect(structureQueueKeys()).toBe(0);
  });

  it("a mudança de pai (organização como chave) passa pela fila; a que só troca título ou situação não", async () => {
    const [a, b, c, d] = [await make(P()), await make(P()), await make(P()), await make(P())];
    const hold = await holdStructureLock(P());
    const moves = [a, b, c].map((id) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), { parentId: d }).then((r) => r));
    await until(async () => (await advisoryWaiting()) >= 2, "duas mudanças de pai esperando a trava");
    await settle();
    expect(await advisoryWaiting()).toBe(2);
    expect((await h.call("PATCH", `/api/tickets/${d}`, as("admin"), { title: "Título" })).status).toBe(200);
    expect((await h.call("PATCH", `/api/tickets/${d}`, as("admin"), { status: "in_progress" })).status).toBe(200);
    await hold.release();
    expect((await Promise.all(moves)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(structureQueueKeys()).toBe(0);
  });

  it("remoção, importação e conversa pegam vaga na fila (a trava ocupada deixa só 2 de cada chave dentro)", async () => {
    const leaves = [await make(P()), await make(P()), await make(P())];
    const hold = await holdStructureLock(P());
    const removals = leaves.map((id) => h.call("DELETE", `/api/tickets/${id}`, as("admin")).then((r) => r));
    await until(async () => (await advisoryWaiting()) >= 2, "duas remoções esperando a trava");
    await settle();
    expect(await advisoryWaiting()).toBe(2);
    await hold.release();
    expect((await Promise.all(removals)).map((r) => r.status)).toEqual([204, 204, 204]);

    const hold2 = await holdStructureLock(P());
    const imports = [0, 1, 2].map((i) => h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { items: [{ title: `Importado ${i}` }] }).then((r) => r));
    await until(async () => (await advisoryWaiting()) >= 2, "duas importações esperando a trava");
    await settle();
    expect(await advisoryWaiting()).toBe(2);
    await hold2.release();
    expect((await Promise.all(imports)).map((r) => r.status)).toEqual([201, 201, 201]);
    expect(structureQueueKeys()).toBe(0);
  });

  it("a chave é sempre o projeto: dois DELETE esperando o projeto A não prendem a mudança de pai no projeto B", async () => {
    const [a1, a2, a3] = [await make(P()), await make(P()), await make(P())];
    const [b1, b2] = [await make(O()), await make(O())];
    const hold = await holdStructureLock(P());
    const removals = [a1, a2, a3].map((id) => h.call("DELETE", `/api/tickets/${id}`, as("admin")).then((r) => r));
    await until(async () => (await advisoryWaiting()) >= 2, "duas remoções esperando a trava de A");
    await settle();
    const move = await h.call("PATCH", `/api/tickets/${b1}`, as("admin"), { parentId: b2 });
    expect(move.status, JSON.stringify(move.body)).toBe(200); // com a chave da organização, receberia 409 depois de 3 s
    await hold.release();
    expect((await Promise.all(removals)).map((r) => r.status)).toEqual([204, 204, 204]);
  });

  it("o mesmo projeto soma todos os tipos de mudança numa só fila: 2 criações com pai e 2 remoções deixam só 2 esperando a trava", async () => {
    const parent = await make(P());
    const leaves = [await make(P()), await make(P())];
    const hold = await holdStructureLock(P());
    const calls = [
      ...[0, 1].map((i) => h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: `F${i}`, parentId: parent }).then((r) => r)),
      ...leaves.map((id) => h.call("DELETE", `/api/tickets/${id}`, as("admin")).then((r) => r)),
    ];
    await until(async () => (await advisoryWaiting()) >= 2, "duas esperando a trava");
    await settle();
    expect(await advisoryWaiting()).toBe(2); // com chaves separadas seriam 4
    await hold.release();
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual([201, 201, 204, 204]);
    expect(structureQueueKeys()).toBe(0);
  });

  it("quem é de outra organização não ocupa vagas de um projeto alheio: o ticket que ela não enxerga nem entra na fila (404)", async () => {
    const victim = await make(P());
    const hold = await holdStructureLock(P());
    const started = Date.now();
    const attempts = await Promise.all([1, 2, 3].map(() => h.call("DELETE", `/api/tickets/${victim}`, as("outsider", OTHER_ORG)).then((r) => r)));
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(structureQueueKeys()).toBe(0);
    expect(await advisoryWaiting()).toBe(0);
    await hold.release();
  });

  it("cliente que desiste enquanto espera na fila não ocupa vaga e não gera erro no log", async () => {
    structureLock.timeoutMs = 10_000;
    const parent = await make(P());
    const hold = await holdStructureLock(P());
    const error = vi.spyOn(Logger.prototype, "error");
    try {
      const inside = [0, 1].map((i) => h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: `Dentro ${i}`, parentId: parent }).then((r) => r));
      await until(async () => (await advisoryWaiting()) >= 2, "dois dentro, esperando a trava");
      const quitter = h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Desistente", parentId: parent }) as unknown as Promise<unknown> & { abort(): void };
      quitter.then(() => undefined, () => undefined);
      await settle(300); // entrou na fila
      quitter.abort();
      await settle(300);
      await hold.release();
      expect((await Promise.all(inside)).map((r) => r.status)).toEqual([201, 201]);
      await settle(300);
      expect((await h.pool.query("select count(*)::int n from tickets where title = 'Desistente'")).rows[0].n).toBe(0);
      expect(structureQueueKeys()).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

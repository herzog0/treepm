import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedGroups, seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;

const open = (who: Who | "outsider" = "contributor", body: Record<string, unknown> = {}, org = "org_A") =>
  h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who, org), { message: "Quero corrigir o login", ...body });
const send = (id: string, body: Record<string, unknown> = {}, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/ticket-conversations/${id}/messages`, as(who, org), { message: "Mais um detalhe", ...body });
const lastCall = () => h.conversation().calls[h.conversation().calls.length - 1];

let tree: Tree;
afterEach(() => vi.restoreAllMocks());

describe("agrupadores do lugar da procura na conversa (ADR 0033)", () => {
  it("sem escopo: os títulos dos agrupadores da raiz, na ordem do número, sem tickets", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await open();
    expect(res.status).toBe(201);
    expect(h.conversation().calls).toHaveLength(1);
    expect(lastCall()?.groups).toEqual(["Auth", "Billing"]);
  });

  it("a ordem é a do número do ticket, não a do título nem a da criação", async () => {
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 9, 'Aaa', $2), ('org_A', $1, 3, 'Zzz', $2), ('org_A', $1, 5, 'Mmm', $2)",
      [priv(), h.world().people.manager],
    );
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) select 'org_A', $1, 20 + number, id, 'filho', $2 from tickets where project_id = $1",
      [priv(), h.world().people.manager],
    );
    await h.pool.query("update projects set next_ticket_number = 40 where id = $1", [priv()]);
    await open();
    expect(lastCall()?.groups).toEqual(["Zzz", "Mmm", "Aaa"]);
  });

  it("com escopo: só os agrupadores filhos diretos dele (ticket filho e neto ficam de fora)", async () => {
    tree = await seedTree(h.pool, h.world());
    await open("contributor", { scopeId: tree.auth });
    expect(lastCall()?.groups).toEqual(["SSO"]);
    await open("contributor", { scopeId: tree.sso });
    expect(lastCall()?.groups).toEqual([]);
    await open("contributor", { scopeId: tree.billing });
    expect(lastCall()?.groups).toEqual([]);
  });

  it("projeto sem agrupador: lista vazia", async () => {
    await open();
    expect(lastCall()?.groups).toEqual([]);
  });

  it("scopeId nulo vale como sem escopo", async () => {
    tree = await seedTree(h.pool, h.world());
    await open("contributor", { scopeId: null });
    expect(lastCall()?.groups).toEqual(["Auth", "Billing"]);
  });

  it("no máximo 30 títulos, os 30 primeiros pelo número", async () => {
    await seedGroups(
      h.pool,
      h.world(),
      Array.from({ length: 35 }, (_, index) => ({ title: `G${String(index + 1).padStart(2, "0")}` })),
    );
    await open();
    const groups = lastCall()?.groups ?? [];
    expect(groups).toHaveLength(30);
    expect(groups[0]).toBe("G01");
    expect(groups[29]).toBe("G30");
  });

  it("só títulos: id, número e descrição do agrupador nunca chegam ao provedor", async () => {
    const [group] = await seedGroups(h.pool, h.world(), [{ title: "Entrega", description: "SENTINELA-descricao-7d1e" }]);
    await open();
    const sent = JSON.stringify(h.conversation().calls);
    expect(lastCall()?.groups).toEqual(["Entrega"]);
    expect(sent).not.toContain("SENTINELA-descricao-7d1e");
    expect(sent).not.toContain(group);
  });

  it("as mensagens seguintes também levam o bloco, e o escopo vale só para o turno em que veio", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = (await open("contributor", { scopeId: tree.auth })).body.id as string;
    expect(lastCall()?.groups).toEqual(["SSO"]);
    await send(id);
    expect(lastCall()?.groups).toEqual(["Auth", "Billing"]); // sem scopeId na mensagem: raiz
    await send(id, { scopeId: tree.auth });
    expect(lastCall()?.groups).toEqual(["SSO"]);
    await send(id, { scopeId: null });
    expect(lastCall()?.groups).toEqual(["Auth", "Billing"]);
    expect(await rows("select column_name from information_schema.columns where table_name = 'ticket_conversations' and column_name like '%scope%'")).toEqual([]);
  });

  it("a procura continua dependendo só do escopo pedido nela: o da conversa não fica guardado", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = (await open("contributor", { scopeId: tree.auth })).body.id as string;
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"));
    expect(h.judge().calls[0]?.scope).toBeUndefined();
  });

  it("ready falso do modelo é guardado como veio, e a procura não é bloqueada por ele", async () => {
    tree = await seedTree(h.pool, h.world());
    h.conversation().reply = () => ({ message: "Qual a fase?", draft: { title: "T", description: "d" }, ready: false, model: "claude-opus-5-5" });
    const created = await open();
    expect(created.body.ready).toBe(false);
    expect((await rows("select ready from ticket_conversations"))[0].ready).toBe(false);
    const res = await h.call("POST", `/api/ticket-conversations/${created.body.id}/placement`, as("contributor"));
    expect(res.status).toBe(201);
  });

  it("os títulos são lidos antes da chamada ao provedor e nenhuma transação fica aberta durante ela", async () => {
    tree = await seedTree(h.pool, h.world());
    const idle: number[] = [];
    h.conversation().onCall = async () => {
      idle.push(
        (await rows("select count(*)::int as n from pg_stat_activity where usename = 'treepm_app' and state like 'idle in transaction%'"))[0].n as number,
      );
    };
    const id = (await open("contributor", { scopeId: tree.auth })).body.id as string;
    await send(id, { scopeId: tree.auth });
    expect(idle).toEqual([0, 0]);
  });
});

describe("scopeId na conversa: os mesmos erros da procura", () => {
  const groupIn = async (projectId: string, orgId: string, number: number, title: string) =>
    (await rows(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,$4,(select id from people where org_id = $1 limit 1)) returning id",
      [orgId, projectId, number, title],
    ))[0].id as string;

  const cases: [string, () => Promise<string>, number, string | undefined][] = [
    ["escopo inexistente: 404", async () => UNKNOWN_ID, 404, undefined],
    ["escopo de outro projeto da mesma organização: 404", () => groupIn(h.world().projects.org, "org_A", 1, "De outro projeto"), 404, undefined],
    ["escopo de outra organização: 404", () => groupIn(h.world().other.project, "org_B", 1, "De outra organização"), 404, undefined],
  ];

  describe.each(cases)("%s", (_name, scope, status, code) => {
    it("ao abrir a conversa: sem chamar o provedor e sem gravar nada", async () => {
      tree = await seedTree(h.pool, h.world());
      const res = await open("contributor", { scopeId: await scope() });
      expect(res.status).toBe(status);
      expect(errorOf(res)).toBe(code ?? errorOf(res));
      expect(h.conversation().calls).toHaveLength(0);
      expect(await count("ticket_conversations")).toBe(0);
    });

    it("em mensagem nova: sem chamar o provedor e sem acrescentar mensagem", async () => {
      tree = await seedTree(h.pool, h.world());
      const id = (await open()).body.id as string;
      h.conversation().calls.length = 0;
      const res = await send(id, { scopeId: await scope() });
      expect(res.status).toBe(status);
      expect(errorOf(res)).toBe(code ?? errorOf(res));
      expect(h.conversation().calls).toHaveLength(0);
      expect(await count("ticket_conversation_messages")).toBe(2);
    });
  });

  it("ticket sem filhos como escopo: aceito (ADR 0034), sem o erro scope_not_group, e a conversa segue", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await open("contributor", { scopeId: tree.login });
    expect(res.status).toBe(201);
    expect(lastCall()?.groups).toEqual([]);
  });

  it("scopeId que não é um id: 400, como o corpo inválido de sempre", async () => {
    expect((await open("contributor", { scopeId: "nao-e-id" })).status).toBe(400);
    expect((await open("contributor", { scopeId: 7 })).status).toBe(400);
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("o escopo não troca as regras de acesso: leitor continua sem abrir conversa (403) e quem não vê o projeto, 404", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await open("reader", { scopeId: tree.auth })).status).toBe(403);
    expect((await open("outsider", { scopeId: tree.auth }, "org_B")).status).toBe(404);
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("em mensagem: a conversa alheia continua 404 mesmo com escopo válido", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = (await open()).body.id as string;
    expect((await send(id, { scopeId: tree.auth }, "manager")).status).toBe(404);
    expect((await send(id, { scopeId: tree.auth }, "outsider", "org_B")).status).toBe(404);
  });
});

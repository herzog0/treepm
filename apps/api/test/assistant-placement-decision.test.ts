import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0052, item 5: a decisão da procura fica guardada, só com identificadores e números.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const open = async () =>
  (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
const placement = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"));
const decisionOf = (id: string, who: "contributor" | "outsider" = "contributor", org = "org_A") =>
  h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as(who, org));
let tree: Tree;
afterEach(() => vi.restoreAllMocks());

describe("a decisão da procura guardada", () => {
  it("guarda por nível a probabilidade de caber e a de cada candidato, o caminho e por que parou", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    expect((await placement(id)).status).toBe(201);
    const [row] = await rows("select * from placement_decisions where conversation_id = $1", [id]);
    expect(row.chosen_path).toEqual([tree.auth, tree.sso]);
    expect(row.stop_reason).toBe("no_candidates");
    // Raiz, Auth e Billing (acima de 0,7 seguem os dois) e SSO.
    expect(row.levels).toHaveLength(4);
    expect(row.levels[0]).toMatchObject({ level: 1, parentId: null, parentNumber: null, result: "descended", belongs: 0.95 });
    expect(row.levels[0].candidates).toEqual([
      { ticketId: tree.auth, number: 1, probability: 0.9 },
      { ticketId: tree.billing, number: 5, probability: 0.1 },
    ]);
    expect(row.levels.find((l: { parentId: string }) => l.parentId === tree.auth)).toMatchObject({ level: 2, parentNumber: 1, result: "descended" });
  });

  it("não guarda texto nenhum: nem título de ticket, nem o rascunho, nem a conversa", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await placement(id);
    const [row] = await rows("select row_to_json(d)::text as everything from placement_decisions d where conversation_id = $1", [id]);
    for (const text of ["Auth", "SSO", "Billing", "Login", "Solto", "Invoices", "SAML", "Rascunho", "corrigir", "Quero", "entrar no sistema"]) {
      expect(row.everything, text).not.toContain(text);
    }
  });

  it("uma procura nova na mesma conversa substitui a anterior", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await placement(id);
    await placement(id);
    expect(await rows("select 1 from placement_decisions where conversation_id = $1", [id])).toHaveLength(1);
  });

  it("a rota devolve a decisão à autora; sem procura, null; outra pessoa, 404", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    expect((await decisionOf(id)).body).toEqual({ decision: null });
    await placement(id);
    const res = await decisionOf(id);
    expect(res.status).toBe(200);
    expect(res.body.decision.chosenPath).toEqual([tree.auth, tree.sso]);
    expect(res.body.decision.levels[0].candidates[0]).toEqual({ ticketId: tree.auth, number: 1, probability: 0.9 });
    expect((await decisionOf(id, "outsider")).status).toBe(404);
    expect((await decisionOf(id, "contributor", "org_B")).status).toBe(404);
  });

  it("descartar a conversa apaga a decisão; criar o ticket a passa para ele e ela sobrevive à conversa", async () => {
    tree = await seedTree(h.pool, h.world());
    const dropped = await open();
    await placement(dropped);
    expect((await h.call("DELETE", `/api/ticket-conversations/${dropped}`, as("contributor"))).status).toBe(204);
    expect(await rows("select 1 from placement_decisions")).toHaveLength(0);

    const kept = await open();
    await h.call("PUT", `/api/ticket-conversations/${kept}/draft`, as("contributor"), { title: "Corrigir o login", description: "Botão parado" });
    await placement(kept);
    const created = await h.call("POST", `/api/ticket-conversations/${kept}/ticket`, as("contributor"), { parentId: tree.sso });
    expect(created.status).toBe(201);
    const [row] = await rows("select conversation_id, ticket_id from placement_decisions");
    expect(row).toEqual({ conversation_id: null, ticket_id: created.body.ticket.id });
    await h.call("DELETE", `/api/ticket-conversations/${kept}`, as("contributor"));
    expect(await rows("select 1 from placement_decisions")).toHaveLength(1);
  });

  it("a procura não depende de a decisão ser gravada: falha ao gravar não derruba a resposta", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await h.pool.query("alter table placement_decisions add constraint boom check (false) not valid");
    try {
      expect((await placement(id)).status).toBe(201);
    } finally {
      await h.pool.query("alter table placement_decisions drop constraint boom");
    }
    expect(await rows("select 1 from placement_decisions")).toHaveLength(0);
  });

  it("criar o ticket não depende da tabela da decisão: sem ela o ticket nasce e a resposta é a de sempre", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await h.call("PUT", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Corrigir o login", description: "Botão parado" });
    await placement(id);
    await h.pool.query("alter table placement_decisions rename to placement_decisions_off");
    try {
      const created = await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), { parentId: tree.sso });
      expect(created.status).toBe(201);
      expect(created.body.conversation.status).toBe("ticket_created");
      expect(await rows("select 1 from tickets where id = $1", [created.body.ticket.id])).toHaveLength(1);
      // Sem a tabela, a rota de leitura diz "sem decisão" em vez de 500.
      const other = await open();
      const read = await decisionOf(other);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ decision: null });
    } finally {
      await h.pool.query("alter table placement_decisions_off rename to placement_decisions");
    }
  });

  it("o aviso de decisão não guardada traz o código do erro e nenhum texto", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    const warn = vi.spyOn(Logger.prototype, "warn");
    await h.pool.query("alter table placement_decisions rename to placement_decisions_off");
    try {
      expect((await placement(id)).status).toBe(201);
    } finally {
      await h.pool.query("alter table placement_decisions_off rename to placement_decisions");
    }
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("decisão da procura não guardada"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/codigo=\w+/);
    expect(lines[0]).not.toMatch(/relation|placement_decisions/);
  });
});

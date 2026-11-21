import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { seedLeaves, seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const WHO_EDIT: Who[] = ["admin", "manager", "contributor"];

const read = (id: string, who: Who | "outsider" = "contributor", org = "org_A") => h.call("GET", `/api/tickets/${id}/summary`, as(who, org));
const write = (id: string, body: unknown, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("PUT", `/api/tickets/${id}/summary`, as(who, org), body);
const regenerate = (id: string, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/tickets/${id}/summary/regenerate`, as(who, org));
const stored = async (ticketId: string) =>
  (await rows("select summary, source, model, edited_by_person_id, content_mark from branch_summaries where ticket_id = $1", [ticketId]))[0] as
    | { summary: string; source: string; model: string | null; edited_by_person_id: string | null; content_mark: string }
    | undefined;
const events = async () => rows("select kind, subject_type, subject_id, actor_person_id, payload from activity_events where kind = 'ticket.summary_updated' order by occurred_at, id");
const openTransactions = async () =>
  (await rows("select count(*)::int as n from pg_stat_activity where usename = 'treepm_app' and state like 'idle in transaction%'"))[0].n as number;
const aiText = (ticketId: string, text = "Texto da IA") =>
  h.pool.query(
    "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model) values ('org_A', $1, $2, $3, 'marca-antiga', 'assistant', 'claude-opus-5-5')",
    [priv(), ticketId, text],
  );
const personText = (ticketId: string, text = "Texto da pessoa") =>
  h.pool.query(
    "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model, edited_by_person_id) values ('org_A', $1, $2, $3, '', 'person', null, $4)",
    [priv(), ticketId, text, h.world().people.manager],
  );

let tree: Tree;
afterEach(() => vi.restoreAllMocks());

describe("GET /tickets/:id/summary", () => {
  it("agrupador sem texto guardado: summary nulo", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await read(tree.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: null });
  });

  it("texto da IA: texto, origem e a data, e nada mais (sem modelo, marca nem autor)", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    const res = await read(tree.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: { text: "Texto da IA", source: "assistant", updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) } });
    const at = (await rows("select updated_at from branch_summaries where ticket_id = $1", [tree.auth]))[0].updated_at as Date;
    expect(res.body.summary.updatedAt).toBe(at.toISOString());
  });

  it("texto guardado de um ticket que não tem (mais) filhos continua sendo lido", async () => {
    const [empty] = await seedLeaves(h.pool, h.world(), [{ title: "Acesso" }]);
    await personText(empty!, "Tudo sobre acesso");
    const res = await read(empty!);
    expect(res.body.summary).toMatchObject({ text: "Tudo sobre acesso", source: "person" });
  });

  it("quem vê o projeto lê, inclusive o leitor", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    for (const who of ["admin", "manager", "contributor", "reader"] as Who[]) {
      const res = await read(tree.auth, who);
      expect(res.status, who).toBe(200);
      expect(res.body.summary.text).toBe("Texto da IA");
    }
  });

  it("quem não vê o projeto, outra organização e ticket inexistente: o mesmo 404", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    expect((await read(tree.auth, "plain")).status).toBe(404);
    expect((await read(tree.auth, "outsider", "org_B")).status).toBe(404);
    expect((await read(UNKNOWN_ID)).status).toBe(404);
    expect((await read("nao-e-id")).status).toBe(400);
  });

  it("ticket sem filhos: 200 com summary nulo (ADR 0034)", async () => {
    tree = await seedTree(h.pool, h.world());
    for (const ticket of [tree.login, tree.loose]) {
      const res = await read(ticket);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ summary: null });
    }
  });

  it("lê também com o projeto arquivado", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await read(tree.auth)).status).toBe(200);
  });
});

describe("PUT /tickets/:id/summary", () => {
  it("grava com origem 'person', modelo nulo e quem editou; responde no formato do GET", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await write(tree.auth, { text: "  Tudo o que trata de entrar no sistema.  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: { text: "Tudo o que trata de entrar no sistema.", source: "person", updatedAt: expect.any(String) } });
    expect(await stored(tree.auth)).toEqual({
      summary: "Tudo o que trata de entrar no sistema.",
      source: "person",
      model: null,
      edited_by_person_id: h.world().people.contributor,
      content_mark: "",
    });
    expect((await read(tree.auth)).body).toEqual(res.body);
  });

  it("substitui o texto da IA (e depois o da pessoa), sem criar outra linha", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    await write(tree.auth, { text: "Primeiro" }, "manager");
    await write(tree.auth, { text: "Segundo" }, "contributor");
    expect(await rows("select count(*)::int as n from branch_summaries where ticket_id = $1", [tree.auth])).toEqual([{ n: 1 }]);
    expect(await stored(tree.auth)).toMatchObject({ summary: "Segundo", source: "person", model: null, edited_by_person_id: h.world().people.contributor });
  });

  it("ticket sem filhos não aceita texto: 409 ticket_has_no_items", async () => {
    const [empty] = await seedLeaves(h.pool, h.world(), [{ title: "Acesso" }]);
    const res = await write(empty!, { text: "Texto antes dos itens" });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("ticket_has_no_items");
    expect(await stored(empty!)).toBeUndefined();
  });

  it("limites: de 1 a 1000 caracteres depois de aparar", async () => {
    tree = await seedTree(h.pool, h.world());
    for (const text of ["", "   ", "\n\t"]) expect((await write(tree.auth, { text })).status, JSON.stringify(text)).toBe(400);
    expect((await write(tree.auth, { text: "x".repeat(1001) })).status).toBe(400);
    expect((await write(tree.auth, { text: ` ${"x".repeat(1001)} ` })).status).toBe(400);
    expect(await stored(tree.auth)).toBeUndefined();
    expect((await write(tree.auth, { text: "x" })).status).toBe(200);
    expect((await write(tree.auth, { text: "x".repeat(1000) })).status).toBe(200);
    expect((await write(tree.auth, { text: ` ${"y".repeat(1000)} ` })).status).toBe(200);
    expect((await stored(tree.auth))?.summary).toBe("y".repeat(1000));
  });

  it("corpo inválido: 400 (sem texto, texto que não é string, campo desconhecido, origem forjada)", async () => {
    tree = await seedTree(h.pool, h.world());
    for (const body of [{}, { text: 7 }, { text: null }, { text: "ok", source: "assistant" }, { text: "ok", model: "x" }, "texto"]) {
      expect((await write(tree.auth, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await stored(tree.auth)).toBeUndefined();
  });

  it.each(WHO_EDIT)("%s pode gravar", async (who) => {
    tree = await seedTree(h.pool, h.world());
    expect((await write(tree.auth, { text: "ok" }, who)).status).toBe(200);
    expect((await stored(tree.auth))?.edited_by_person_id).toBe(h.world().people[who]);
  });

  it("o leitor vê o projeto mas não edita: 403, e nada muda", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    expect((await write(tree.auth, { text: "novo" }, "reader")).status).toBe(403);
    expect(await stored(tree.auth)).toMatchObject({ summary: "Texto da IA", source: "assistant" });
    expect(await events()).toEqual([]);
  });

  it("quem não vê o projeto, outra organização e ticket inexistente: 404", async () => {
    tree = await seedTree(h.pool, h.world());
    for (const who of ["plain", "teamAdmin"] as Who[]) expect((await write(tree.auth, { text: "novo" }, who)).status, who).toBe(404);
    expect((await write(tree.auth, { text: "novo" }, "outsider", "org_B")).status).toBe(404);
    expect((await write(UNKNOWN_ID, { text: "novo" })).status).toBe(404);
    expect(await stored(tree.auth)).toBeUndefined();
  });

  it("projeto arquivado: a recusa de sempre (409 project_archived) e o texto anterior fica", async () => {
    tree = await seedTree(h.pool, h.world());
    await aiText(tree.auth);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const res = await write(tree.auth, { text: "novo" });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("project_archived");
    expect((await stored(tree.auth))?.summary).toBe("Texto da IA");
  });

  it("ticket sem filhos: 409 ticket_has_no_items, e nada é gravado", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await write(tree.login, { text: "novo" });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("ticket_has_no_items");
    expect(await rows("select 1 from branch_summaries")).toEqual([]);
  });

  it("registra ticket.summary_updated com a origem e SEM o texto", async () => {
    tree = await seedTree(h.pool, h.world());
    await write(tree.auth, { text: "SENTINELA-texto-secreto-3b9c" });
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: "ticket.summary_updated",
      subject_type: "ticket",
      subject_id: tree.auth,
      actor_person_id: h.world().people.contributor,
      payload: { key: "PRIV-1", source: "person" },
    });
    expect(JSON.stringify(recorded[0]?.payload)).not.toContain("SENTINELA");
    expect(Object.keys(recorded[0]?.payload as object).sort()).toEqual(["key", "source"]);
  });

  it("recusa não registra evento", async () => {
    tree = await seedTree(h.pool, h.world());
    await write(tree.auth, { text: "" });
    await write(tree.login, { text: "ok" });
    await write(tree.auth, { text: "ok" }, "reader");
    expect(await events()).toEqual([]);
  });

  it("a procura seguinte usa o texto da pessoa e não chama o resumidor para ele", async () => {
    tree = await seedTree(h.pool, h.world());
    await write(tree.billing, { text: "Cobrança e faturas" });
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"));
    expect(h.judge().calls[0]?.candidates.find((c) => c.title === "Billing")?.summary).toBe("Cobrança e faturas");
    expect(h.summarizer().calls.map((c) => c.title)).not.toContain("Billing");
  });
});

describe("POST /tickets/:id/summary/regenerate", () => {
  it("a IA reescreve a partir dos itens atuais e substitui o texto da pessoa", async () => {
    tree = await seedTree(h.pool, h.world());
    await personText(tree.auth, "Texto antigo da pessoa");
    const res = await regenerate(tree.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: { text: "Resumo de Auth", source: "assistant", updatedAt: expect.any(String) } });
    expect(await stored(tree.auth)).toMatchObject({ summary: "Resumo de Auth", source: "assistant", model: "fake-model", edited_by_person_id: null });
    expect(await stored(tree.auth)).toMatchObject({ content_mark: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await rows("select 1 from branch_summaries where ticket_id = $1", [tree.auth])).toHaveLength(1);
    expect(h.summarizer().calls).toEqual([
      { title: "Auth", descriptionExcerpt: "Tudo sobre entrar no sistema", children: [{ title: "Login", summary: null }, { title: "SSO", summary: null }] },
    ]);
  });

  it("os filhos que são agrupadores entram com o texto guardado deles; sem texto guardado, só com o título; nada em cadeia", async () => {
    tree = await seedTree(h.pool, h.world());
    await personText(tree.sso, "Entrar com a conta da empresa");
    await regenerate(tree.auth);
    expect(h.summarizer().calls).toHaveLength(1);
    expect(h.summarizer().calls[0]?.children).toEqual([
      { title: "Login", summary: null },
      { title: "SSO", summary: "Entrar com a conta da empresa" },
    ]);
    await h.pool.query("delete from branch_summaries");
    h.summarizer().calls.length = 0;
    await regenerate(tree.auth);
    expect(h.summarizer().calls).toHaveLength(1); // o SSO não foi escrito para isso
    expect(await rows("select 1 from branch_summaries where ticket_id = $1", [tree.sso])).toEqual([]);
  });

  it("sem texto anterior, escreve; a procura seguinte reaproveita", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await regenerate(tree.billing)).status).toBe(200);
    expect((await read(tree.billing)).body.summary).toMatchObject({ text: "Resumo de Billing", source: "assistant" });
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
    h.summarizer().calls.length = 0;
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"));
    expect(h.summarizer().calls.map((c) => c.title)).not.toContain("Billing");
  });

  it("ticket sem filhos: 409 ticket_has_no_items, sem chamar a IA, e o texto guardado fica", async () => {
    const [empty] = await seedLeaves(h.pool, h.world(), [{ title: "Acesso", description: "Quem entra" }]);
    await personText(empty!, "Texto da pessoa");
    const res = await regenerate(empty!);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("ticket_has_no_items");
    expect(h.summarizer().calls).toHaveLength(0);
    expect(await stored(empty!)).toMatchObject({ summary: "Texto da pessoa", source: "person" });
    expect(await events()).toEqual([]);
  });

  it("falha do provedor: 503 assistant_unavailable (como a procura) e o texto anterior fica como estava", async () => {
    tree = await seedTree(h.pool, h.world());
    await personText(tree.auth, "Texto da pessoa");
    const before = await stored(tree.auth);
    const beforeAt = (await rows("select updated_at from branch_summaries where ticket_id = $1", [tree.auth]))[0].updated_at;
    h.summarizer().fail = true;
    const res = await regenerate(tree.auth);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_unavailable");
    expect(await stored(tree.auth)).toEqual(before);
    expect((await rows("select updated_at from branch_summaries where ticket_id = $1", [tree.auth]))[0].updated_at).toEqual(beforeAt);
    expect(await events()).toEqual([]);
  });

  it("não há transação aberta enquanto a IA escreve", async () => {
    tree = await seedTree(h.pool, h.world());
    const during: number[] = [];
    h.summarizer().onCall = async () => void during.push(await openTransactions());
    await regenerate(tree.auth);
    expect(during).toEqual([0]);
  });

  it.each(WHO_EDIT)("%s pode pedir", async (who) => {
    tree = await seedTree(h.pool, h.world());
    expect((await regenerate(tree.auth, who)).status).toBe(200);
  });

  it("leitor: 403 sem chamar a IA; quem não vê, outra organização e inexistente: 404", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await regenerate(tree.auth, "reader")).status).toBe(403);
    for (const who of ["plain", "teamAdmin"] as Who[]) expect((await regenerate(tree.auth, who)).status, who).toBe(404);
    expect((await regenerate(tree.auth, "outsider", "org_B")).status).toBe(404);
    expect((await regenerate(UNKNOWN_ID)).status).toBe(404);
    expect(h.summarizer().calls).toHaveLength(0);
    expect(await rows("select 1 from branch_summaries")).toEqual([]);
  });

  it("projeto arquivado: 409 project_archived sem chamar a IA", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const res = await regenerate(tree.auth);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("project_archived");
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("ticket sem filhos (da árvore): 409 ticket_has_no_items", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await regenerate(tree.login);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("ticket_has_no_items");
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("a escrita confere de novo: projeto arquivado durante a chamada (409) e nada é gravado", async () => {
    tree = await seedTree(h.pool, h.world());
    await personText(tree.auth, "Texto da pessoa");
    h.summarizer().onCall = async () => void (await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]));
    const res = await regenerate(tree.auth);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("project_archived");
    expect((await stored(tree.auth))?.summary).toBe("Texto da pessoa");
  });

  it("a escrita confere de novo: papel rebaixado a leitor durante a chamada (403) e ticket apagado (404)", async () => {
    tree = await seedTree(h.pool, h.world());
    h.summarizer().onCall = async () =>
      void (await h.pool.query("update project_memberships set role = 'reader' where person_id = $1 and project_id = $2", [h.world().people.contributor, priv()]));
    expect((await regenerate(tree.auth)).status).toBe(403);
    expect(await stored(tree.auth)).toBeUndefined();
    await h.pool.query("update project_memberships set role = 'contributor' where person_id = $1 and project_id = $2", [h.world().people.contributor, priv()]);
    h.summarizer().onCall = async () => {
      await h.pool.query("delete from tickets where id in ($1, $2)", [tree.invoices, tree.billing]);
    };
    expect((await regenerate(tree.billing)).status).toBe(404);
    expect(await rows("select 1 from branch_summaries")).toEqual([]);
  });

  it("registra ticket.summary_updated com origem 'assistant' e sem o texto", async () => {
    tree = await seedTree(h.pool, h.world());
    await regenerate(tree.auth, "manager");
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      subject_id: tree.auth,
      actor_person_id: h.world().people.manager,
      payload: { key: "PRIV-1", source: "assistant" },
    });
    expect(JSON.stringify(recorded[0]?.payload)).not.toContain("Resumo de Auth");
  });
});

describe("com a IA desligada as três rotas respondem como as demais do assistente", () => {
  const off = useHarness(TEST_CONFIG);
  it("503 assistant_not_configured", async () => {
    for (const [method, path, body] of [
      ["GET", `/api/tickets/${UNKNOWN_ID}/summary`, undefined],
      ["PUT", `/api/tickets/${UNKNOWN_ID}/summary`, { text: "x" }],
      ["POST", `/api/tickets/${UNKNOWN_ID}/summary/regenerate`, undefined],
    ] as const) {
      const res = await off.call(method, path, as("contributor"), body);
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(errorOf(res)).toBe("assistant_not_configured");
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

/** ADR 0034: um só tipo de ticket. O assistente trata todo ticket como possível escopo, pai e destino. */
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

const open = (body: Record<string, unknown> = {}, who: Who = "contributor") =>
  h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message: "Quero corrigir o login", ...body });
const placement = (id: string, body: Record<string, unknown> = {}) =>
  h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), body);
const lastCall = () => h.conversation().calls[h.conversation().calls.length - 1];
const startConversation = async (): Promise<string> => (await open()).body.id as string;
const child = async (parentId: string, title: string, number: number, description = "") =>
  (await rows(
    "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A', $1, $2, $3, $4, $5, $6) returning id",
    [priv(), number, parentId, title, description, h.world().people.manager],
  ))[0].id as string;
const storeText = (ticketId: string, text: string) =>
  h.pool.query(
    "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model, edited_by_person_id) values ('org_A', $1, $2, $3, 'pessoa', 'person', null, $4)",
    [priv(), ticketId, text, h.world().people.manager],
  );

let tree: Tree;
afterEach(() => vi.restoreAllMocks());

describe("candidatos da procura: os filhos que têm filhos", () => {
  it("um ticket que ganha um filho passa a ser candidato; o que fica sem filhos deixa de ser", async () => {
    tree = await seedTree(h.pool, h.world());
    await child(tree.loose, "Filho do solto", 20);
    const id = await startConversation();
    h.judge().calls.length = 0;
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(h.judge().calls[0]?.candidates.map((c) => c.title)).toEqual(["Auth", "Billing", "Solto"]);
    await h.pool.query("delete from tickets where title = 'Filho do solto'");
    h.judge().calls.length = 0;
    await placement(id);
    expect(h.judge().calls[0]?.candidates.map((c) => c.title)).toEqual(["Auth", "Billing"]);
  });
});

describe("escopo: qualquer ticket do projeto", () => {
  it("ticket sem filhos entra na pergunta do escopo com título e trecho da descrição, sem resumidor; a procura termina nele", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("update tickets set description = 'Corrigir o formulário' where id = $1", [tree.login]);
    const id = await startConversation();
    h.judge().calls.length = 0;
    h.summarizer().calls.length = 0;
    const res = await placement(id, { scopeId: tree.login });
    expect(res.status).toBe(201);
    expect(h.judge().calls).toHaveLength(1);
    expect(h.judge().calls[0]).toMatchObject({
      candidates: [],
      current: null,
      scope: { id: tree.login, title: "Login", summary: "Corrigir o formulário", hasChildren: false },
    });
    expect(h.summarizer().calls).toHaveLength(0);
    expect(res.body.destination).toEqual({
      parentId: tree.login,
      path: [{ id: tree.auth, title: "Auth" }, { id: tree.login, title: "Login" }],
    });
    expect(res.body.scope).toEqual({ id: tree.login, title: "Login", outOfScope: false });
  });

  it("escopo sem filhos que não passa na pergunta: outOfScope verdadeiro, como hoje", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await startConversation();
    h.judge().verdict = (input) => ({
      belongs: 0.95,
      choice: Object.fromEntries(input.candidates.map((c) => [c.id, 1])),
      ...(input.scope ? { scopeFit: 0.1 } : {}),
    });
    const res = await placement(id, { scopeId: tree.loose });
    expect(res.status).toBe(201);
    expect(res.body.scope).toEqual({ id: tree.loose, title: "Solto", outOfScope: true });
    expect(res.body.destination.parentId).toBe(tree.loose);
  });

  it("o texto guardado de um ticket sem filhos não entra na pergunta: vale o trecho da descrição", async () => {
    tree = await seedTree(h.pool, h.world());
    await storeText(tree.login, "Texto antigo de quando tinha itens");
    await h.pool.query("update tickets set description = 'Descrição do login' where id = $1", [tree.login]);
    const id = await startConversation();
    h.judge().calls.length = 0;
    await placement(id, { scopeId: tree.login });
    expect(h.judge().calls[0]?.scope).toMatchObject({ summary: "Descrição do login", hasChildren: false });
  });

  it("ticket de outro projeto: 404; já não existe o erro scope_not_group", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await startConversation();
    const foreign = (await rows(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 1, 'De fora', $2) returning id",
      [h.world().projects.org, h.world().people.manager],
    ))[0].id as string;
    expect((await placement(id, { scopeId: foreign })).status).toBe(404);
    const leaf = await placement(id, { scopeId: tree.loose });
    expect(leaf.status).toBe(201);
    expect(errorOf(leaf)).toBeUndefined();
  });
});

describe("bloco groups da conversa", () => {
  it("raiz: só os filhos da raiz que têm filhos, na ordem do número", async () => {
    tree = await seedTree(h.pool, h.world());
    await open();
    expect(lastCall()?.groups).toEqual(["Auth", "Billing"]);
  });

  it("escopo: filhos diretos que têm filhos; ticket sem filhos como escopo dá lista vazia; escopo sem filhos não dá erro", async () => {
    tree = await seedTree(h.pool, h.world());
    await open({ scopeId: tree.auth });
    expect(lastCall()?.groups).toEqual(["SSO"]);
    const res = await open({ scopeId: tree.login });
    expect(res.status).toBe(201);
    expect(lastCall()?.groups).toEqual([]);
  });

  it("no máximo 30 títulos, na ordem do número", async () => {
    tree = await seedTree(h.pool, h.world());
    for (let n = 0; n < 33; n++) {
      const parent = await child(tree.loose, `P${n}`, 100 + n);
      await child(parent, `F${n}`, 200 + n);
    }
    await open({ scopeId: tree.loose });
    expect(lastCall()?.groups).toHaveLength(30);
    expect(lastCall()?.groups[0]).toBe("P0");
    expect(lastCall()?.groups[29]).toBe("P29");
  });
});

describe("texto 'O que entra aqui'", () => {
  const read = (id: string) => h.call("GET", `/api/tickets/${id}/summary`, as("contributor"));
  const write = (id: string, text: string) => h.call("PUT", `/api/tickets/${id}/summary`, as("contributor"), { text });
  const regenerate = (id: string) => h.call("POST", `/api/tickets/${id}/summary/regenerate`, as("contributor"));

  it("GET responde para ticket sem filhos: { summary: null }", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await read(tree.login);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: null });
  });

  it("PUT e regenerate em ticket sem filhos: 409 ticket_has_no_items, e nada é gravado nem pedido à IA", async () => {
    tree = await seedTree(h.pool, h.world());
    const put = await write(tree.login, "Texto");
    expect(put.status).toBe(409);
    expect(errorOf(put)).toBe("ticket_has_no_items");
    h.summarizer().calls.length = 0;
    const regen = await regenerate(tree.login);
    expect(regen.status).toBe(409);
    expect(errorOf(regen)).toBe("ticket_has_no_items");
    expect(h.summarizer().calls).toHaveLength(0);
    expect(await rows("select 1 from branch_summaries where ticket_id = $1", [tree.login])).toHaveLength(0);
  });

  it("PUT e regenerate em ticket com filhos continuam funcionando", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await write(tree.auth, "Tudo de acesso")).status).toBe(200);
    expect((await read(tree.auth)).body.summary.text).toBe("Tudo de acesso");
    expect((await regenerate(tree.auth)).status).toBe(200);
  });

  it("o texto guardado não é apagado quando o último filho sai, e volta a valer quando o ticket volta a ter filhos", async () => {
    tree = await seedTree(h.pool, h.world());
    await write(tree.billing, "Cobranças e faturas");
    expect((await h.call("DELETE", `/api/tickets/${tree.invoices}`, as("admin"))).status).toBe(204);
    expect((await read(tree.billing)).body.summary.text).toBe("Cobranças e faturas");
    expect(await rows("select 1 from branch_summaries where ticket_id = $1", [tree.billing])).toHaveLength(1);
    // Sem filhos: a procura usa o texto montado do ticket, e o escopo diz que não tem filhos.
    const id = await startConversation();
    h.judge().calls.length = 0;
    await placement(id, { scopeId: tree.billing });
    expect(h.judge().calls[0]?.scope).toMatchObject({ hasChildren: false });
    expect(h.judge().calls[0]?.scope?.summary).not.toBe("Cobranças e faturas");
    // Com filhos de novo: a nota guardada volta antes de "Contém", sem chamar o resumidor.
    await child(tree.billing, "Nova fatura", 50);
    h.judge().calls.length = 0;
    h.summarizer().calls.length = 0;
    await placement(id);
    const offered = h.judge().calls[0]?.candidates.find((c) => c.id === tree.billing);
    expect(offered?.summary).toBe("Nota: Cobranças e faturas\nContém: Nova fatura");
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("mudar o pai ou remover filhos pela API não apaga o texto", async () => {
    tree = await seedTree(h.pool, h.world());
    await write(tree.sso, "Logins federados");
    await h.call("PATCH", `/api/tickets/${tree.saml}`, as("admin"), { parentId: null });
    expect(await rows("select 1 from branch_summaries where ticket_id = $1", [tree.sso])).toHaveLength(1);
  });
});

describe("criação pela conversa", () => {
  it("o destino pode ser qualquer ticket, inclusive um sem filhos", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await startConversation();
    const res = await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), { placedBy: "map", parentId: tree.login });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ticket.parentId).toBe(tree.login);
    expect(res.body.ticket).not.toHaveProperty("kind");
  });
});

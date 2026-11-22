import { describe, expect, it } from "vitest";
import { AI_CONFIG, TEST_CONFIG, openApiTransactions } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const WHO_EDIT: Who[] = ["admin", "manager", "contributor"];

const draft = (id: string, body: unknown = { request: "Escreva os critérios", description: "Texto atual" }, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/tickets/${id}/description/draft`, as(who, org), body);
const openTransactions = async () =>
  openApiTransactions(h.pool);
const counts = async () => ({
  tickets: await rows("select id, title, description, updated_at from tickets order by id"),
  events: (await rows("select count(*)::int as n from activity_events"))[0].n as number,
  summaries: (await rows("select count(*)::int as n from branch_summaries"))[0].n as number,
});

let tree: Tree;

describe("POST /tickets/:id/description/draft", () => {
  it("devolve só { text, model } com o texto do escritor", async () => {
    tree = await seedTree(h.pool, h.world());
    h.writer().reply = () => "## Critérios\n- [ ] Um";
    const res = await draft(tree.saml);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "## Critérios\n- [ ] Um", model: "fake-model" });
  });

  it("monta exatamente: título do ticket, descrição do corpo (não a do banco), títulos do topo até o pai e o pedido aparado", async () => {
    tree = await seedTree(h.pool, h.world());
    await draft(tree.saml, { request: "  Escreva os critérios  ", description: "Rascunho não salvo" });
    expect(h.writer().calls).toEqual([
      { title: "SAML", description: "Rascunho não salvo", ancestors: ["Auth", "SSO"], request: "Escreva os critérios" },
    ]);
  });

  it("ticket na raiz: caminho vazio", async () => {
    tree = await seedTree(h.pool, h.world());
    await draft(tree.loose);
    expect(h.writer().calls[0]).toMatchObject({ title: "Solto", ancestors: [] });
  });

  it("não manda id nenhum, chave de ticket, situação nem pessoa ao provedor", async () => {
    tree = await seedTree(h.pool, h.world());
    await draft(tree.saml);
    const sent = JSON.stringify(h.writer().calls);
    for (const id of Object.values(tree)) expect(sent).not.toContain(id);
    expect(Object.keys(h.writer().calls[0]!).sort()).toEqual(["ancestors", "description", "request", "title"]);
    expect(sent).not.toMatch(/manager|org_A|@/);
  });

  it("descrição pode ser vazia; limites: pedido de 1 a 2.000 (depois de aparar), descrição até 20.000", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await draft(tree.auth, { request: "x", description: "" })).status).toBe(200);
    expect((await draft(tree.auth, { request: "x".repeat(2000), description: "y".repeat(20000) })).status).toBe(200);
    for (const body of [
      { request: "", description: "" },
      { request: "   ", description: "" },
      { request: "x".repeat(2001), description: "" },
      { request: "x", description: "y".repeat(20001) },
    ]) {
      expect((await draft(tree.auth, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
  });

  it("corpo inválido: 400 (sem pedido, sem descrição, tipos errados, campo desconhecido)", async () => {
    tree = await seedTree(h.pool, h.world());
    for (const body of [{}, { request: "x" }, { description: "" }, { request: 1, description: "" }, { request: "x", description: null }, { request: "x", description: "", extra: 1 }]) {
      expect((await draft(tree.auth, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(h.writer().calls).toHaveLength(0);
  });

  it("resposta do escritor fora de 1 a 6.000 caracteres: 503 assistant_unavailable", async () => {
    tree = await seedTree(h.pool, h.world());
    h.writer().reply = () => "x".repeat(6001);
    const res = await draft(tree.auth);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_unavailable");
  });

  it("falha do provedor: 503 assistant_unavailable", async () => {
    tree = await seedTree(h.pool, h.world());
    h.writer().fail = true;
    const res = await draft(tree.auth);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_unavailable");
  });

  it("não grava nada: nem descrição, nem evento, nem texto de ramo", async () => {
    tree = await seedTree(h.pool, h.world());
    const before = await counts();
    await draft(tree.auth);
    h.writer().fail = true;
    await draft(tree.auth);
    expect(await counts()).toEqual(before);
  });

  it("não há transação aberta enquanto a IA escreve", async () => {
    tree = await seedTree(h.pool, h.world());
    const during: number[] = [];
    h.writer().onCall = async () => void during.push(await openTransactions());
    await draft(tree.auth);
    expect(during).toEqual([0]);
  });

  it.each(WHO_EDIT)("%s pode pedir", async (who) => {
    tree = await seedTree(h.pool, h.world());
    expect((await draft(tree.auth, undefined, who)).status).toBe(200);
  });

  it("leitor: 403 sem chamar a IA; quem não vê, outra organização e inexistente: 404", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await draft(tree.auth, undefined, "reader")).status).toBe(403);
    for (const who of ["plain", "teamAdmin"] as Who[]) expect((await draft(tree.auth, undefined, who)).status, who).toBe(404);
    expect((await draft(tree.auth, undefined, "outsider", "org_B")).status).toBe(404);
    expect((await draft(UNKNOWN_ID)).status).toBe(404);
    expect(h.writer().calls).toHaveLength(0);
  });

  it("projeto arquivado: 409 project_archived sem chamar a IA", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
    const res = await draft(tree.auth);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("project_archived");
    expect(h.writer().calls).toHaveLength(0);
  });
});

describe("com a IA desligada a rota responde como as demais do assistente", () => {
  const off = useHarness(TEST_CONFIG);
  it("503 assistant_not_configured", async () => {
    const res = await off.call("POST", `/api/tickets/${UNKNOWN_ID}/description/draft`, as("contributor"), { request: "x", description: "" });
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_not_configured");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { seedGroups, seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;

const open = async (who: Who = "contributor") =>
  (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message: "Quero corrigir o login" })).body.id as string;
const placement = (id: string, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/ticket-conversations/${id}/placement`, as(who, org));
const summaryRows = async () => rows("select t.title, s.summary, s.model, s.content_mark from branch_summaries s join tickets t on t.id = s.ticket_id order by t.number");
const openTransactions = async () =>
  (await rows("select count(*)::int as n from pg_stat_activity where usename = 'treepm_app' and state like 'idle in transaction%'"))[0].n as number;

let tree: Tree;
const dropBilling = async () => {
  await h.pool.query("delete from tickets where id = $1", [tree.invoices]);
  await h.pool.query("delete from tickets where id = $1", [tree.billing]);
};
const start = async (who: Who = "contributor") => {
  tree = await seedTree(h.pool, h.world());
  return open(who);
};

afterEach(() => vi.restoreAllMocks());

describe("POST /ticket-conversations/:id/placement — o resultado", () => {
  it("desce do topo até o agrupador mais fundo, oferecendo ao juiz só os agrupadores filhos de cada nível", async () => {
    const id = await start();
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({
      parentId: tree.sso,
      path: [{ id: tree.auth, title: "Auth" }, { id: tree.sso, title: "SSO" }],
    });
    expect(res.body.uncertain).toBe(false);
    expect(res.body.stoppedEarly).toBeNull();
    const seen = h.judge().calls.map((c) => c.candidates.map((x) => x.title));
    // Billing só tem um ticket: não tem agrupador filho, então não há o que perguntar dentro dele.
    expect(seen).toEqual([["Auth", "Billing"], ["SSO"]]);
    expect(h.judge().calls[0]?.draft).toEqual({ title: "Rascunho 1", description: "Quero corrigir o login" });
    expect(h.judge().calls[0]?.current).toBeNull();
    expect(h.judge().calls[1]?.current).toEqual({ title: "Auth", summary: "Resumo de Auth" });
  });

  it("projeto só com tickets soltos na raiz: o juiz nem é chamado e o destino é a raiz", async () => {
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 1, 'Solto 1', $2), ('org_A', $1, 2, 'Solto 2', $2)",
      [priv(), h.world().people.manager],
    );
    const id = await open();
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(res.body.discarded).toEqual([]);
    expect(h.judge().calls).toHaveLength(0);
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("projeto com agrupadores vazios: o juiz recebe os agrupadores como candidatos", async () => {
    await seedGroups(h.pool, h.world(), [{ title: "Acesso" }, { title: "Cobrança", description: "Faturas" }]);
    const id = await open();
    const res = await placement(id);
    expect(res.status).toBe(201);
    // O juiz falso escolhe o primeiro grupo; ele é folha, então a procura termina ali sem outra chamada.
    expect(h.judge().calls).toHaveLength(1);
    expect(h.judge().calls[0]?.candidates.map((c) => c.title)).toEqual(["Acesso", "Cobrança"]);
    expect(h.judge().calls[0]?.candidates.every((c) => !c.hasChildren)).toBe(true);
    expect(h.judge().calls[0]?.candidates.map((c) => c.summary)).toEqual(["", "Faturas"]);
    expect(res.body.destination.path.map((p: { title: string }) => p.title)).toEqual(["Acesso"]);
    // Agrupador vazio: título e descrição, sem chamar o resumidor e sem gravar resumo.
    expect(h.summarizer().calls).toHaveLength(0);
    expect(await summaryRows()).toEqual([]);
  });

  it("ticket nunca é candidato: não chega ao juiz nem ao resumidor, e não ganha resumo", async () => {
    const id = await start();
    await h.pool.query("update tickets set description = 'Trabalho avulso' where id = $1", [tree.loose]);
    await placement(id);
    const offered = h.judge().calls.flatMap((c) => c.candidates.map((x) => x.title));
    for (const ticket of ["Solto", "Login", "Invoices", "SAML"]) expect(offered).not.toContain(ticket);
    expect(h.judge().calls[0]!.candidates.find((c) => c.title === "Auth")).toMatchObject({ summary: "Resumo de Auth", hasChildren: true });
    const summarized = h.summarizer().calls.map((c) => c.title);
    for (const ticket of ["Solto", "Login", "Invoices", "SAML"]) expect(summarized).not.toContain(ticket);
    expect((await summaryRows()).map((r) => r.title)).toEqual(["Auth", "SSO", "Billing"]);
  });

  it("agrupador vazio ao lado de agrupador com filhos: só o com filhos passa pelo resumidor", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, kind, title, description, created_by_person_id) values ('org_A', $1, 8, 'group', 'Vazio', 'Ainda sem filhos', $2)",
      [priv(), h.world().people.manager],
    );
    const id = await open();
    await placement(id);
    const first = h.judge().calls[0]!.candidates;
    expect(first.map((c) => c.title)).toEqual(["Auth", "Billing", "Vazio"]);
    expect(first.find((c) => c.title === "Vazio")).toMatchObject({ summary: "Ainda sem filhos", hasChildren: false });
    expect(h.summarizer().calls.map((c) => c.title)).not.toContain("Vazio");
    expect((await summaryRows()).map((r) => r.title)).not.toContain("Vazio");
  });

  it("o resumo de um agrupador usa título, descrição e os filhos, tickets e agrupadores", async () => {
    const id = await start();
    await placement(id);
    const auth = h.summarizer().calls.find((c) => c.title === "Auth");
    expect(auth?.children.map((c) => c.title)).toEqual(["Login", "SSO"]);
  });

  it("projeto vazio: nenhum candidato, o juiz nem é chamado e o destino é a raiz", async () => {
    const id = await open();
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(h.judge().calls).toHaveLength(0);
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("o juiz diz que não pertence a nenhum ramo: fica na raiz", async () => {
    const id = await start();
    h.judge().verdict = (input) => ({ belongs: 0.1, choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0.5])) });
    const res = await placement(id);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(res.body.discarded.map((d: { title: string }) => d.title).sort()).toEqual(["Auth", "Billing"]);
  });

  it("não altera nada: nenhum ticket novo e a conversa continua aberta", async () => {
    const id = await start();
    await placement(id);
    expect((await rows("select count(*)::int as n from tickets"))[0].n).toBe(7);
    expect((await rows("select status from ticket_conversations where id = $1", [id]))[0].status).toBe("open");
  });
});

describe("placement — resumos de ramo", () => {
  it("escreve os que faltam nos ramos visitados e os guarda com modelo e marca", async () => {
    const id = await start();
    await placement(id);
    const stored = await summaryRows();
    expect(stored.map((r) => r.title)).toEqual(["Auth", "SSO", "Billing"]);
    expect(stored.every((r) => r.model === "fake-model" && /^[0-9a-f]{64}$/.test(r.content_mark))).toBe(true);
  });

  it("os resumos do mesmo nível são escritos em paralelo", async () => {
    const id = await start();
    h.summarizer().delayMs = 40;
    await placement(id);
    expect(h.summarizer().maxConcurrent).toBe(2);
  });

  it("o resumo recebe título, trecho da descrição e filhos com o resumo que já existe", async () => {
    const id = await start();
    await placement(id);
    const auth = h.summarizer().calls.find((c) => c.title === "Auth");
    expect(auth).toEqual({
      title: "Auth",
      descriptionExcerpt: "Tudo sobre entrar no sistema",
      children: [{ title: "Login", summary: null }, { title: "SSO", summary: null }],
    });
  });

  it("converge: a busca seguinte refaz só o ramo cujo filho ganhou resumo, e a terceira não refaz nada", async () => {
    const id = await start();
    await placement(id);
    expect(h.summarizer().calls).toHaveLength(3);
    h.summarizer().calls.length = 0;
    await placement(id);
    expect(h.summarizer().calls.map((c) => c.title)).toEqual(["Auth"]);
    h.summarizer().calls.length = 0;
    await placement(id);
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("refaz só o que mudou: renomear um ramo refaz o dele e o do pai, não o de Billing", async () => {
    const id = await start();
    await placement(id);
    await placement(id);
    h.summarizer().calls.length = 0;
    await h.pool.query("update tickets set title = 'Single sign-on' where id = $1", [tree.sso]);
    await placement(id);
    expect(h.summarizer().calls.map((c) => c.title).sort()).toEqual(["Auth", "Single sign-on"]);
    const stored = await summaryRows();
    expect(stored.find((r) => r.title === "Single sign-on")?.summary).toBe("Resumo de Single sign-on");
  });

  it("mudar a descrição de um ramo refaz o resumo dele", async () => {
    const id = await start();
    await placement(id);
    await placement(id);
    h.summarizer().calls.length = 0;
    await h.pool.query("update tickets set description = 'Cobrança e faturas' where id = $1", [tree.billing]);
    await placement(id);
    expect(h.summarizer().calls.map((c) => c.title)).toEqual(["Billing"]);
  });

  it("o resumo de um ticket removido some com ele", async () => {
    const id = await start();
    await placement(id);
    await dropBilling();
    expect((await summaryRows()).map((r) => r.title)).toEqual(["Auth", "SSO"]);
  });
});

describe("placement — fora de transação e conferência na escrita", () => {
  it("não há transação aberta enquanto o resumidor e o juiz respondem", async () => {
    const id = await start();
    const during: number[] = [];
    h.summarizer().onCall = async () => void during.push(await openTransactions());
    h.judge().onCall = async () => void during.push(await openTransactions());
    expect((await placement(id)).status).toBe(201);
    expect(during.length).toBeGreaterThanOrEqual(4);
    expect(during.every((n) => n === 0)).toBe(true);
  });

  it("projeto arquivado durante o resumo: 409 e nenhum resumo gravado", async () => {
    const id = await start();
    h.summarizer().onCall = async () => void (await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]));
    const res = await placement(id);
    expect(errorOf(res)).toBe("project_archived");
    expect(await summaryRows()).toEqual([]);
  });

  it("conversa apagada durante o resumo: 404 e nenhum resumo gravado", async () => {
    const id = await start();
    h.summarizer().onCall = async () => void (await h.pool.query("delete from ticket_conversations where id = $1", [id]));
    const res = await placement(id);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Conversa não encontrada.");
    expect(await summaryRows()).toEqual([]);
  });

  it("conversa fechada durante o resumo: 409 conversation_closed", async () => {
    const id = await start();
    h.summarizer().onCall = async () => void (await h.pool.query("update ticket_conversations set status = 'discarded' where id = $1", [id]));
    expect(errorOf(await placement(id))).toBe("conversation_closed");
    expect(await summaryRows()).toEqual([]);
  });

  it("papel rebaixado a leitor durante o resumo: 403 e nada gravado", async () => {
    const id = await start();
    h.summarizer().onCall = async () =>
      void (await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]));
    expect((await placement(id)).status).toBe(403);
    expect(await summaryRows()).toEqual([]);
  });

  it("ticket removido durante o resumo: segue sem gravar o resumo dele", async () => {
    const id = await start();
    h.summarizer().onCall = async () => void (await dropBilling());
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect((await summaryRows()).map((r) => r.title)).not.toContain("Billing");
  });
});

describe("placement — indisponibilidade e configuração", () => {
  it("resumidor fora do ar: 503 assistant_unavailable", async () => {
    const id = await start();
    h.summarizer().fail = true;
    const res = await placement(id);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_unavailable");
  });

  it("juiz fora do ar: 503 assistant_unavailable", async () => {
    const id = await start();
    h.judge().fail = true;
    expect(errorOf(await placement(id))).toBe("assistant_unavailable");
  });

  it("rascunho ausente: 409 draft_required e ninguém é chamado", async () => {
    tree = await seedTree(h.pool, h.world());
    h.conversation().reply = () => ({ message: "Conte mais", draft: null, ready: false, model: "claude-opus-5-5" });
    const id = await open();
    const res = await placement(id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("draft_required");
    expect(h.judge().calls).toHaveLength(0);
  });
});

describe("placement — privacidade e permissões", () => {
  it.each(["admin", "manager", "teamAdmin", "reader", "plain"] as const)("%s não procura o caminho da conversa alheia (404)", async (who) => {
    const id = await start();
    const res = await placement(id, who);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Conversa não encontrada.");
    expect(h.judge().calls).toHaveLength(0);
  });

  it("outra organização não enxerga a conversa (404)", async () => {
    const id = await start();
    const res = await placement(id, "outsider", "org_B");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Conversa não encontrada.");
  });

  it("projeto que a pessoa deixou de ver: 404", async () => {
    const id = await start();
    await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]);
    const res = await placement(id);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Projeto não encontrado.");
    expect(h.judge().calls).toHaveLength(0);
  });

  it("papel rebaixado a leitor: 403", async () => {
    const id = await start();
    await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]);
    expect((await placement(id)).status).toBe(403);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const id = await start();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect(errorOf(await placement(id))).toBe("project_archived");
  });

  it("conversa fechada: 409 conversation_closed", async () => {
    const id = await start();
    await h.pool.query("update ticket_conversations set status = 'ticket_created' where id = $1", [id]);
    expect(errorOf(await placement(id))).toBe("conversation_closed");
  });
});

describe("placement — sem as chaves", () => {
  const off = useHarness(TEST_CONFIG);
  it("responde 503 assistant_not_configured", async () => {
    const res = await off.call("POST", "/api/ticket-conversations/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000/placement", as("contributor"));
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_not_configured");
  });
});

describe("placement — escopo pela seleção (ADR 0031)", () => {
  const scoped = (id: string, scopeId: string | null, who: Who | "outsider" = "contributor", org = "org_A") =>
    h.call("POST", `/api/ticket-conversations/${id}/placement`, as(who, org), { scopeId });
  const groupIn = async (projectId: string, orgId: string, number: number, title: string, kind = "group") =>
    (await rows(
      "insert into tickets (org_id, project_id, number, kind, title, created_by_person_id) values ($1,$2,$3,$4,$5,(select id from people where org_id = $1 limit 1)) returning id",
      [orgId, projectId, number, kind, title],
    ))[0].id as string;

  it("sem corpo e com scopeId nulo o resultado é o de hoje, com scope nulo", async () => {
    const id = await start();
    const bare = await placement(id);
    h.judge().calls.length = 0;
    const nulled = await scoped(id, null);
    expect(bare.status).toBe(201);
    expect(nulled.status).toBe(201);
    expect(nulled.body).toEqual(bare.body);
    expect(bare.body.scope).toBeNull();
    expect(h.judge().calls[0]?.scope).toBeUndefined();
  });

  it("corpo com campo desconhecido: 400", async () => {
    const id = await start();
    const res = await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), { scopeId: null, outro: 1 });
    expect(res.status).toBe(400);
  });

  it("escopo com filhos: a procura começa nele, o caminho vem desde a raiz e o resumo do escopo é escrito e gravado", async () => {
    const id = await start();
    const res = await scoped(id, tree.auth);
    expect(res.status).toBe(201);
    const first = h.judge().calls[0]!;
    expect(first.scope).toEqual({ id: tree.auth, title: "Auth", summary: "Resumo de Auth", hasChildren: true });
    expect(first.current).toBeNull();
    expect(first.candidates.map((c) => c.title)).toEqual(["SSO"]);
    expect(res.body.destination).toEqual({ parentId: tree.sso, path: [{ id: tree.auth, title: "Auth" }, { id: tree.sso, title: "SSO" }] });
    expect(res.body.scope).toEqual({ id: tree.auth, title: "Auth", outOfScope: false });
    expect(res.body.stoppedEarly).toBeNull();
    expect((await summaryRows()).map((r) => r.title)).toContain("Auth");
    expect(h.judge().calls).toHaveLength(1); // SSO só tem um ticket: não há mais o que perguntar
  });

  it("escopo no segundo nível: o caminho do destino começa pelos ancestrais", async () => {
    const id = await start();
    const res = await scoped(id, tree.sso);
    expect(res.status).toBe(201);
    expect(res.body.destination.path).toEqual([{ id: tree.auth, title: "Auth" }, { id: tree.sso, title: "SSO" }]);
    expect(res.body.alternatives).toEqual([]);
  });

  it("escopo sem agrupadores filhos: o juiz recebe só a pergunta do escopo, com a descrição, e o destino é o escopo", async () => {
    const id = await start();
    const res = await scoped(id, tree.billing);
    expect(res.status).toBe(201);
    expect(h.judge().calls).toHaveLength(1);
    expect(h.judge().calls[0]).toMatchObject({ candidates: [], current: null, scope: { id: tree.billing, title: "Billing", hasChildren: true } });
    expect(res.body.destination).toEqual({ parentId: tree.billing, path: [{ id: tree.billing, title: "Billing" }] });
  });

  it("agrupador vazio como escopo: vai o trecho da descrição, sem resumidor", async () => {
    const [empty] = await seedGroups(h.pool, h.world(), [{ title: "Acesso", description: "Quem entra" }]);
    const id = await open();
    const res = await scoped(id, empty!);
    expect(res.status).toBe(201);
    expect(h.judge().calls[0]?.scope).toEqual({ id: empty, title: "Acesso", summary: "Quem entra", hasChildren: false });
    expect(h.summarizer().calls).toHaveLength(0);
    expect(res.body.destination.path).toEqual([{ id: empty, title: "Acesso" }]);
  });

  it("Noul do escopo abaixo de 0,3: outOfScope verdadeiro e a probabilidade não sai na resposta", async () => {
    const id = await start();
    h.judge().verdict = (input) => ({
      belongs: 0.95,
      choice: Object.fromEntries(input.candidates.map((c) => [c.id, 1])),
      ...(input.scope ? { scopeFit: 0.1 } : {}),
    });
    const res = await scoped(id, tree.auth);
    expect(res.body.scope).toEqual({ id: tree.auth, title: "Auth", outOfScope: true });
    expect(JSON.stringify(res.body)).not.toContain("0.1");
    expect(res.body.destination.path[0]).toEqual({ id: tree.auth, title: "Auth" });
  });

  it("escopo inexistente: 404", async () => {
    const id = await start();
    const res = await scoped(id, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000");
    expect(res.status).toBe(404);
    expect(h.judge().calls).toHaveLength(0);
  });

  it("escopo de outro projeto da mesma organização: 404", async () => {
    const id = await start();
    const foreign = await groupIn(h.world().projects.org, "org_A", 1, "De outro projeto");
    const res = await scoped(id, foreign);
    expect(res.status).toBe(404);
    expect(h.judge().calls).toHaveLength(0);
    expect(h.summarizer().calls).toHaveLength(0);
  });

  it("escopo de outra organização: 404, igual ao inexistente", async () => {
    const id = await start();
    const foreign = await groupIn(h.world().other.project, "org_B", 1, "De outra organização");
    const res = await scoped(id, foreign);
    expect(res.status).toBe(404);
    expect(h.judge().calls).toHaveLength(0);
  });

  it("escopo do tipo ticket: 409 scope_not_group", async () => {
    const id = await start();
    for (const ticket of [tree.login, tree.loose]) {
      const res = await scoped(id, ticket);
      expect(res.status).toBe(409);
      expect(errorOf(res)).toBe("scope_not_group");
    }
    expect(h.judge().calls).toHaveLength(0);
  });

  it("projeto que a pessoa deixou de ver: 404 mesmo com escopo", async () => {
    const id = await start();
    await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]);
    const res = await scoped(id, tree.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Projeto não encontrado.");
    expect(h.judge().calls).toHaveLength(0);
  });

  it("outra organização não procura com escopo na conversa alheia (404)", async () => {
    const id = await start();
    const res = await scoped(id, tree.auth, "outsider", "org_B");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Conversa não encontrada.");
    expect(h.judge().calls).toHaveLength(0);
  });

  it("não grava o escopo na conversa nem muda a árvore", async () => {
    const id = await start();
    await scoped(id, tree.auth);
    expect((await rows("select count(*)::int as n from tickets"))[0].n).toBe(7);
    const row = (await rows("select * from ticket_conversations where id = $1", [id]))[0];
    expect(JSON.stringify(row)).not.toContain(tree.auth);
  });
});

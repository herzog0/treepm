import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG, TEST_CONFIG, openApiTransactions } from "./helpers.js";
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
  openApiTransactions(h.pool);

/** Texto escrito por uma pessoa para o agrupador (a origem e o modelo nulo vêm da migration 0008). */
const storePersonText = (ticketId: string, text: string) =>
  h.pool.query(
    "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model, edited_by_person_id) values ('org_A', $1, $2, $3, 'pessoa', 'person', null, $4)",
    [priv(), ticketId, text, h.world().people.manager],
  );

let tree: Tree;
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
    expect(h.judge().calls[1]?.current).toEqual({ title: "Auth", summary: "Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML" });
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

  it("projeto com tickets que têm um filho cada: o juiz recebe os pais como candidatos, com o texto montado na hora", async () => {
    await seedGroups(h.pool, h.world(), [{ title: "Acesso" }, { title: "Cobrança", description: "Faturas" }]);
    const id = await open();
    const res = await placement(id);
    expect(res.status).toBe(201);
    // O juiz falso escolhe o primeiro; o filho dele não tem filhos, então a procura termina ali sem outra chamada.
    expect(h.judge().calls).toHaveLength(1);
    expect(h.judge().calls[0]?.candidates.map((c) => c.title)).toEqual(["Acesso", "Cobrança"]);
    expect(h.judge().calls[0]?.candidates.every((c) => c.hasChildren)).toBe(true);
    expect(h.judge().calls[0]?.candidates.map((c) => c.summary)).toEqual(["Contém: Item de Acesso", "Faturas\nContém: Item de Cobrança"]);
    expect(res.body.destination.path.map((p: { title: string }) => p.title)).toEqual(["Acesso"]);
  });

  it("ticket sem filhos nunca é candidato (primeira fatia): não chega ao juiz e a procura não grava texto nenhum", async () => {
    const id = await start();
    await h.pool.query("update tickets set description = 'Trabalho avulso' where id = $1", [tree.loose]);
    await placement(id);
    const offered = h.judge().calls.flatMap((c) => c.candidates.map((x) => x.title));
    for (const ticket of ["Solto", "Login", "Invoices", "SAML"]) expect(offered).not.toContain(ticket);
    expect(h.judge().calls[0]!.candidates.find((c) => c.title === "Auth")).toMatchObject({ summary: "Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML", hasChildren: true });
    expect(h.summarizer().calls).toHaveLength(0);
    expect(await summaryRows()).toEqual([]);
  });

  it("ticket sem filhos ao lado de ticket com filhos: só o com filhos é candidato", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ('org_A', $1, 8, 'Vazio', 'Ainda sem filhos', $2)",
      [priv(), h.world().people.manager],
    );
    const id = await open();
    await placement(id);
    const first = h.judge().calls[0]!.candidates;
    expect(first.map((c) => c.title)).toEqual(["Auth", "Billing"]);
    expect(await summaryRows()).toEqual([]);
  });

  it("o texto de um agrupador lista os filhos, tickets e agrupadores; sem descrição, começa por \"Contém\"", async () => {
    const id = await start();
    await placement(id);
    const first = h.judge().calls[0]!.candidates;
    expect(first.find((c) => c.title === "Auth")?.summary).toBe("Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML");
    expect(first.find((c) => c.title === "Billing")?.summary).toBe("Contém: Invoices");
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

describe("placement — ideias não são lugar para um ticket novo (ADR 0043)", () => {
  /** Uma ideia na raiz e outra dentro de Auth, cada uma com um ticket e um grupo (com filho) dentro, todas com título e texto que seriam o melhor destino. */
  async function seedIdeas(): Promise<string[]> {
    const manager = h.world().people.manager;
    const add = async (number: number, title: string, parentId: string | null, stage: string | null): Promise<string> =>
      (await rows(
        "insert into tickets (org_id, project_id, number, parent_id, title, description, idea_stage, created_by_person_id) values ('org_A',$1,$2,$3,$4,'Quero corrigir o login',$5,$6) returning id",
        [priv(), number, parentId, title, stage, manager],
      ))[0].id as string;
    const rootIdea = await add(20, "Ideia Corrigir o login", null, "new");
    const groupInRoot = await add(21, "Ideia dentro: grupo do login", rootIdea, null);
    await add(22, "Ideia dentro: filho do grupo", groupInRoot, null);
    const nestedIdea = await add(23, "Ideia Corrigir o login em Auth", tree.auth, "refining");
    const groupInNested = await add(24, "Ideia dentro: grupo em Auth", nestedIdea, null);
    await add(25, "Ideia dentro: filho em Auth", groupInNested, null);
    await h.pool.query("update projects set next_ticket_number = 30 where id = $1", [priv()]);
    return [rootIdea, groupInRoot, nestedIdea, groupInNested];
  }
  /** O juiz prefere qualquer candidato com "Ideia" no título; se nenhum for oferecido, prefere Auth. */
  const preferIdeas = () => {
    h.judge().verdict = (input) => {
      const raw = input.candidates.map((c) => (/Ideia/.test(c.title) ? 0.9 : c.title === "Auth" ? 0.5 : 0.05));
      const sum = raw.reduce((a, b) => a + b, 0);
      return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, (raw[i] ?? 0) / sum])) };
    };
  };

  it("uma ideia cujo título e descrição seriam o melhor destino não é candidata, nem os tickets de dentro dela", async () => {
    const id = await start();
    await seedIdeas();
    preferIdeas();
    const res = await placement(id);
    expect(res.status).toBe(201);
    const offered = h.judge().calls.flatMap((c) => c.candidates.map((x) => x.title));
    expect(offered.filter((t) => /Ideia/.test(t))).toEqual([]);
    expect(offered).toContain("Auth");
    expect(JSON.stringify(h.judge().calls)).not.toMatch(/Ideia/); // nem no texto montado dos candidatos
    expect(await summaryRows()).toEqual([]);
    // as ideias não aparecem em nenhum lugar do resultado
    expect(JSON.stringify(res.body)).not.toMatch(/Ideia/);
  });

  it("o ticket novo vai para o melhor destino que é trabalho, e nunca para dentro de uma ideia", async () => {
    const id = await start();
    await seedIdeas();
    preferIdeas();
    const res = await placement(id);
    expect(res.body.destination).toEqual({
      parentId: tree.sso,
      path: [{ id: tree.auth, title: "Auth" }, { id: tree.sso, title: "SSO" }],
    });
    const created = await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), { placedBy: "map", parentId: res.body.destination.parentId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [row] = await rows("select parent_id from tickets where id = $1", [created.body.ticket.id]);
    expect(row.parent_id).toBe(tree.sso);
  });

  it("escopo dentro de uma ideia (ou de um ticket de dentro) não existe para a procura", async () => {
    const id = await start();
    const [rootIdea, groupInRoot] = await seedIdeas();
    for (const scopeId of [rootIdea, groupInRoot]) {
      const res = await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), { scopeId });
      expect(res.status, String(scopeId)).toBeGreaterThanOrEqual(400);
    }
    expect(h.judge().calls).toHaveLength(0);
  });
});

describe("placement — texto do ramo montado na hora", () => {
  it("mudar, acrescentar e remover filhos muda o texto na procura seguinte, sem chamar o resumidor", async () => {
    const id = await start();
    await h.pool.query("update tickets set title = 'Single sign-on', description = 'Outro assunto' where id = $1", [tree.sso]);
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A', $1, 9, $2, 'Filho novo', $3)",
      [priv(), tree.auth, h.world().people.manager],
    );
    await h.pool.query("update projects set next_ticket_number = 10 where id = $1", [priv()]);
    await h.pool.query("delete from tickets where id = $1", [tree.login]);
    await placement(id);
    expect(h.summarizer().calls).toHaveLength(0);
    expect(h.judge().calls[0]?.candidates.map((c) => c.summary)).toEqual([
      "Tudo sobre entrar no sistema\nContém: Single sign-on; Filho novo\nDentro deles: SAML",
      "Contém: Invoices",
    ]);
    // O ticket novo, sem filhos, não é candidato; o SSO renomeado traz o texto montado dele.
    expect(h.judge().calls[1]?.candidates).toMatchObject([{ title: "Single sign-on", summary: "Outro assunto\nContém: SAML" }]);
  });

  it("mudar a descrição ou renomear o próprio ramo vale na procura seguinte", async () => {
    const id = await start();
    await h.pool.query("update tickets set description = 'Cobrança e faturas' where id = $1", [tree.billing]);
    await h.pool.query("update tickets set title = 'Auth e SSO' where id = $1", [tree.auth]);
    await placement(id);
    expect(h.judge().calls[0]?.candidates.map((c) => [c.title, c.summary])).toEqual([
      ["Auth e SSO", "Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML"],
      ["Billing", "Cobrança e faturas\nContém: Invoices"],
    ]);
  });

  it("agrupador com itens e nota de pessoa: a nota vai ao juiz antes de \"Contém\" e o resumidor não é chamado", async () => {
    const id = await start();
    await storePersonText(tree.billing, "Cobrança de clientes e emissão de faturas");
    await placement(id);
    expect(h.judge().calls[0]?.candidates.find((c) => c.title === "Billing")?.summary).toBe("Nota: Cobrança de clientes e emissão de faturas\nContém: Invoices");
    expect(h.summarizer().calls).toHaveLength(0);
    expect((await rows("select source from branch_summaries where ticket_id = $1", [tree.billing]))).toEqual([{ source: "person" }]);
  });

  it("a nota de um filho agrupador não entra no texto do pai; entra só no dele", async () => {
    const id = await start();
    await storePersonText(tree.sso, "Entrar com a conta da empresa");
    await placement(id);
    expect(h.judge().calls[0]?.candidates.find((c) => c.title === "Auth")?.summary).toBe("Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML");
    expect(h.judge().calls[1]?.candidates.find((c) => c.title === "SSO")?.summary).toBe("Nota: Entrar com a conta da empresa\nContém: SAML");
  });
});

describe("placement — fora de transação", () => {
  it("não há transação aberta enquanto o juiz responde", async () => {
    const id = await start();
    const during: number[] = [];
    h.judge().onCall = async () => void during.push(await openTransactions());
    expect((await placement(id)).status).toBe(201);
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(during.every((n) => n === 0)).toBe(true);
  });
});

describe("placement — indisponibilidade e configuração", () => {
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
  const groupIn = async (projectId: string, orgId: string, number: number, title: string) =>
    (await rows(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,$4,(select id from people where org_id = $1 limit 1)) returning id",
      [orgId, projectId, number, title],
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

  it("escopo com filhos: a procura começa nele, o caminho vem desde a raiz e o texto do escopo é montado na hora", async () => {
    const id = await start();
    const res = await scoped(id, tree.auth);
    expect(res.status).toBe(201);
    const first = h.judge().calls[0]!;
    expect(first.scope).toEqual({ id: tree.auth, title: "Auth", summary: "Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML", hasChildren: true });
    expect(first.current).toBeNull();
    expect(first.candidates.map((c) => c.title)).toEqual(["SSO"]);
    expect(res.body.destination).toEqual({ parentId: tree.sso, path: [{ id: tree.auth, title: "Auth" }, { id: tree.sso, title: "SSO" }] });
    expect(res.body.scope).toEqual({ id: tree.auth, title: "Auth", outOfScope: false });
    expect(res.body.stoppedEarly).toBeNull();
    expect(await summaryRows()).toEqual([]);
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

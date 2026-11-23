import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0053, fatia 2: a busca de relacionados funde palavras e significado, na procura e na elaboração.
const WITH_VOYAGE = { ...AI_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" as const };
const h = useHarness(WITH_VOYAGE, { timeouts: { relatedMs: 8000, elaborationMs: 3000 } });
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
let tree: Tree;
afterEach(() => vi.restoreAllMocks());

// O pedido e o ticket falam da mesma coisa com palavras diferentes (nenhum radical em comum): só o "significado" os aproxima.
const CONCEPTS = { autenticar: "login-unico", federacao: "login-unico", saml: "login-unico" };
const open = async (title = "Autenticar por federacao", description = "Sem senha propria", children?: { title: string }[], message = "Quero autenticar por federacao") => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message })).body.id as string;
  expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title, description, ...(children ? { children } : {}) })).status).toBe(200);
  return id;
};
const placement = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
const elaborate = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
const decision = async (id: string) => (await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"))).body.decision;
const queryCalls = () => h.embedder().calls.filter((call) => call.kind === "query");

describe("a procura: relacionados por palavras e por significado", () => {
  it("o ticket que só o vetor acha chega ao Jev e vira relacionado", async () => {
    tree = await seedTree(h.pool, h.world());
    h.embedder().concepts = CONCEPTS;
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "SAML" ? 0.95 : 0.05, sameRequest: 0 }]));
    const res = await placement(await open());
    expect(res.status).toBe(201);
    const sent = h.related().calls[0]!.candidates.map((c) => c.title);
    expect(sent[0]).toBe("SAML");
    expect(res.body.related.map((r: { key: string }) => r.key)).toEqual(["PRIV-4"]);
  });

  it("a triagem fica guardada com a decisão e a rota de leitura a devolve: só números e códigos", async () => {
    tree = await seedTree(h.pool, h.world());
    h.embedder().concepts = CONCEPTS;
    const id = await open();
    await placement(id);
    const read = await decision(id);
    expect(read.triage).toMatchObject({ words: 0, vector: 7, both: 0, onlyVector: 7, sent: 7, semantic: { synced: 7, embedded: 7, pending: 0 } });
    expect(read.triage.semantic.failure).toBeUndefined();
    const [row] = await rows("select triage, row_to_json(d)::text as everything from placement_decisions d where conversation_id = $1", [id]);
    expect(row.triage).toMatchObject({ vector: 7, sent: 7 });
    for (const text of ["SAML", "Login", "Autenticar", "federacao", "senha"]) expect(row.everything, text).not.toContain(text);
    expect(JSON.stringify(read.triage)).toMatch(/^[\w{}[\]":,.-]*$/);
  });

  it("o que chega à porta de vetores: documentos de tickets e UMA consulta com título e descrição do rascunho, nada mais", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open("Autenticar por federacao", "Sem senha propria", [{ title: "Parte secretíssima" }], "Conversa crua com SEGREDO-DA-CONVERSA");
    await placement(id);
    const queries = queryCalls();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.texts).toEqual(["Autenticar por federacao\n\nSem senha propria"]);
    const everything = JSON.stringify(h.embedder().calls);
    for (const leak of ["Parte secretíssima", "SEGREDO-DA-CONVERSA", "Conversa crua", tree.saml, h.world().people.manager, "PRIV-", "contributor"]) expect(everything, leak).not.toContain(leak);
    // Os documentos são só os tickets da árvore (título e descrição), nunca o rascunho.
    const documents = h.embedder().calls.filter((c) => c.kind === "document").flatMap((c) => c.texts);
    expect(documents).toHaveLength(7);
    expect(documents).toContain("Auth\n\nTudo sobre entrar no sistema");
  });

  it("provedor de vetores com falha: a busca segue só com palavras e a decisão registra o código", async () => {
    tree = await seedTree(h.pool, h.world());
    h.embedder().fail = "server_error";
    const id = await open("Entrar com SAML corporativo", "Login único pela empresa");
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(h.related().calls[0]!.candidates.map((c) => c.title)).toEqual(expect.arrayContaining(["SAML", "Login"]));
    expect((await decision(id)).triage).toMatchObject({ vector: 0, onlyVector: 0, semantic: { failure: "server_error" } });
  });

  it("prazo estourado do passo de vetor: o mesmo, sem derrubar a rota", async () => {
    tree = await seedTree(h.pool, h.world());
    h.embedder().delayMs = 10_000;
    const id = await open("Entrar com SAML corporativo", "Login único pela empresa");
    const started = Date.now();
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(8000);
    expect((await decision(id)).triage?.semantic.failure).toBeDefined();
    // A busca seguiu só com palavras: o Jev foi chamado com a lista de palavras (SAML e Login), nada vindo do vetor.
    expect(h.related().calls).toHaveLength(1);
    expect(h.related().calls[0]!.candidates.map((c) => c.title)).toEqual(expect.arrayContaining(["SAML", "Login"]));
    expect((await decision(id)).triage).toMatchObject({ vector: 0, onlyVector: 0 });
  }, 20_000);

  it("a decisão guardada sem a coluna `triage` (migration 0031 ainda não aplicada) continua sendo gravada e lida", async () => {
    tree = await seedTree(h.pool, h.world());
    h.embedder().concepts = CONCEPTS;
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "SAML" ? 0.95 : 0.05, sameRequest: 0 }]));
    await h.pool.query("alter table placement_decisions drop column triage");
    try {
      const id = await open();
      expect((await placement(id)).status).toBe(201);
      expect(await rows("select 1 from placement_decisions where conversation_id = $1", [id])).toHaveLength(1);
      const read = await decision(id);
      // Os relacionados (0029) continuam; só a triagem some.
      expect(read.related[0]).toMatchObject({ number: 4 });
      expect(read.triage).toBeNull();
    } finally {
      await h.pool.query(`alter table placement_decisions add column triage jsonb not null default '{}', add constraint placement_decisions_triage_check check (jsonb_typeof(triage) = 'object')`);
    }
  });

});

describe("o recuo da coluna ausente não engole outros erros", () => {
  it("no estado 0029, um INSERT do degrau do meio que falha por CHECK NÃO cai para o degrau da 0028", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("alter table placement_decisions drop column triage");
    await h.pool.query("alter table placement_decisions add constraint zz_rule_null check (placement_rule is null)");
    try {
      const id = await open("Entrar com SAML corporativo", "Login único pela empresa");
      expect((await placement(id)).status).toBe(201);
      expect(await rows("select 1 from placement_decisions where conversation_id = $1", [id])).toHaveLength(0);
    } finally {
      await h.pool.query("alter table placement_decisions drop constraint zz_rule_null");
      await h.pool.query(`alter table placement_decisions add column triage jsonb not null default '{}', add constraint placement_decisions_triage_check check (jsonb_typeof(triage) = 'object')`);
    }
  });

  it("estado 0028 real (sem as colunas da 0029 nem triage): grava e lê", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("alter table placement_decisions drop column triage, drop column related, drop column duplicate_ticket_id, drop column placement_rule");
    try {
      const id = await open("Entrar com SAML corporativo", "Login único pela empresa");
      expect((await placement(id)).status).toBe(201);
      expect(await rows("select 1 from placement_decisions where conversation_id = $1", [id])).toHaveLength(1);
      const read = await decision(id);
      expect(read.related).toEqual([]);
      expect(read.triage).toBeNull();
      expect(read.chosenPath.length).toBeGreaterThan(0);
    } finally {
      await h.pool.query(`alter table placement_decisions
        add column related jsonb not null default '[]', add column duplicate_ticket_id uuid, add column placement_rule text, add column triage jsonb not null default '{}',
        add constraint placement_decisions_related_check check (jsonb_typeof(related) = 'array'),
        add constraint placement_decisions_triage_check check (jsonb_typeof(triage) = 'object'),
        add constraint placement_decisions_placement_rule_check check (placement_rule is null or placement_rule in ('descent','related_within','related_ancestor','related_choice','choice_unavailable'))`);
    }
  });
});

describe("a elaboração: candidatos das tarefas sugeridas por palavras e por significado", () => {
  const REIMPORT = "Reimportar sem duplicar: guardar a origem de cada ticket";
  const SUGGESTED = { title: "Manter o vínculo permanente com o sistema de origem", description: "Registrar o identificador externo", motivo: "sem vínculo não há diff" };
  const seed = async () => {
    await seedTree(h.pool, h.world());
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A',$1,8,null,$2,'Registrar a chave do outro lado',$3)",
      [priv(), REIMPORT, h.world().people.manager],
    );
    await h.pool.query("update projects set next_ticket_number = 9 where id = $1", [priv()]);
    h.embedder().concepts = { manter: "origem", vinculo: "origem", permanente: "origem", guardar: "origem", reimportar: "origem" };
  };
  const suggest = (...tasks: (typeof SUGGESTED)[]) => {
    h.elaborator().reply = () => ({ links: [], suggested: tasks });
  };

  it("o ticket que só o vetor acha vira candidato do Claude e a ligação nasce", async () => {
    await seed();
    suggest(SUGGESTED);
    h.elaborator().matchReply = (task) => task.candidates.find((c) => c.title === REIMPORT)?.key ?? null;
    // Como no fluxo real, a procura vem antes e põe os vetores em dia (a elaboração só consulta, dentro da reserva de tempo).
    const id = await open();
    await placement(id);
    const res = await elaborate(id);
    expect(res.body.links).toMatchObject([{ de: "pai", dependeDe: "PRIV-8", dependeDeTitle: REIMPORT }]);
    expect(res.body.suggested).toEqual([]);
    expect(res.body.diagnostics.lookups[0].origins.vector).toBeGreaterThan(0);
    expect(res.body.diagnostics.semantic).toMatchObject({ embedded: 0, pending: 0 });
  });

  it("todas as sugeridas numa única chamada de consulta, só com título e descrição delas", async () => {
    await seed();
    const second = { ...SUGGESTED, title: "Outra tarefa implicada", description: "Detalhe da outra" };
    suggest(SUGGESTED, second);
    await elaborate(await open());
    const queries = queryCalls();
    expect(queries).toHaveLength(1);
    expect(queries[0]!.texts).toEqual([`${SUGGESTED.title}\n\n${SUGGESTED.description}`, `${second.title}\n\n${second.description}`]);
    const everything = JSON.stringify(h.embedder().calls);
    for (const leak of [SUGGESTED.motivo, "Sincronizar tickets", "PRIV-", "contributor"]) expect(everything, leak).not.toContain(leak);
  });

  it("falha dos vetores: o mesmo de só palavras, com o código nos diagnósticos", async () => {
    await seed();
    suggest(SUGGESTED);
    h.embedder().fail = "unauthorized";
    h.elaborator().matchReply = () => null;
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body.suggested).toHaveLength(1);
    expect(res.body.diagnostics.semantic.failure).toBe("unauthorized");
    expect(JSON.stringify(res.body.diagnostics)).toMatch(/^[\w{}[\]":,.-]*$/);
  });

  it("a elaboração sem sugerida não chama o provedor de vetores", async () => {
    await seed();
    h.elaborator().reply = () => ({ links: [], suggested: [] });
    await elaborate(await open());
    expect(h.embedder().calls).toHaveLength(0);
  });
});

describe("custo: chamadas e textos por chamada", () => {
  it("1ª busca: um lote de documentos com todos os tickets e UMA consulta; 2ª busca: só a consulta", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open("Entrar com SAML corporativo", "Login único pela empresa");
    await placement(id);
    const shape = () => h.embedder().calls.map((c) => `${c.kind}:${c.texts.length}`);
    expect(shape()).toEqual(["document:7", "query:1"]);
    h.embedder().calls.length = 0;
    await placement(id);
    expect(shape()).toEqual(["query:1"]);
  });
});

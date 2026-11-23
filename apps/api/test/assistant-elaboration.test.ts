import { describe, expect, it } from "vitest";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0052, fatia 3: POST /ticket-conversations/:id/elaboration (ligações e tarefas sugeridas).
const h = useHarness(AI_CONFIG, { timeouts: { relatedMs: 300, elaborationMs: 200 } });
const priv = () => h.world().projects.priv;
let tree: Tree;

const open = async (title = "Entrar com SAML corporativo", description = "Login único pela empresa", children?: { title: string; description: string }[], session = "contributor") => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(session as "contributor"), { message: "Quero entrar com SAML" })).body.id as string;
  expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as(session as "contributor"), { title, description, ...(children ? { children } : {}) })).status).toBe(200);
  return id;
};
const placement = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
const elaborate = (id: string, session = "contributor") => h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as(session as "contributor"));
const relatedAre = (odds: Record<string, [number, number]>) => {
  h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: odds[c.title]?.[0] ?? 0, sameRequest: odds[c.title]?.[1] ?? 0 }]));
};

describe("o que vai ao Claude", () => {
  it("o rascunho (com partes e índices) e, dos relacionados achados na procura, só chave, título, trecho e situação", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("update tickets set description = 'Provedor SAML da empresa' where id = $1", [tree.saml]);
    await h.pool.query("update tickets set status = 'in_progress' where id = $1", [tree.login]);
    relatedAre({ SAML: [0.9, 0.2], Login: [0.75, 0.1] });
    const id = await open("Entrar com SAML corporativo", "Login único pela empresa", [{ title: "Tela de entrada", description: "Botão SAML" }]);
    expect((await placement(id)).status).toBe(201);
    const res = await elaborate(id);
    expect(res.status).toBe(201);
    expect(h.elaborator().calls).toHaveLength(1);
    expect(h.elaborator().calls[0]).toEqual({
      draft: { title: "Entrar com SAML corporativo", description: "Login único pela empresa", parts: [{ title: "Tela de entrada", description: "Botão SAML" }] },
      related: [
        { key: "PRIV-4", title: "SAML", excerpt: "Provedor SAML da empresa", status: "todo" },
        { key: "PRIV-2", title: "Login", excerpt: "", status: "in_progress" },
      ],
    });
    const sent = JSON.stringify(h.elaborator().calls[0]);
    for (const leak of [tree.saml, tree.login, "Nome ", "@exemplo", h.world().people.manager, "org_A"]) expect(sent, leak).not.toContain(leak);
  });

  it("sem procura antes, não há relacionados: a elaboração só olha o rascunho", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(h.elaborator().calls[0]!.related).toEqual([]);
  });

  it("a citação do pedido e as mensagens da conversa nunca vão", async () => {
    tree = await seedTree(h.pool, h.world());
    await elaborate(await open());
    expect(JSON.stringify(h.elaborator().calls[0])).not.toContain("Quero entrar com SAML");
  });
});

describe("o que o servidor aceita da resposta", () => {
  it("devolve ligações com chave, título e motivo, e tarefas sugeridas", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.9, 0.2], Login: [0.75, 0.1] });
    h.elaborator().reply = () => ({
      links: [{ de: "pai", dependeDe: "PRIV-2", motivo: "usa a tela de entrada" }],
      suggested: [{ title: "Cadastrar o provedor", description: "No painel", motivo: "sem provedor não há login" }],
    });
    const id = await open();
    await placement(id);
    const res = await elaborate(id);
    expect(res.body).toMatchObject({
      links: [{ de: "pai", dependeDe: "PRIV-2", dependeDeTitle: "Login", motivo: "usa a tela de entrada" }],
      suggested: [{ title: "Cadastrar o provedor", description: "No painel", motivo: "sem provedor não há login" }],
      unavailable: null,
    });
  });

  it("descarta chave fora da lista, o duplicado, ligação repetida, e sugestão que repete parte ou relacionado", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.95, 0.9], Login: [0.8, 0.2] });
    h.elaborator().reply = () => ({
      links: [
        { de: "pai", dependeDe: "PRIV-1", motivo: "Auth não veio na lista" },
        { de: "pai", dependeDe: "PRIV-4", motivo: "o duplicado" },
        { de: "pai", dependeDe: "PRIV-2", motivo: "ok" },
        { de: "pai", dependeDe: "PRIV-2", motivo: "repetida" },
        { de: 3, dependeDe: "PRIV-2", motivo: "parte que não existe" },
      ],
      suggested: [
        { title: "Tela de entrada", description: "", motivo: "repete a parte" },
        { title: "login", description: "", motivo: "repete o relacionado" },
        { title: "Cadastrar o provedor", description: "", motivo: "ok" },
      ],
    });
    const id = await open("Entrar com SAML corporativo", "Login único pela empresa", [{ title: "Tela de entrada", description: "" }]);
    await placement(id);
    const res = await elaborate(id);
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).toEqual(["PRIV-2"]);
    expect(res.body.suggested.map((s: { title: string }) => s.title)).toEqual(["Cadastrar o provedor"]);
  });
});

describe("sem provedor, sem aceite ou com erro do modelo: listas vazias com o motivo", () => {
  it("erro do modelo", async () => {
    tree = await seedTree(h.pool, h.world());
    h.elaborator().fail = true;
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ links: [], suggested: [], unavailable: "unavailable" });
  });

  it("modelo que não responde no prazo", async () => {
    tree = await seedTree(h.pool, h.world());
    h.elaborator().hang = true;
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ links: [], suggested: [], unavailable: "unavailable" });
  });
});

describe("as conferências da rota", () => {
  it("conversa de outra pessoa: 404 e nada vai ao modelo", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    expect((await elaborate(id, "manager")).status).toBe(404);
    expect(h.elaborator().calls).toHaveLength(0);
  });

  it("sem rascunho: 409 draft_required", async () => {
    tree = await seedTree(h.pool, h.world());
    h.conversation().reply = () => ({ message: "Qual o assunto?", draft: null, ready: false, model: "m" });
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "oi" })).body.id as string;
    const res = await elaborate(id);
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe("draft_required");
  });

  it("conversa já encerrada: 409", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await h.pool.query("update ticket_conversations set status = 'discarded' where id = $1", [id]);
    expect((await elaborate(id)).status).toBe(409);
    expect(h.elaborator().calls).toHaveLength(0);
  });

  it("quem só lê o projeto não elabora: 403", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await h.pool.query("update ticket_conversations set author_person_id = $2 where id = $1", [id, h.world().people.reader]);
    expect((await elaborate(id, "reader")).status).toBe(403);
    expect(h.elaborator().calls).toHaveLength(0);
  });
});

describe("sem o aceite da organização", () => {
  const sem = useHarness(AI_CONFIG, { consent: false });
  it("200 com listas vazias e consent_required, sem chamar o modelo", async () => {
    const t = await seedTree(sem.pool, sem.world());
    expect(t.auth).toBeTruthy();
    const id = (await sem.call("POST", `/api/projects/${sem.world().projects.priv}/ticket-conversations`, as("contributor"), { message: "oi" }).catch(() => null)) ;
    // Sem aceite a conversa nem abre: a conversa é semeada à mão.
    expect(id === null || id.status === 403).toBe(true);
    const conv = await sem.pool.query<{ id: string }>(
      "insert into ticket_conversations (org_id, project_id, author_person_id, draft_title, draft_description) values ('org_A',$1,$2,'T','D') returning id",
      [sem.world().projects.priv, sem.world().people.contributor],
    );
    const res = await sem.call("POST", `/api/ticket-conversations/${conv.rows[0]!.id}/elaboration`, as("contributor"));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ links: [], suggested: [], unavailable: "consent_required" });
    expect(sem.elaborator().calls).toHaveLength(0);
  });
});

describe("sem o assistente configurado", () => {
  const sem = useHarness(TEST_CONFIG);
  it("200 com listas vazias e not_configured", async () => {
    await seedTree(sem.pool, sem.world());
    const conv = await sem.pool.query<{ id: string }>(
      "insert into ticket_conversations (org_id, project_id, author_person_id, draft_title, draft_description) values ('org_A',$1,$2,'T','D') returning id",
      [sem.world().projects.priv, sem.world().people.contributor],
    );
    const res = await sem.call("POST", `/api/ticket-conversations/${conv.rows[0]!.id}/elaboration`, as("contributor"));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ links: [], suggested: [], unavailable: "not_configured" });
  });
});

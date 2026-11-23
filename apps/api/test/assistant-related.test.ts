import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { recordQueries } from "./query-recorder.js";
import { as } from "./world.js";

// ADR 0052, fatia 2: tickets relacionados de baixo para cima, o lugar e o aviso de duplicado.
const h = useHarness(AI_CONFIG, { timeouts: { relatedMs: 300 } });
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
let tree: Tree;
afterEach(() => vi.restoreAllMocks());

/** Abre a conversa e fixa o rascunho (o que a triagem lê: título, descrição e partes). */
const open = async (title = "Entrar com SAML corporativo", description = "Login único pela empresa") => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero entrar com SAML" })).body.id as string;
  expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title, description })).status).toBe(200);
  return id;
};
const placement = (id: string, body?: unknown) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), body);
/** O Jev dos relacionados responde por título. */
const relatedAre = (odds: Record<string, [number, number]>) => {
  h.related().verdict = (input) =>
    Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: odds[c.title]?.[0] ?? 0, sameRequest: odds[c.title]?.[1] ?? 0 }]));
};
const destinationOf = (res: { body: { destination: { parentId: string | null } } }) => res.body.destination.parentId;

describe("sem relacionado: tudo como antes", () => {
  it("a resposta ganha related vazio e duplicate nulo, e o lugar é o da descida", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await placement(await open());
    expect(res.status).toBe(201);
    expect(res.body.related).toEqual([]);
    expect(res.body.duplicate).toBeNull();
    expect(destinationOf(res)).toBe(tree.sso);
    expect(h.related().calls).toHaveLength(1);
  });

  it("a triagem manda ao Jev só quem tem palavra em comum com o rascunho (SAML), nunca texto de fora da árvore", async () => {
    tree = await seedTree(h.pool, h.world());
    await placement(await open());
    const sent = h.related().calls[0]!;
    const titles = sent.candidates.map((c) => c.title);
    expect(titles).toEqual(expect.arrayContaining(["SAML", "Login"]));
    for (const outside of ["Billing", "Invoices", "Solto"]) expect(titles).not.toContain(outside);
    expect(sent.draft.title).toBe("Entrar com SAML corporativo");
  });

  it("nenhuma palavra em comum: o Jev dos relacionados nem é chamado", async () => {
    tree = await seedTree(h.pool, h.world());
    const res = await placement(await open("Zzzz qqqq", "xxxx yyyy"));
    expect(res.status).toBe(201);
    expect(h.related().calls).toHaveLength(0);
    expect(res.body.related).toEqual([]);
  });
});

describe("os relacionados e o lugar", () => {
  it("lista os relacionados com chave, título, situação e caminho, sem probabilidades", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.9, 0.2], Login: [0.75, 0.1] });
    const res = await placement(await open());
    expect(res.body.related).toEqual([
      { id: tree.saml, key: "PRIV-4", title: "SAML", status: "todo", path: [{ id: tree.auth, title: "Auth" }, { id: tree.sso, title: "SSO" }] },
      { id: tree.login, key: "PRIV-2", title: "Login", status: "todo", path: [{ id: tree.auth, title: "Auth" }] },
    ]);
    expect(res.body.duplicate).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/0\.9|0\.75|sameSubject|sameRequest/);
  });

  it("o destino da descida é o pai do relacionado: fica", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.9, 0.2] });
    const res = await placement(await open());
    expect(destinationOf(res)).toBe(tree.sso);
    expect(h.judge().calls).toHaveLength(2); // só a descida: raiz e Auth (SSO só tem folha)
  });

  it("a descida ficou na raiz e o relacionado está fundo: vence o pai do relacionado", async () => {
    tree = await seedTree(h.pool, h.world());
    h.judge().verdict = (input) => ({ belongs: 0.1, choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0.5])) });
    relatedAre({ SAML: [0.9, 0.2] });
    const res = await placement(await open());
    expect(destinationOf(res)).toBe(tree.sso);
    expect(res.body.destination.path.map((p: { id: string }) => p.id)).toEqual([tree.auth, tree.sso]);
    expect(res.body.uncertain).toBe(false);
  });

  it("ramos diferentes: uma pergunta de escolha ao Jev com o texto montado de cada destino", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ Invoices: [0.9, 0.1] });
    // A descida vai a Auth > SSO (o primeiro); a escolha entre SSO e Billing prefere Billing.
    const base = h.judge().verdict;
    h.judge().verdict = (input) =>
      input.candidates.some((c) => c.title === "Billing") && input.candidates.some((c) => c.title === "SSO")
        ? { belongs: 0.9, choice: Object.fromEntries(input.candidates.map((c) => [c.id, c.title === "Billing" ? 0.8 : 0.2])) }
        : base?.(input) ?? { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, i === 0 ? 0.9 : 0.1])) };
    const res = await placement(await open("Entrar com SAML e emitir invoices", "Faturas e login"));
    const choice = h.judge().calls.find((call) => call.candidates.some((c) => c.title === "Billing") && call.candidates.some((c) => c.title === "SSO"));
    expect(choice?.current).toBeNull();
    expect(choice?.candidates.map((c) => c.title)).toEqual(["SSO", "Billing"]);
    expect(choice?.candidates.find((c) => c.title === "Billing")?.summary).toBe("Contém: Invoices");
    expect(destinationOf(res)).toBe(tree.billing);
    expect(res.body.uncertain).toBe(true);
    expect(res.body.alternatives.map((a: { parentId: string }) => a.parentId)).toEqual([tree.sso]);
  });

  it("a escolha ao Jev falhou: fica o da descida, incerto, e a procura segue", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ Invoices: [0.9, 0.1] });
    const base = h.judge().verdict;
    h.judge().verdict = (input) => {
      if (input.candidates.some((c) => c.title === "Billing") && input.candidates.some((c) => c.title === "SSO")) throw new Error("fora do ar");
      return base?.(input) ?? { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, i === 0 ? 0.9 : 0.1])) };
    };
    const res = await placement(await open("Entrar com SAML e emitir invoices", "Faturas e login"));
    expect(res.status).toBe(201);
    expect(destinationOf(res)).toBe(tree.sso);
    expect(res.body.uncertain).toBe(true);
    expect(res.body.alternatives.map((a: { parentId: string }) => a.parentId)).toEqual([tree.billing]);
  });
});

describe("pedido que já existe", () => {
  it("devolve o duplicado e nunca propõe criar dentro dele", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.95, 0.9], Login: [0.8, 0.2] });
    const res = await placement(await open());
    expect(res.body.duplicate).toEqual({ id: tree.saml, key: "PRIV-4", title: "SAML", status: "todo" });
    expect(res.body.related.map((r: { id: string }) => r.id)).toEqual([tree.saml, tree.login]);
    expect(destinationOf(res)).not.toBe(tree.saml);
    expect(res.body.destination.path.map((p: { id: string }) => p.id)).not.toContain(tree.saml);
  });

  it("a descida que parou dentro do duplicado volta ao pai dele", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SSO: [0.95, 0.9] });
    const res = await placement(await open("Entrar com SSO", "SSO da empresa"));
    expect(res.body.duplicate?.id).toBe(tree.sso);
    expect(destinationOf(res)).toBe(tree.auth);
  });
});

describe("escopo", () => {
  it("relacionado fora do escopo aparece na lista mas não gera destino", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.9, 0.2] });
    const res = await placement(await open(), { scopeId: tree.billing });
    expect(res.status).toBe(201);
    expect(res.body.related.map((r: { id: string }) => r.id)).toEqual([tree.saml]);
    expect(res.body.destination.path.map((p: { id: string }) => p.id)[0]).toBe(tree.billing);
  });
});

describe("falha do julgamento: não derruba a procura", () => {
  it("erro do Jev: sem relacionados e sem texto no aviso", async () => {
    tree = await seedTree(h.pool, h.world());
    h.related().fail = true;
    const warn = vi.spyOn(Logger.prototype, "warn");
    const res = await placement(await open());
    expect(res.status).toBe(201);
    expect(res.body.related).toEqual([]);
    expect(res.body.duplicate).toBeNull();
    expect(destinationOf(res)).toBe(tree.sso);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("relacionados"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/SAML|Login|Entrar/);
  });

  it("prazo estourado: o mesmo", async () => {
    tree = await seedTree(h.pool, h.world());
    h.related().hang = true;
    const res = await placement(await open());
    expect(res.status).toBe(201);
    expect(res.body.related).toEqual([]);
    expect(destinationOf(res)).toBe(tree.sso);
  });
});

describe("a decisão guardada", () => {
  it("leva os relacionados com as duas probabilidades, o duplicado e a regra, sem texto", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.95, 0.9], Login: [0.8, 0.2] });
    const id = await open();
    await placement(id);
    const [row] = await rows("select related, duplicate_ticket_id, placement_rule, row_to_json(d)::text as everything from placement_decisions d where conversation_id = $1", [id]);
    expect(row.related).toEqual([
      { ticketId: tree.saml, number: 4, sameSubject: 0.95, sameRequest: 0.9 },
      { ticketId: tree.login, number: 2, sameSubject: 0.8, sameRequest: 0.2 },
    ]);
    expect(row.duplicate_ticket_id).toBe(tree.saml);
    expect(row.placement_rule).toBe("related_within");
    for (const text of ["SAML", "Login", "Entrar", "corporativo", "Login único"]) expect(row.everything, text).not.toContain(text);
    const read = await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"));
    expect(read.body.decision.related[0]).toEqual({ ticketId: tree.saml, number: 4, sameSubject: 0.95, sameRequest: 0.9 });
    expect(read.body.decision.duplicateTicketId).toBe(tree.saml);
    expect(read.body.decision.rule).toBe("related_within");
  });

  it("sem relacionado a regra é 'descent' e a lista é vazia", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    await placement(id);
    const [row] = await rows("select related, duplicate_ticket_id, placement_rule from placement_decisions where conversation_id = $1", [id]);
    expect(row).toEqual({ related: [], duplicate_ticket_id: null, placement_rule: "descent" });
  });

  it("sem as colunas da 0029 a decisão da 0028 continua sendo guardada e lida", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.9, 0.2] });
    await h.pool.query("alter table placement_decisions drop column related, drop column duplicate_ticket_id, drop column placement_rule");
    try {
      const id = await open();
      expect((await placement(id)).status).toBe(201);
      expect(await rows("select 1 from placement_decisions where conversation_id = $1", [id])).toHaveLength(1);
      const read = await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"));
      expect(read.body.decision.chosenPath).toEqual([tree.auth, tree.sso]);
      expect(read.body.decision.related).toEqual([]);
    } finally {
      await h.pool.query(`alter table placement_decisions
        add column related jsonb not null default '[]', add column duplicate_ticket_id uuid, add column placement_rule text,
        add constraint placement_decisions_related_check check (jsonb_typeof(related) = 'array'),
        add constraint placement_decisions_placement_rule_check check (placement_rule is null or placement_rule in ('descent','related_within','related_ancestor','related_choice','choice_unavailable'))`);
    }
  });
});

describe("custo: a triagem é em memória", () => {
  const seedMany = async (count: number) => {
    await h.pool.query(
      `insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id)
       select 'org_A', $1, 1 + g, case when g % 10 = 0 then null else (select id from tickets where project_id = $1 and number = 1 + (g / 10) * 10) end, 'Painel ' || g || ' saml', $2
       from generate_series(0, $3 - 1) g order by g`,
      [priv(), h.world().people.manager, count],
    );
    await h.pool.query("update projects set next_ticket_number = $2 where id = $1", [priv(), count + 1]);
  };
  const costOfSearch = async (count: number) => {
    await h.pool.query("delete from tickets where project_id = $1", [priv()]);
    await seedMany(count);
    const id = await open();
    h.related().calls.length = 0;
    h.judge().calls.length = 0;
    const { queries } = await recordQueries(() => placement(id));
    return { total: queries.length, relatedCalls: h.related().calls.length, sent: h.related().calls[0]?.candidates.length ?? 0, judgeCalls: h.judge().calls.length };
  };

  it("uma requisição a mais ao Jev, no máximo 30 candidatos e o mesmo número de consultas com 300 ou 3.000 tickets", async () => {
    const small = await costOfSearch(300);
    const big = await costOfSearch(3000);
    expect(small.relatedCalls).toBe(1);
    expect(big.relatedCalls).toBe(1);
    expect(small.sent).toBe(30);
    expect(big.sent).toBe(30);
    expect(big.total).toBe(small.total);
  }, 90_000);
});

describe("revisão 1", () => {
  it("o duplicado sai mesmo com 'mesmo assunto' baixo, traz a situação e fora da lista de relacionados (pontos 5 e 13)", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.5, 0.95] });
    const res = await placement(await open());
    expect(res.body.related).toEqual([]);
    expect(res.body.duplicate).toEqual({ id: tree.saml, key: "PRIV-4", title: "SAML", status: "todo" });
  });

  it("a proposta de agrupador nunca inclui o duplicado entre os soltos (ponto 5)", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ Solto: [0.9, 0.95] });
    h.affinity().verdict = (input) => Object.fromEntries(input.tickets.map((t) => [t.id, 0.99]));
    await placement(await open("Entrar com Solto", "Solto"));
    for (const call of h.affinity().calls) expect(call.tickets.map((t) => t.id)).not.toContain(tree.loose);
  });

  it("a descida falha: a requisição dos relacionados é abortada (ponto 7)", async () => {
    tree = await seedTree(h.pool, h.world());
    h.judge().fail = true;
    let aborted = false;
    h.related().judgeHook = (signal) => signal?.addEventListener("abort", () => (aborted = true));
    h.related().hang = true;
    const res = await placement(await open());
    expect(res.status).toBe(503);
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
  });

  it("decisão: erro que não é coluna ausente não grava às escondidas sem as colunas (ponto 8)", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: [0.9, 0.2] });
    await h.pool.query("alter table placement_decisions add constraint boom check (false) not valid");
    try {
      const id = await open();
      expect((await placement(id)).status).toBe(201);
      expect(await rows("select 1 from placement_decisions where conversation_id = $1", [id])).toHaveLength(0);
    } finally {
      await h.pool.query("alter table placement_decisions drop constraint boom");
    }
  });
});

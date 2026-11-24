import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
let tree: Tree;
const start = async () => {
  tree = await seedTree(h.pool, h.world());
  return (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
};
const another = async () => (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
const placement = (id: string, body: object = {}) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), body);
const create = (id: string, body: object) => h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), body);
const decision = async (id: string) => (await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"))).body.decision;
/** O juiz responde pelo título do nó atual ("root" na raiz); o que não está no mapa desce com confiança. */
const verdicts = (byCurrent: Record<string, { belongs: number; choice?: number[] }>) => {
  h.judge().verdict = (input) => {
    const v = byCurrent[input.current?.title ?? "root"] ?? { belongs: 0.95 };
    const n = input.candidates.length;
    const probs = v.choice ?? input.candidates.map((_, i) => (n === 1 ? 1 : i === 0 ? 0.9 : 0.1 / (n - 1)));
    return { belongs: v.belongs, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, probs[i] ?? 0])) };
  };
};
afterEach(() => vi.restoreAllMocks());

const codeOf = (res: { body: { error?: { code: string }; code?: string } }) => res.body.error?.code ?? res.body.code;
const placedByOf = async (ticketId: string): Promise<string | null | undefined> => (await h.pool.query("select placed_by from placement_decisions where ticket_id = $1", [ticketId])).rows[0]?.placed_by;
/** SAML vira agrupador (um filho), para a árvore ter Auth → SSO → SAML com perguntas em níveis diferentes. */
const deepen = async () => {
  await h.pool.query("insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A', $1, 50, $2, 'SAML Config', $3)", [priv(), tree.saml, h.world().people.manager]);
  await h.pool.query("update projects set next_ticket_number = 51 where id = $1", [priv()]);
};
const optionIds = (res: { body: { question: { options: { id: string }[] } } }) => res.body.question.options.map((o) => o.id);

describe("POST /placement — a pergunta (ADR 0054, adendo)", () => {
  it("sem dúvida: sem pergunta, destino confirmado, como antes", async () => {
    const id = await start();
    const res = await placement(id);
    expect(res.body).toMatchObject({ question: null, destinationConfirmed: true, uncertain: false });
    expect(res.body.destination.parentId).toBe(tree.sso);
    expect(res.body).not.toHaveProperty("needsMap");
    expect(res.body).not.toHaveProperty("reachedLimit");
  });

  it("raiz sem aviso vira pergunta `root`: opções em ordem de probabilidade, destino é só o palpite e incerto", async () => {
    const id = await start();
    verdicts({ root: { belongs: 0.1, choice: [0.2, 0.8] } });
    const res = await placement(id);
    expect(res.body.destination.parentId).toBeNull();
    expect(res.body).toMatchObject({ destinationConfirmed: false, uncertain: true });
    expect(res.body.question).toMatchObject({ level: 1, kind: "root", at: { id: null, path: [] } });
    expect(Object.keys(res.body.question).sort()).toEqual(["at", "kind", "level", "options"]);
    expect(optionIds(res)).toEqual([tree.billing, tree.auth]);
    expect(res.body.question.options[0]).toEqual({ id: tree.billing, title: "Billing", path: [{ id: tree.billing, title: "Billing" }] });
  });

  it("conversa de duas perguntas: raiz → startId = Auth → desce por SSO → dúvida mais fundo → startId = SAML → confirmado → cria com `search`", async () => {
    const id = await start();
    await deepen();
    verdicts({ root: { belongs: 0.1 }, SSO: { belongs: 0.5 } });
    const first = await placement(id);
    expect(first.body.question).toMatchObject({ level: 1, kind: "root" });
    expect((await decision(id)).doubt).toMatchObject({ confirmed: false, startId: null, question: { kind: "root", level: 1, parentId: null } });

    // A procura parte de Auth sem julgá-lo de novo, desce por SSO com confiança e pergunta mais fundo (cabe em SSO?).
    h.judge().calls.length = 0;
    const second = await placement(id, { startId: tree.auth });
    expect(h.judge().calls[0]?.current?.title).toBe("Auth");
    expect(h.judge().calls[0]?.scope).toBeUndefined();
    expect(second.body.question).toMatchObject({ level: 3, kind: "fit", at: { id: tree.sso } });
    expect(optionIds(second)).toEqual([tree.saml]);
    expect(second.body).toMatchObject({ destinationConfirmed: false, uncertain: true, scope: null });
    expect((await decision(id)).doubt).toMatchObject({ confirmed: false, startId: tree.auth, question: { kind: "fit", level: 3, parentId: tree.sso } });

    // A pessoa confirma SAML: sem mais dúvida, destino confirmado.
    const third = await placement(id, { startId: tree.saml });
    expect(third.body).toMatchObject({ question: null, destinationConfirmed: true });
    expect(third.body.destination.parentId).toBe(tree.saml);
    const stored = await decision(id);
    expect(stored.doubt).toMatchObject({ confirmed: true, startId: tree.saml, question: null });
    expect(stored).not.toHaveProperty("placedBy"); // a decisão passa ao ticket na criação; a leitura nunca teve o que dizer aqui
    expect(JSON.stringify(stored.doubt)).not.toMatch(/Auth|Billing|SSO|SAML/);

    const created = await create(id, { parentId: third.body.destination.parentId, placedBy: "search" });
    expect(created.status).toBe(201);
    expect(await placedByOf(created.body.ticket.id)).toBe("search");
  });

  it("dúvida `related`: startId = uma das opções (que não é filha direta do nó da pergunta) → dúvida `fit` dentro dela → startId → confirmado", async () => {
    const id = await start();
    await deepen();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML e emitir invoices", description: "Faturas e login" });
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "Invoices" ? 0.9 : 0, sameRequest: 0.1 }]));
    h.judge().verdict = (input) => {
      const titles = input.candidates.map((c) => c.title);
      const n = input.candidates.length;
      const ranked = Object.fromEntries(input.candidates.map((c, i) => [c.id, n === 1 ? 1 : i === 0 ? 0.9 : 0.1 / (n - 1)]));
      if (titles.includes("SSO") && titles.includes("Billing")) return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c) => [c.id, c.title === "SSO" ? 0.45 : 0.35])) };
      return { belongs: input.current?.title === "SSO" ? 0.5 : 0.95, choice: ranked };
    };
    const first = await placement(id);
    expect(first.body.question).toMatchObject({ kind: "related", level: 1, at: { id: null } });
    expect(optionIds(first).sort()).toEqual([tree.billing, tree.sso].sort());
    // SSO não é filho direto da raiz (o nó da pergunta): a procura parte dele, e a dúvida de verdade vem dentro (cabe em SSO?).
    const second = await placement(id, { startId: tree.sso });
    expect(second.body.question).toMatchObject({ kind: "fit", at: { id: tree.sso }, level: 3 });
    expect(optionIds(second)).toEqual([tree.saml]);
    const third = await placement(id, { startId: tree.saml });
    expect(third.body).toMatchObject({ question: null, destinationConfirmed: true });
    expect(third.body.destination.parentId).toBe(tree.saml);
  });

  it("o relacionado em outro ramo não tira o ticket de dentro do ramo confirmado", async () => {
    const id = await start();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Emitir invoices", description: "Faturas" });
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "Invoices" ? 0.95 : 0, sameRequest: 0.1 }]));
    h.judge().verdict = (input) => {
      const n = input.candidates.length;
      const titles = input.candidates.map((c) => c.title);
      const contested = titles.includes("SSO") && titles.includes("Billing");
      const odds = (c: { title: string }, i: number): number => (contested ? (c.title === "Billing" ? 0.9 : 0.1) : n === 1 ? 1 : i === 0 ? 0.9 : 0.1 / (n - 1));
      return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, odds(c, i)])) };
    };
    const free = await placement(id);
    expect(free.body.destination.parentId).toBe(tree.billing);
    const inside = await placement(id, { startId: tree.auth });
    expect(inside.body.destination.path.map((p: { id: string }) => p.id)[0]).toBe(tree.auth);
    expect(inside.body.destination.parentId).not.toBe(tree.billing);
  });

  it("a raiz nunca é destino confirmado: projeto sem agrupador pergunta `root` sem opções", async () => {
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 1, 'Solto', $2)", [priv(), h.world().people.manager]);
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Algo" })).body.id as string;
    const res = await placement(id);
    expect(res.body).toMatchObject({ destinationConfirmed: false, uncertain: true, question: { kind: "root", options: [] } });
  });

  it("`related` de relacionado fraco pode sair com uma opção só", async () => {
    const id = await start();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML e emitir invoices", description: "Faturas e login" });
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "Invoices" ? 0.75 : 0, sameRequest: 0.1 }]));
    verdicts({ root: { belongs: 0.1 } });
    const res = await placement(id);
    expect(res.body.question).toMatchObject({ kind: "related", at: { id: null } });
    expect(optionIds(res)).toContain(tree.billing);
    expect(res.body.destinationConfirmed).toBe(false);
  });

  it("escolha confiante dos relacionados sem pergunta; dúvida `fit` mais fundo ainda vale com o ramo mantido", async () => {
    const id = await start();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML e emitir invoices", description: "Faturas e login" });
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "Invoices" ? 0.9 : 0, sameRequest: 0.1 }]));
    h.judge().verdict = (input) => {
      const titles = input.candidates.map((c) => c.title);
      if (titles.includes("SSO") && titles.includes("Billing")) return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c) => [c.id, c.title === "SSO" ? 0.9 : 0.1])) };
      const n = input.candidates.length;
      return { belongs: input.current?.title === "Auth" ? 0.5 : 0.95, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, n === 1 ? 1 : i === 0 ? 0.9 : 0.1 / (n - 1)])) };
    };
    const res = await placement(id);
    // O relacionado fica em Billing, a escolha confiante fica com SSO, e "cabe em Auth?" = 0,5 continua sendo dúvida.
    expect(res.body.question).toMatchObject({ kind: "fit", at: { id: tree.auth } });
  });
});

describe("POST /placement — a bifurcação entre a descida e o vencedor dos relacionados", () => {
  /**
   * Raiz com Auth e Billing; em Auth, SSO (a descida: 0,8) e Senhas (0,1, filho Reset); relacionados com pai em Senhas e em Billing.
   * A escolha entre SSO, Senhas e Billing (ancestral comum: a raiz) sai confiante em `winner`; Auth vale `auth` no primeiro nível.
   */
  const scenario = async (auth: number, winner: "SSO" | "Senhas") => {
    const id = await start();
    const senhas = (await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A', $1, 60, $2, 'Senhas', $3) returning id", [priv(), tree.auth, h.world().people.manager])).rows[0]?.id ?? "";
    await h.pool.query("insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A', $1, 61, $2, 'Reset', $3)", [priv(), senhas, h.world().people.manager]);
    await h.pool.query("update projects set next_ticket_number = 62 where id = $1", [priv()]);
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Resetar senha e emitir invoices", description: "Faturas e senhas" });
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === "Reset" ? 0.95 : c.title === "Invoices" ? 0.9 : 0, sameRequest: 0.1 }]));
    h.judge().verdict = (input) => {
      const titles = input.candidates.map((c) => c.title);
      if (titles.includes("SSO") && titles.includes("Senhas") && titles.includes("Billing")) return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c) => [c.id, c.title === winner ? 0.9 : 0.05])) };
      const odds: Record<string, number> = input.current === null ? { Auth: auth, Billing: 0.2 } : { SSO: 0.8, Senhas: 0.1 };
      return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((c) => [c.id, odds[c.title] ?? 0.9])) };
    };
    return { id, senhas };
  };

  it("vencedor Senhas (A2) com Auth confiante na raiz: não pergunta `which` em Auth, e o destino é Senhas", async () => {
    const { id, senhas } = await scenario(0.9, "Senhas");
    const res = await placement(id);
    expect(res.body.question).toBeNull();
    expect(res.body.destinationConfirmed).toBe(true);
    expect(res.body.destination.parentId).toBe(senhas);
  });

  it("vencedor Senhas (A2) com Auth em 0,3 na raiz: a dúvida é a da raiz (`which`, nível 1), não a de Auth", async () => {
    const { id } = await scenario(0.3, "Senhas");
    const res = await placement(id);
    expect(res.body.question).toMatchObject({ kind: "which", level: 1, at: { id: null } });
  });

  it("vencedor SSO (o da descida) com Auth em 0,3 na raiz: o `which` da raiz continua valendo e pergunta", async () => {
    const { id } = await scenario(0.3, "SSO");
    const res = await placement(id);
    expect(res.body.question).toMatchObject({ kind: "which", level: 1, at: { id: null } });
    expect(res.body.destination.parentId).toBe(tree.sso);
  });
});

describe("POST /placement — a decisão não pôde ser guardada", () => {
  const withoutTable = async <T>(run: () => Promise<T>): Promise<T> => {
    await h.pool.query("alter table placement_decisions rename to placement_decisions_off");
    try {
      return await run();
    } finally {
      await h.pool.query("alter table placement_decisions_off rename to placement_decisions");
    }
  };

  it("sem pergunta: a resposta sai com `destinationConfirmed: false` (o destino é só um palpite)", async () => {
    const id = await start();
    const res = await withoutTable(() => placement(id));
    expect(res.status).toBe(201);
    expect(res.body.question).toBeNull();
    expect(res.body.destinationConfirmed).toBe(false);
    expect(res.body.destination.parentId).toBe(tree.sso);
  });

  it("com pergunta: sai sem pergunta e sem confirmação, em vez de uma pergunta que a criação depois recusaria", async () => {
    const id = await start();
    verdicts({ root: { belongs: 0.1, choice: [0.2, 0.8] } });
    const res = await withoutTable(() => placement(id));
    expect(res.status).toBe(201);
    expect(res.body.question).toBeNull();
    expect(res.body.destinationConfirmed).toBe(false);
  });

  it("com a decisão guardada, a mesma procura confirma (o contraste do teste acima)", async () => {
    const id = await start();
    expect((await placement(id)).body.destinationConfirmed).toBe(true);
  });
});

describe("POST /placement — startId inválido é 400", () => {
  const invalid = async (id: string, body: object) => {
    const res = await placement(id, body);
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe("invalid_start");
  };

  it("cancelado, ideia, dentro de ideia, outro projeto, inexistente e fora do escopo", async () => {
    const id = await start();
    const add = async (title: string, parent: string | null, extra: { status?: string; idea?: string }): Promise<string> =>
      (await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id, status, idea_stage) values ('org_A', $1, $2, $3, $4, $5, $6, $7) returning id", [priv(), nextNumber++, parent, title, h.world().people.manager, extra.status ?? "todo", extra.idea ?? null])).rows[0]?.id as string;
    let nextNumber = 60;
    const cancelled = await add("Cancelado", null, { status: "cancelled" });
    const idea = await add("Ideia", null, { idea: "new" });
    const insideIdea = await add("Dentro", idea, {});
    await invalid(id, { startId: cancelled });
    await invalid(id, { startId: idea });
    await invalid(id, { startId: insideIdea });
    await invalid(id, { startId: "00000000-0000-4000-8000-000000000000" });
    const other = (await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 1, 'De outro projeto', $2) returning id", [h.world().projects.org, h.world().people.manager])).rows[0]?.id;
    expect(other).toBeDefined();
    await invalid(id, { startId: other });
    await invalid(id, { scopeId: tree.auth, startId: tree.billing });
    // Dentro do escopo vale, e a procura parte dali: o nível conta a partir da raiz e as opções são os filhos do ponto de partida.
    verdicts({ Auth: { belongs: 0.5 } });
    const atScope = await placement(id, { scopeId: tree.auth, startId: tree.auth });
    expect(atScope.status).toBe(201);
    expect(atScope.body.question).toMatchObject({ kind: "fit", level: 2, at: { id: tree.auth } });
    expect(optionIds(atScope)).toEqual([tree.sso]);
    verdicts({});
    const inside = await placement(id, { scopeId: tree.auth, startId: tree.sso });
    expect(inside.status).toBe(201);
    expect(inside.body).toMatchObject({ question: null, destinationConfirmed: true });
    expect(inside.body.destination.parentId).toBe(tree.sso);
    expect((await placement(id, { startId: 42 })).status).toBe(400);
  });

  it("o corpo é estrito: o contrato antigo (answers, supportsQuestions) é recusado", async () => {
    const id = await start();
    expect((await placement(id, { answers: [] })).status).toBe(400);
    expect((await placement(id, { supportsQuestions: true })).status).toBe(400);
  });
});

describe("POST /ticket — `placedBy` (ADR 0054, adendo)", () => {
  const stale = async (id: string, parentId: string | null) => {
    const res = await create(id, { parentId, placedBy: "search" });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("placement_stale");
  };

  it("`placedBy` é obrigatório e só aceita os cinco valores", async () => {
    const id = await start();
    expect((await create(id, { parentId: null })).status).toBe(400);
    expect((await create(id, { parentId: null, placedBy: "qualquer" })).status).toBe(400);
    expect((await create(id, { parentId: null, chosenByPerson: true, placedBy: "map" })).status).toBe(400);
  });

  it("`search` aceito no destino confirmado; guarda `placed_by` na decisão (que passa ao ticket)", async () => {
    const id = await start();
    const found = await placement(id);
    expect(found.body.destinationConfirmed).toBe(true);
    const created = await create(id, { parentId: found.body.destination.parentId, placedBy: "search" });
    expect(created.status).toBe(201);
    expect(await placedByOf(created.body.ticket.id)).toBe("search");
  });

  it("`search` recusado com 409 `placement_stale`: destino diferente, pergunta aberta, rascunho mudou, sem decisão e raiz", async () => {
    // Sem decisão guardada.
    const id = await start();
    const none = await another();
    await stale(none, tree.sso);
    // Destino diferente do confirmado.
    const found = await placement(id);
    expect(found.body.destination.parentId).toBe(tree.sso);
    await stale(id, tree.billing);
    // O rascunho mudou depois da procura (título; e também ser ideia).
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Outro título", description: "x" });
    await stale(id, tree.sso);
    const again = await placement(id);
    expect((await create(id, { parentId: again.body.destination.parentId, placedBy: "search" })).status).toBe(201);
    const idea = await another();
    const ideaFound = await placement(idea);
    // Só `idea` muda: título e descrição ficam como a conversa os tem.
    const draft = (await h.call("GET", `/api/ticket-conversations/${idea}`, as("contributor"))).body.draft as { title: string; description: string };
    await h.call("PATCH", `/api/ticket-conversations/${idea}/draft`, as("contributor"), { title: draft.title, description: draft.description, idea: true });
    await stale(idea, ideaFound.body.destination.parentId);
    // Pergunta aberta: o palpite não é destino confirmado, nem a raiz.
    const asked = await another();
    verdicts({ root: { belongs: 0.1 } });
    const question = await placement(asked);
    expect(question.body.question).not.toBeNull();
    await stale(asked, question.body.destination.parentId);
    await stale(asked, null);
    await stale(asked, tree.auth);
    // Pergunta aberta com o palpite FORA da raiz (`fit` em Auth): o palpite também não vale como destino confirmado.
    const deep = await another();
    verdicts({ Auth: { belongs: 0.5 } });
    const fit = await placement(deep);
    expect(fit.body.question).toMatchObject({ kind: "fit", at: { id: tree.auth } });
    expect(fit.body.destination.parentId).not.toBeNull();
    await stale(deep, fit.body.destination.parentId);
  });

  it("`stay`, `map`, `recent` e `option` valem na raiz e fora dela, mesmo com pergunta aberta", async () => {
    await start();
    verdicts({ root: { belongs: 0.1 } });
    for (const placedBy of ["stay", "map", "recent", "option"] as const) {
      for (const parentId of [null, tree.auth]) {
        const fresh = await another();
        await placement(fresh);
        const res = await create(fresh, { parentId, placedBy });
        expect(res.status).toBe(201);
        expect(await placedByOf(res.body.ticket.id)).toBe(placedBy);
      }
    }
  });

  it("sem decisão guardada, os tipos da pessoa criam e não gravam nada", async () => {
    const id = await start();
    const res = await create(id, { parentId: tree.auth, placedBy: "map" });
    expect(res.status).toBe(201);
    expect(await placedByOf(res.body.ticket.id)).toBeUndefined();
  });

  it("sem a coluna `placed_by` (0032 ainda não aplicada): a procura guarda, a leitura segue com o resto intacto (e sem `placedBy`) e a criação por `search` funciona", async () => {
    const id = await start();
    await h.pool.query("alter table placement_decisions drop column placed_by");
    try {
      const found = await placement(id);
      expect(found.status).toBe(201);
      const read = await h.call("GET", `/api/ticket-conversations/${id}/placement-decision`, as("contributor"));
      expect(read.status).toBe(200);
      expect(read.body.decision).toMatchObject({ doubt: { confirmed: true, question: null }, chosenPath: [tree.auth, tree.sso] });
      expect(read.body.decision).not.toHaveProperty("placedBy");
      const created = await create(id, { parentId: found.body.destination.parentId, placedBy: "search" });
      expect(created.status).toBe(201);
    } finally {
      await h.pool.query(`alter table placement_decisions add column placed_by text,
        add constraint placement_decisions_placed_by_check check (placed_by in ('search', 'option', 'stay', 'recent', 'map'))`);
      await h.pool.query("grant update (placed_by) on table placement_decisions to treepm_app");
    }
  });
  it("sem a coluna `triage` (0031 ainda não aplicada) a decisão fica sem a dúvida: a procura não confirma nem pergunta", async () => {
    const id = await start();
    verdicts({ root: { belongs: 0.1 } });
    await h.pool.query("alter table placement_decisions drop column triage");
    try {
      const res = await placement(id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ question: null, destinationConfirmed: false });
      const created = await create(id, { parentId: tree.auth, placedBy: "search" });
      expect(created.status).toBe(409);
    } finally {
      await h.pool.query(`alter table placement_decisions add column triage jsonb not null default '{}'`);
      await h.pool.query("grant select, insert, update on table placement_decisions to treepm_app");
    }
  });
});

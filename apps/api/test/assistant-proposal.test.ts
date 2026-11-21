import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedGroups, seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;

const open = async (who: Who = "contributor") =>
  (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message: "Quero corrigir o login" })).body.id as string;
const placement = (id: string, body?: unknown) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), body);
const projectName = async () => (await rows("select name from projects where id = $1", [priv()]))[0].name as string;
const addTicket = async (title: string, parentId: string | null, description = "") => {
  const number = (await rows("select next_ticket_number as n from projects where id = $1", [priv()]))[0].n as number;
  await h.pool.query("update projects set next_ticket_number = next_ticket_number + 1 where id = $1", [priv()]);
  return (
    await rows(
      "insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5,$6) returning id",
      [priv(), number, parentId, title, description, h.world().people.manager],
    )
  )[0].id as string;
};
/** O juiz do ramo diz que o rascunho não cabe em nenhum agrupador: a procura termina na raiz. */
const settleAtRoot = () => {
  h.judge().verdict = (input) => ({ belongs: 0.1, choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0.5])) });
};
const affinityScores = (byId: Record<string, number>) => {
  h.affinity().verdict = (input) => Object.fromEntries(input.tickets.map((t) => [t.id, byId[t.id] ?? 0.1]));
};

let tree: Tree;
const start = async () => {
  tree = await seedTree(h.pool, h.world());
  return open();
};

describe("placement — proposta de agrupador na raiz", () => {
  it("destino na raiz com ticket solto afim: devolve a proposta com o nome do Claude e os tickets em ordem de número", async () => {
    const id = await start();
    const second = await addTicket("Outro solto", null, "Texto do outro");
    settleAtRoot();
    affinityScores({ [tree.loose]: 0.9, [second]: 0.8 });
    h.namer().reply = () => ({ title: "Soltos juntos", description: "Reúne os dois soltos." });
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(res.body.groupProposal).toEqual({
      title: "Soltos juntos",
      description: "Reúne os dois soltos.",
      tickets: [
        { id: tree.loose, number: 7, title: "Solto" },
        { id: second, number: 8, title: "Outro solto" },
      ],
    });
    expect(res.body.groupProposalSkipped).toBeNull();
  });

  it("a afinidade vai ao Jev com o nome do projeto como destino e o rascunho", async () => {
    const id = await start();
    settleAtRoot();
    await placement(id);
    expect(h.affinity().calls).toHaveLength(1);
    expect(h.affinity().calls[0]).toEqual({
      draft: { title: "Rascunho 1", description: "Quero corrigir o login" },
      destination: { title: await projectName() },
      tickets: [{ id: tree.loose, title: "Solto", descriptionExcerpt: "" }],
    });
  });

  it("na raiz, todos os soltos afins formam proposta (a regra de repetir o agrupador não vale)", async () => {
    const id = await start();
    settleAtRoot();
    affinityScores({ [tree.loose]: 0.95 });
    const res = await placement(id);
    expect(res.body.groupProposal.tickets.map((t: { id: string }) => t.id)).toEqual([tree.loose]);
    expect(h.namer().calls[0]).toMatchObject({ newTicket: { title: "Rascunho 1" }, existingTickets: [{ title: "Solto" }] });
  });

  it("ninguém passa do limiar: sem proposta e sem motivo, e o Claude não é chamado", async () => {
    const id = await start();
    settleAtRoot();
    affinityScores({ [tree.loose]: 0.7 });
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.groupProposal).toBeNull();
    expect(res.body.groupProposalSkipped).toBeNull();
    expect(h.namer().calls).toHaveLength(0);
  });
});

describe("placement — proposta de agrupador dentro de um agrupador", () => {
  it("o destino leva título e resumo do agrupador; o resumo é escrito se faltar", async () => {
    const id = await start();
    const extra = await addTicket("Parser de XML", tree.sso);
    affinityScores({ [tree.saml]: 0.9 });
    const res = await placement(id);
    expect(res.body.destination.parentId).toBe(tree.sso);
    expect(h.affinity().calls[0]?.destination).toEqual({ title: "SSO", summary: "Resumo de SSO" });
    expect(h.affinity().calls[0]?.tickets.map((t) => t.id)).toEqual([tree.saml, extra]);
    expect(res.body.groupProposal.tickets.map((t: { id: string }) => t.id)).toEqual([tree.saml]);
  });

  it("o destino com texto guardado (da pessoa) leva esse texto à afinidade, sem chamar o resumidor para ele", async () => {
    const id = await start();
    await addTicket("Parser de XML", tree.sso);
    await h.pool.query(
      "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model, edited_by_person_id) values ('org_A', $1, $2, 'Entrada com a conta da empresa', 'pessoa', 'person', null, $3)",
      [priv(), tree.sso, h.world().people.manager],
    );
    affinityScores({ [tree.saml]: 0.9 });
    await placement(id);
    expect(h.affinity().calls[0]?.destination).toEqual({ title: "SSO", summary: "Entrada com a conta da empresa" });
    expect(h.summarizer().calls.map((c) => c.title)).not.toContain("SSO");
  });

  it("todos os soltos do agrupador passam: same_as_destination, sem chamar o Claude", async () => {
    const id = await start();
    affinityScores({ [tree.saml]: 0.99 });
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.groupProposal).toBeNull();
    expect(res.body.groupProposalSkipped).toBe("same_as_destination");
    expect(h.namer().calls).toHaveLength(0);
  });
});

describe("placement — quando a proposta nem é verificada", () => {
  it("resultado incerto: nenhum provedor da proposta é chamado e o motivo é not_settled", async () => {
    const id = await start();
    h.judge().verdict = (input) => ({ belongs: 0.5, choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0.5])) });
    const res = await placement(id);
    expect(res.body.uncertain).toBe(true);
    expect(res.body.groupProposal).toBeNull();
    expect(res.body.groupProposalSkipped).toBe("not_settled");
    expect(h.affinity().calls).toHaveLength(0);
    expect(h.namer().calls).toHaveLength(0);
  });

  it("fora do escopo: not_settled, sem provedor", async () => {
    const id = await start();
    h.judge().verdict = (input) => ({ belongs: 0.9, choice: {}, ...(input.scope ? { scopeFit: 0.1 } : {}) });
    const res = await placement(id, { scopeId: tree.billing });
    expect(res.body.scope.outOfScope).toBe(true);
    expect(res.body.groupProposalSkipped).toBe("not_settled");
    expect(h.affinity().calls).toHaveLength(0);
  });

  it("destino sem tickets soltos: no_loose_tickets, sem provedor", async () => {
    await seedGroups(h.pool, h.world(), [{ title: "Acesso" }, { title: "Cobrança" }]);
    const id = await open();
    settleAtRoot();
    const res = await placement(id);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(res.body.groupProposalSkipped).toBe("no_loose_tickets");
    expect(h.affinity().calls).toHaveLength(0);
    expect(h.namer().calls).toHaveLength(0);
  });

  it("soltos demais para caber na requisição: too_large, sem provedor", async () => {
    const id = await start();
    await h.pool.query(
      `insert into tickets (org_id, project_id, number, title, created_by_person_id)
       select 'org_A', $1, 100 + g, repeat('t', 200), $2 from generate_series(1, 800) g`,
      [priv(), h.world().people.manager],
    );
    settleAtRoot();
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.groupProposalSkipped).toBe("too_large");
    expect(h.affinity().calls).toHaveLength(0);
  });
});

describe("placement — falha da proposta não derruba a procura", () => {
  it.each([
    ["a afinidade falha", () => (h.affinity().fail = true)],
    ["o nome falha", () => ((h.namer().fail = true), affinityScores({ ...{}, [tree.loose]: 0.9 }))],
  ])("%s: 201 com a procura normal e unavailable", async (_n, arrange) => {
    const id = await start();
    settleAtRoot();
    arrange();
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(res.body.groupProposal).toBeNull();
    expect(res.body.groupProposalSkipped).toBe("unavailable");
  });

  it("nome inválido do Claude: invalid_name", async () => {
    const id = await start();
    settleAtRoot();
    affinityScores({ [tree.loose]: 0.9 });
    h.namer().reply = () => ({ title: "", description: "x" });
    expect((await placement(id)).body.groupProposalSkipped).toBe("invalid_name");
  });

  it("nenhuma transação fica aberta durante as chamadas da proposta", async () => {
    const id = await start();
    settleAtRoot();
    affinityScores({ [tree.loose]: 0.9 });
    const open: number[] = [];
    const probe = async () => {
      open.push((await rows("select count(*)::int as n from pg_stat_activity where usename = 'treepm_app' and state like 'idle in transaction%'"))[0].n);
    };
    h.affinity().onCall = probe;
    h.namer().onCall = probe;
    await placement(id);
    expect(open).toEqual([0, 0]);
  });
});

describe("placement — a resposta não traz probabilidades", () => {
  it("nem as da afinidade, nem as do escopo, nem as do juiz", async () => {
    const id = await start();
    h.judge().verdict = (input) => ({
      belongs: 0.9123,
      choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0.8456])),
      ...(input.scope ? { scopeFit: 0.7789 } : {}),
    });
    affinityScores({ [tree.saml]: 0.9567, [tree.loose]: 0.9567 });
    const res = await placement(id, { scopeId: tree.auth });
    expect(res.status).toBe(201);
    const text = JSON.stringify(res.body);
    for (const value of ["0.9123", "0.8456", "0.7789", "0.9567"]) expect(text).not.toContain(value);
    expect(text).not.toMatch(/"fit"|noul|probab/i);
    expect(res.body.scope).toEqual({ id: tree.auth, title: "Auth", outOfScope: false });
    expect(Object.keys(res.body).sort()).toEqual(
      ["alternatives", "destination", "discarded", "groupProposal", "groupProposalSkipped", "scope", "stoppedEarly", "uncertain"],
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { recordQueries } from "./query-recorder.js";
import { as } from "./world.js";

// ADR 0052, item 1 e item 3: o texto do candidato é montado na hora, em uma leitura da árvore, e a procura não escreve nada.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const open = async () =>
  (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
const placement = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"));
let tree: Tree;
afterEach(() => vi.restoreAllMocks());

describe("procura com o ramo montado na hora", () => {
  it("o juiz vê o trecho da descrição e os títulos dos descendentes, nível por nível", async () => {
    tree = await seedTree(h.pool, h.world());
    expect((await placement(await open())).status).toBe(201);
    const auth = h.judge().calls[0]?.candidates.find((c) => c.title === "Auth");
    expect(auth?.summary).toBe("Tudo sobre entrar no sistema\nContém: Login; SSO\nDentro deles: SAML");
    expect(h.judge().calls[1]?.current).toEqual({ title: "Auth", summary: auth?.summary });
  });

  it("não chama o resumidor, não escreve em branch_summaries e ignora texto de origem 'assistente'", async () => {
    tree = await seedTree(h.pool, h.world());
    h.summarizer().fail = true; // chamar o resumidor derrubaria a procura com 503
    await h.pool.query(
      "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model) values ('org_A', $1, $2, 'TEXTO VELHO DO ASSISTENTE', 'm', 'assistant', 'x')",
      [priv(), tree.auth],
    );
    const before = await rows("select ticket_id, summary, updated_at from branch_summaries order by ticket_id");
    const res = await placement(await open());
    expect(res.status).toBe(201);
    expect(h.summarizer().calls).toHaveLength(0);
    expect(await rows("select ticket_id, summary, updated_at from branch_summaries order by ticket_id")).toEqual(before);
    expect(JSON.stringify(h.judge().calls)).not.toContain("TEXTO VELHO");
  });

  it("a nota escrita por pessoa entra antes dos descendentes", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query(
      "insert into branch_summaries (org_id, project_id, ticket_id, summary, content_mark, source, model, edited_by_person_id) values ('org_A', $1, $2, 'Cobrança de clientes', 'p', 'person', null, $3)",
      [priv(), tree.billing, h.world().people.manager],
    );
    await placement(await open());
    expect(h.judge().calls[0]?.candidates.find((c) => c.title === "Billing")?.summary).toBe("Nota: Cobrança de clientes\nContém: Invoices");
  });

  it("mover um ticket muda o texto dos dois ramos na procura seguinte, sem escrita", async () => {
    tree = await seedTree(h.pool, h.world());
    await placement(await open());
    const first = h.judge().calls[0]?.candidates.map((c) => c.summary);
    h.judge().calls.length = 0;
    await h.pool.query("update tickets set parent_id = $1 where id = $2", [tree.billing, tree.login]);
    await placement(await open());
    const second = h.judge().calls[0]?.candidates.map((c) => c.summary);
    expect(second).not.toEqual(first);
    expect(second?.[0]).not.toContain("Login");
    expect(second?.[1]).toContain("Login");
    expect(await rows("select 1 from branch_summaries")).toHaveLength(0);
  });
});

describe("custo: uma leitura da árvore por procura", () => {
  const seedMany = async (count: number) => {
    // Raízes com 9 filhos cada: cada raiz é um candidato com filhos. `number` começa depois dos já usados.
    await h.pool.query(
      `insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id)
       select 'org_A', $1, 1 + g, case when g % 10 = 0 then null else (select id from tickets where project_id = $1 and number = 1 + (g / 10) * 10) end, 'T' || g, $2
       from generate_series(0, $3 - 1) g order by g`,
      [priv(), h.world().people.manager, count],
    );
    await h.pool.query("update projects set next_ticket_number = $2 where id = $1", [priv(), count + 1]);
  };
  const costOfSearch = async (count: number) => {
    await h.pool.query("delete from tickets where project_id = $1", [priv()]);
    await seedMany(count);
    const id = await open();
    const { queries } = await recordQueries(() => placement(id));
    const text = (q: { text: string }) => q.text.toLowerCase();
    return {
      onTickets: queries.filter((q) => /from "?public"?\."?tickets"?|from tickets/.test(text(q))).length,
      onSummaries: queries.filter((q) => /branch_summaries/.test(text(q))).length,
      total: queries.length,
    };
  };

  it("o número de consultas à árvore e às notas não cresce com 300 ou 3.000 tickets", async () => {
    const small = await costOfSearch(300);
    const big = await costOfSearch(3000);
    expect(small.onTickets).toBeGreaterThan(0);
    expect(big.onTickets).toBe(small.onTickets);
    expect(big.onSummaries).toBe(small.onSummaries);
    expect(big.onSummaries).toBeLessThanOrEqual(1);
    expect(big.total).toBe(small.total);
  }, 60_000);
});

describe("revisão 1, ponto 3: o cancelado sai da árvore da procura, uma vez só", () => {
  const ins = async (number: number, title: string, parentId: string | null, status = "todo") =>
    (await h.pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, parent_id, title, status, created_by_person_id) values ('org_A', $1, $2, $3, $4, $5, $6) returning id",
      [priv(), number, parentId, title, status, h.world().people.manager],
    )).rows[0]!.id;
  const candidates = () => h.judge().calls.flatMap((c) => c.candidates.map((x) => x.title));

  it("um ticket cancelado com filhos vivos não é candidato", async () => {
    const dead = await ins(1, "Cancelado com filhos", null, "cancelled");
    await ins(2, "Filho vivo", dead);
    const live = await ins(3, "Vivo", null);
    await ins(4, "Filho do vivo", live);
    await placement(await open());
    expect(candidates()).toEqual(["Vivo"]);
  });

  it("os filhos de um cancelado não aparecem no texto de ninguém nem como destino", async () => {
    const live = await ins(1, "Vivo", null);
    const dead = await ins(2, "Cancelado", live, "cancelled");
    await ins(3, "Neto do cancelado", dead);
    await ins(4, "Outro filho", live);
    const res = await placement(await open());
    expect(JSON.stringify(h.judge().calls)).not.toContain("Neto do cancelado");
    expect(JSON.stringify(h.judge().calls)).not.toContain("Cancelado");
    expect(JSON.stringify(res.body)).not.toContain("Neto do cancelado");
  });

  it("um candidato que fica sem nenhum descendente vivo deixa de ser candidato", async () => {
    const empty = await ins(1, "Só cancelados", null);
    await ins(2, "Cancelado A", empty, "cancelled");
    await ins(3, "Cancelado B", empty, "cancelled");
    await placement(await open());
    expect(h.judge().calls).toHaveLength(0);
  });

  it("um cancelado não pode ser escopo da procura (404)", async () => {
    const dead = await ins(1, "Cancelado", null, "cancelled");
    await ins(2, "Filho", dead);
    const id = await open();
    expect((await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), { scopeId: dead })).status).toBe(404);
  });
});

describe("revisão 1, ponto 2: ler o texto do ramo não lê o projeto inteiro", () => {
  const rowsRead = async (total: number) => {
    await h.pool.query("delete from tickets where project_id = $1", [priv()]);
    const root = (await h.pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ('org_A', $1, 1, 'Raiz', 'Trecho', $2) returning id",
      [priv(), h.world().people.manager],
    )).rows[0]!.id;
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) select 'org_A', $1, 1 + g, $3, 'Filho ' || g, $2 from generate_series(1, 5) g",
      [priv(), h.world().people.manager, root],
    );
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) select 'org_A', $1, 10 + g, 'Outro ' || g, repeat('x', 5000), $2 from generate_series(1, $3::int) g",
      [priv(), h.world().people.manager, total - 6],
    );
    const { result, rows, chars } = await recordQueries(() => h.call("GET", `/api/tickets/${root}/summary`, as("contributor")));
    expect(result.status).toBe(200);
    expect(result.body.summary.text).toBe("Trecho\nContém: Filho 1; Filho 2; Filho 3; Filho 4; Filho 5");
    return { rows, chars };
  };

  it("com 5 descendentes, num projeto de 300 e de 3.000 tickets, lê o mesmo número de linhas", async () => {
    const small = await rowsRead(300);
    const big = await rowsRead(3000);
    // Folga pequena e fixa (consultas de rotina variam de uma chamada a outra); ler o projeto inteiro seria 2.700 linhas a mais.
    expect(Math.abs(big.rows - small.rows)).toBeLessThanOrEqual(10);
    expect(Math.abs(big.chars - small.chars)).toBeLessThanOrEqual(small.chars * 0.02);
  }, 60_000);
});

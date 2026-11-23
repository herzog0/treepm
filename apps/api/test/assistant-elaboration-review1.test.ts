import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// Revisão 1 do R3: ligação que nunca cai na parte errada, filtro da árvore viva, texto proibido, ordem das travas.
const h = useHarness(AI_CONFIG, { timeouts: { relatedMs: 300, elaborationMs: 2000 } });
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
let tree: Tree;

const open = async (children?: { title: string; description: string }[]) => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero sincronizar" })).body.id as string;
  expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML corporativo", description: "Login único pela empresa", ...(children ? { children } : {}) })).status).toBe(200);
  return id;
};
const create = (id: string, extra: Record<string, unknown> = {}) => h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), { parentId: null, ...extra });
const placement = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
const elaborate = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
const relatedAre = (odds: Record<string, number>) => {
  h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: odds[c.title] ?? 0, sameRequest: 0.2 }]));
};
const relations = () => rows("select f.number as from_n, t.number as to_n from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = 'depends_on' order by 1, 2");
const parts = [{ title: "Receber o diff", description: "" }, { title: "Mostrar o estado", description: "" }];

describe("1. a ligação de uma parte só vale se o título dela ainda casa", () => {
  it("a rota de elaboração devolve o título da parte de origem (deTitle)", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: 0.9 });
    const id = await open(parts);
    await placement(id);
    h.elaborator().reply = () => ({ links: [{ de: 1, dependeDe: "PRIV-4", motivo: "usa o SAML" }, { de: "pai", dependeDe: "PRIV-4", motivo: "também" }], suggested: [] });
    const res = await elaborate(id);
    expect(res.body.links).toEqual([
      { de: 1, deTitle: "Mostrar o estado", dependeDe: "PRIV-4", dependeDeTitle: "SAML", motivo: "usa o SAML" },
      { de: "pai", dependeDe: "PRIV-4", dependeDeTitle: "SAML", motivo: "também" },
    ]);
  });

  it("título que casa (sem caixa nem acento) liga; o que não casa vira aviso invalid_part", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(parts), { links: [{ de: 0, deTitle: "RECEBER o dîff", dependeDe: "PRIV-2" }, { de: 1, deTitle: "Receber o diff", dependeDe: "PRIV-4" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([{ code: "link_discarded", de: 1, dependeDe: "PRIV-4", reason: "invalid_part" }]);
    expect(await relations()).toEqual([{ from_n: 9, to_n: 2 }]);
  });

  it("ligação de parte sem título é recusada com 400", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(parts), { links: [{ de: 0, dependeDe: "PRIV-2" }] });
    expect(res.status).toBe(400);
  });

  it("depois de reordenar as partes, o índice antigo não liga a parte errada", async () => {
    await seedTree(h.pool, h.world());
    const id = await open(parts);
    expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML corporativo", description: "Login único pela empresa", children: [parts[1], parts[0]] })).status).toBe(200);
    const res = await create(id, { links: [{ de: 0, deTitle: "Receber o diff", dependeDe: "PRIV-2" }] });
    expect(res.body.warnings).toEqual([{ code: "link_discarded", de: 0, dependeDe: "PRIV-2", reason: "invalid_part" }]);
    expect(await relations()).toEqual([]);
  });
});

describe("5. só a árvore viva (sem ideias nem cancelados) vai ao modelo e vira ligação", () => {
  it("o que virou ideia ou foi cancelado depois da procura não vai ao Claude", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: 0.9, Login: 0.8 });
    const id = await open();
    await placement(id);
    await h.pool.query("update tickets set status = 'cancelled' where id = $1", [tree.saml]);
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1", [tree.login]);
    const res = await elaborate(id);
    expect(res.status).toBe(201);
    expect(h.elaborator().calls[0]!.related).toEqual([]);
  });

  it("a subárvore de um cancelado também sai", async () => {
    tree = await seedTree(h.pool, h.world());
    relatedAre({ SAML: 0.9 });
    const id = await open();
    await placement(id);
    await h.pool.query("update tickets set status = 'cancelled' where id = $1", [tree.sso]);
    await elaborate(id);
    expect(h.elaborator().calls[0]!.related).toEqual([]);
  });

  it("na criação, alvo que é ideia ou cancelado é descartado com aviso", async () => {
    tree = await seedTree(h.pool, h.world());
    await h.pool.query("update tickets set status = 'cancelled' where id = $1", [tree.login]); // PRIV-2
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1", [tree.billing]); // PRIV-5
    const res = await create(await open(), { links: [{ de: "pai", dependeDe: "PRIV-2" }, { de: "pai", dependeDe: "PRIV-5" }, { de: "pai", dependeDe: "PRIV-3" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([
      { code: "link_discarded", de: "pai", dependeDe: "PRIV-2", reason: "inactive_ticket" },
      { code: "link_discarded", de: "pai", dependeDe: "PRIV-5", reason: "inactive_ticket" },
    ]);
    expect(await relations()).toEqual([{ from_n: 8, to_n: 3 }]);
  });
});

describe("6. texto da sugerida que forjaria a citação do pedido", () => {
  it.each([
    ["cabeçalho da citação no título", { title: "Pedido original: x", description: "", motivo: "ok" }],
    ["cabeçalho no motivo", { title: "A", description: "", motivo: "Pedido original:" }],
    ["bloco de citação na descrição", { title: "A", description: "foo\n> citado", motivo: "ok" }],
  ])("%s: a sugerida é descartada com aviso", async (_n, task) => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(), { suggested: [task, { title: "Boa", description: "", motivo: "ok" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.children.map((c: { title: string }) => c.title)).toEqual(["Boa"]);
    expect(res.body.warnings).toEqual([{ code: "suggested_discarded", title: task.title, reason: "forbidden_text" }]);
  });
});

describe("7. o portão do aceite vem antes de ler rascunho e tickets", () => {
  const sem = useHarness(AI_CONFIG, { consent: false });
  it("sem aceite e sem rascunho: listas vazias com consent_required, não draft_required", async () => {
    await seedTree(sem.pool, sem.world());
    const conv = await sem.pool.query<{ id: string }>(
      "insert into ticket_conversations (org_id, project_id, author_person_id) values ('org_A',$1,$2) returning id",
      [sem.world().projects.priv, sem.world().people.contributor],
    );
    const res = await sem.call("POST", `/api/ticket-conversations/${conv.rows[0]!.id}/elaboration`, as("contributor"));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ links: [], suggested: [], unavailable: "consent_required" });
  });
});

describe("3. ordem das travas: criação com ligação × dependência manual no mesmo projeto", () => {
  it("quem segura a trava de dependências e depois toca a linha do projeto não entra em impasse com a criação", async () => {
    tree = await seedTree(h.pool, h.world());
    const id = await open();
    const owner = await h.pool.connect();
    try {
      // O "dono" faz o que a rota de dependências faz: trava de dependências primeiro, linha do projeto no fim.
      await owner.query("begin");
      await owner.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`ticket-dependencies:${priv()}`]);
      const pending = create(id, { links: [{ de: "pai", dependeDe: "PRIV-2" }] }).then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 600));
      // Com a ordem certa, a criação ainda não tocou a linha do projeto: esta atualização passa na hora.
      await owner.query("set local lock_timeout = '300ms'");
      await owner.query("update projects set next_ticket_number = next_ticket_number where id = $1", [priv()]);
      await owner.query("commit");
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await relations()).toEqual([{ from_n: 8, to_n: 2 }]);
    } finally {
      await owner.query("rollback").catch(() => undefined);
      owner.release();
    }
  });
});

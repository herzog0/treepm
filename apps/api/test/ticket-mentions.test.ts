import { withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { describe, expect, it } from "vitest";
import { PRISMA } from "../src/db/prisma.provider.js";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { ORG, as } from "./world.js";

// ADR 0037, fatia 2: a ligação "menciona" é derivada da descrição e gravada em todo caminho que grava descrição.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const open = () => h.world().projects.org;
type Body = Record<string, unknown>;
type Mention = { id: string; key: string; title: string; status: string };

const create = (body: Body, project = priv()) => h.call("POST", `/api/projects/${project}/tickets`, as("admin"), { title: "T", ...body });
const add = async (body: Body = {}, project = priv()): Promise<{ id: string; number: number; key: string }> => {
  const res = await create(body, project);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
const patch = (id: string, body: Body) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), body);
const get = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body as { mentionedBy: Mention[] };
const relations = async (kind = "mentions") =>
  (await h.pool.query("select r.id, r.created_at, f.number as from_number, t.number as to_number, r.kind from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = $1 order by f.number, t.number", [kind])).rows as { id: string; created_at: Date; from_number: number; to_number: number; kind: string }[];
const pairs = async () => (await relations()).map((row) => `${row.from_number}>${row.to_number}`);

describe("criar e alterar gravam a ligação menciona", () => {
  it("criar com chave de ticket existente grava a ligação, sem evento de atividade novo", async () => {
    await add();
    const before = Number((await h.pool.query("select count(*) from activity_events")).rows[0].count);
    await add({ description: "Depende do que está em PRIV-1." });
    expect(await pairs()).toEqual(["2>1"]);
    expect(Number((await h.pool.query("select count(*) from activity_events")).rows[0].count) - before).toBe(1); // só o ticket.created
  });

  it("alterar a descrição troca o conjunto: grava as novas e remove as que saíram, sem recriar as que ficam", async () => {
    const a = await add();
    await add();
    await add();
    const d = await add({ description: "PRIV-1 e PRIV-2" });
    expect(await pairs()).toEqual(["4>1", "4>2"]);
    const kept = (await relations()).find((row) => row.to_number === 1);
    expect((await patch(d.id, { description: "PRIV-1 e PRIV-3" })).status).toBe(200);
    expect(await pairs()).toEqual(["4>1", "4>3"]);
    const after = (await relations()).find((row) => row.to_number === 1);
    expect(after).toMatchObject({ id: kept?.id, created_at: kept?.created_at });
    expect(a.number).toBe(1);
  });

  it("tirar a chave do texto remove a ligação", async () => {
    await add();
    const b = await add({ description: "PRIV-1" });
    expect(await pairs()).toEqual(["2>1"]);
    await patch(b.id, { description: "nada mais" });
    expect(await pairs()).toEqual([]);
  });

  it("mudar só o título (ou a situação) não toca nas ligações", async () => {
    await add();
    const b = await add({ description: "PRIV-1" });
    const before = await relations();
    await patch(b.id, { title: "Outro título" });
    await patch(b.id, { status: "in_progress" });
    expect(await relations()).toEqual(before);
  });

  it("não conta: código, o próprio ticket, outro projeto e ticket que não existe", async () => {
    await add();
    await add({}, open());
    const d = await add({ description: "`PRIV-1`\n\n```\nPRIV-1\n```\nPRIV-2 aqui, OPEN-1, PRIV-99" });
    expect(await pairs()).toEqual([]);
    await patch(d.id, { description: "PRIV-3 é este mesmo, e OPEN-1" });
    expect(await pairs()).toEqual([]);
  });

  it("a chave de outro projeto não vira ligação nem no projeto de destino", async () => {
    await add({ description: "OPEN-1" }, priv());
    await add({}, open());
    expect(await pairs()).toEqual([]);
  });

  it("uma ligação depends_on entre os mesmos tickets sobrevive a qualquer gravação de descrição", async () => {
    const a = await add();
    const b = await add({ description: "PRIV-1" });
    await h.pool.query(
      "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ('org_A', $1, $2, $3, 'depends_on')",
      [priv(), b.id, a.id],
    );
    await patch(b.id, { description: "sem chave" });
    expect(await pairs()).toEqual([]);
    await patch(b.id, { description: "PRIV-1 de novo" });
    expect(await pairs()).toEqual(["2>1"]);
    expect((await relations("depends_on")).map((row) => `${row.from_number}>${row.to_number}`)).toEqual(["2>1"]);
  });

  it("chave escrita antes de o ticket existir ganha a ligação quando ele é criado", async () => {
    const a = await add({ description: "Vai precisar de PRIV-3 e de PRIV-2." });
    await add();
    expect(await pairs()).toEqual(["1>2"]);
    await add();
    expect(await pairs()).toEqual(["1>2", "1>3"]);
    expect(a.number).toBe(1);
  });

  it("PRIV-1 não vira ligação para PRIV-10 criado depois (o texto é decidido pela regra, não pelo prefixo)", async () => {
    const a = await add({ description: "PRIV-1" });
    for (let i = 2; i <= 10; i += 1) await add();
    expect(await pairs()).toEqual([]);
    expect(a.number).toBe(1);
  });

  it("remover um ticket pela rota remove as ligações dele, nos dois sentidos", async () => {
    const a = await add();
    const b = await add({ description: "PRIV-1" });
    await add({ description: "PRIV-2" });
    expect(await pairs()).toEqual(["2>1", "3>2"]);
    expect((await h.call("DELETE", `/api/tickets/${b.id}`, as("admin"))).status).toBe(204);
    expect(await pairs()).toEqual([]);
    expect(a.number).toBe(1);
  });
});

describe("importar por lista", () => {
  const importItems = (items: Body[], parentId: string | null = null) => h.call("POST", `/api/projects/${priv()}/tickets/import`, as("admin"), { parentId, items });

  it("grava as ligações entre itens da lista, para ticket já existente, e para chave escrita antes", async () => {
    await add({ description: "Aguarda PRIV-3" }); // 1: cita um número que a importação vai criar
    const res = await importItems([
      { title: "A", description: "ver PRIV-1", children: [{ title: "B", description: "ver PRIV-2 e PRIV-4" }] }, // 2, 3
      { title: "C" }, // 4
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await pairs()).toEqual(["1>3", "2>1", "3>2", "3>4"]);
  });

  it("não faz uma consulta por item: 100 itens citando uns aos outros gravam as ligações numa só importação", async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ title: `Item ${i}`, description: i === 0 ? "" : `depois de PRIV-${i}` }));
    const res = await importItems(items);
    expect(res.status).toBe(201);
    expect((await relations()).length).toBe(99);
  });
});

describe("criação pela conversa com a IA", () => {
  it("o ticket criado pela conversa grava as ligações da descrição do rascunho", async () => {
    await add();
    const opened = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Corrigir o que PRIV-1 deixou" });
    const res = await h.call("POST", `/api/ticket-conversations/${opened.body.id}/ticket`, as("contributor"), { parentId: null });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await pairs()).toEqual(["2>1"]);
  });

  it("o pai criado por uma proposta grava as ligações da descrição do grupo", async () => {
    const a = await add();
    const b = await add();
    const opened = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Reunir" });
    const res = await h.call("POST", `/api/ticket-conversations/${opened.body.id}/ticket`, as("contributor"), {
      parentId: null,
      group: { title: "Grupo", description: "Junta PRIV-1 e PRIV-2.", ticketIds: [a.id, b.id] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await pairs()).toEqual(["3>1", "3>2"]);
  });
});

describe("mentionedBy no detalhe", () => {
  it("lista quem menciona, em ordem de número, e fica vazia quando ninguém menciona", async () => {
    const a = await add({ title: "Alvo" });
    expect((await get(a.id)).mentionedBy).toEqual([]);
    const c = await add({ title: "Terceiro", description: "PRIV-1", status: "in_progress" });
    const b = await add({ title: "Quarto", description: "e PRIV-1" });
    const detail = await get(a.id);
    expect(detail.mentionedBy).toEqual([
      { id: c.id, key: "PRIV-2", title: "Terceiro", status: "in_progress" },
      { id: b.id, key: "PRIV-3", title: "Quarto", status: "todo" },
    ]);
    expect(((await patch(a.id, { title: "Alvo 2" })).body as { mentionedBy: Mention[] }).mentionedBy).toHaveLength(2);
  });

  it("o detalhe devolvido pela criação também traz mentionedBy (vazio)", async () => {
    const a = await add();
    expect((await h.call("GET", `/api/tickets/${a.id}`, as("admin"))).body.mentionedBy).toEqual([]);
  });
});

describe("POST projects/:projectId/tickets/mentions/rebuild", () => {
  const rebuild = (who: "admin" | "reader" = "admin", project = priv()) => h.call("POST", `/api/projects/${project}/tickets/mentions/rebuild`, as(who));
  const insertRaw = (number: number, description: string) =>
    h.pool.query(
      "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ('org_A',$1,$2,'T',$3,$4)",
      [priv(), number, description, h.world().people.admin],
    );

  it("preenche um projeto que já tinha descrições com chaves e não muda nada na segunda vez", async () => {
    await insertRaw(1, "");
    await insertRaw(2, "PRIV-1 e PRIV-3 e `PRIV-1`");
    await insertRaw(3, "PRIV-1 PRIV-9");
    await h.pool.query("update projects set next_ticket_number = 4 where id = $1", [priv()]);
    const first = await rebuild();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ read: 3, created: 3, removed: 0 });
    expect(await pairs()).toEqual(["2>1", "2>3", "3>1"]);
    const stored = await relations();
    const second = await rebuild();
    expect(second.body).toEqual({ read: 3, created: 0, removed: 0 });
    expect(await relations()).toEqual(stored);
  });

  it("remove ligação que a descrição não sustenta mais e deixa depends_on em paz", async () => {
    const a = await add();
    const b = await add({ description: "PRIV-1" });
    await h.pool.query("update tickets set description = 'sem chave' where id = $1", [b.id]);
    await h.pool.query(
      "insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ('org_A', $1, $2, $3, 'depends_on')",
      [priv(), b.id, a.id],
    );
    expect((await rebuild()).body).toEqual({ read: 2, created: 0, removed: 1 });
    expect(await pairs()).toEqual([]);
    expect(await relations("depends_on")).toHaveLength(1);
  });

  it("exige permissão de editar tickets e esconde projeto invisível", async () => {
    expect((await rebuild("reader")).status).toBe(403);
    expect((await h.call("POST", `/api/projects/${priv()}/tickets/mentions/rebuild`, as("plain"))).status).toBe(404);
  });
});

describe("reconcileMentions com gravações simultâneas", () => {
  const inTenant = <T,>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(h.app().get<PrismaClient>(PRISMA), { orgId: ORG, userId: h.world().people.admin }, fn);
  const projectRow = async () => {
    const row = (await h.pool.query("select org_id, id, key, visibility, archived_at from projects where id = $1", [priv()])).rows[0];
    return { orgId: row.org_id as string, id: row.id as string, key: row.key as string, visibility: row.visibility as "private", archivedAt: null };
  };
  const insertRaw = async (number: number, description: string): Promise<string> =>
    (await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ('org_A',$1,$2,'T',$3,$4) returning id",
      [priv(), number, description, h.world().people.admin],
    )).rows[0].id as string;

  it("uma ligação que já existe não derruba a criação das outras", async () => {
    const service = h.app().get(TicketsService);
    const project = await projectRow();
    const target1 = await insertRaw(1, "");
    await insertRaw(2, "");
    const source = await insertRaw(3, "PRIV-1 e PRIV-2");
    // Outra transação gravou a ligação 3→1 entre a leitura das existentes e a criação das que faltam: simulada por fora.
    await h.pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ('org_A',$1,$2,$3,'mentions')", [priv(), source, target1]);
    const counts = await inTenant((tx) => service.reconcileMentions(tx, project, [{ id: source, number: 3, description: "PRIV-1 e PRIV-2" }]));
    expect(counts).toEqual({ created: 1, removed: 0 });
    expect(await pairs()).toEqual(["3>1", "3>2"]);
  });

  it("duas transações reconciliando a mesma fonte ao mesmo tempo: nenhuma falha e sobra uma ligação só", async () => {
    const service = h.app().get(TicketsService);
    const project = await projectRow();
    for (let round = 0; round < 15; round += 1) {
      await h.pool.query("delete from ticket_relations");
      await h.pool.query("delete from tickets");
      await h.pool.query("update projects set next_ticket_number = 1 where id = $1", [priv()]);
      await insertRaw(1, "");
      const source = await insertRaw(2, "PRIV-1");
      const run = () => inTenant((tx) => service.reconcileMentions(tx, project, [{ id: source, number: 2, description: "PRIV-1" }]));
      const results = await Promise.allSettled([run(), run()]);
      expect(results.map((result) => result.status), `rodada ${round}`).toEqual(["fulfilled", "fulfilled"]);
      expect(await pairs()).toEqual(["2>1"]);
    }
  });
});

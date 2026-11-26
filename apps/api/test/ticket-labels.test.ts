import { describe, expect, it } from "vitest";
import { LABELS_PER_PROJECT, LABELS_PER_TICKET, defaultLabelColor } from "@treepm/domain";
import { LabelsService } from "../src/tickets/labels.service.js";
import { useHarness } from "./harness.js";
import { asService } from "./service-door.js";
import { ORG, as } from "./world.js";
import type { Who } from "./world.js";

// Etiquetas por projeto (ADR 0065, TREEPM-466), etapa A: etiquetas do projeto (listar, criar, renomear, trocar cor, apagar) e pôr/tirar no
// ticket, com evento, linha do tempo, origens do Linear, limites, concorrência e versão do projeto. As leituras de ticket (resumo, detalhe)
// ganham `labels` em outra etapa; aqui a rota do ticket devolve as etiquetas resultantes.
const h = useHarness();

type Body = Record<string, unknown>;
type Label = { id: string; name: string; color: string; ticketCount?: number };
const P = () => h.world().projects.priv;
const labelsPath = (project = P()) => `/api/projects/${project}/labels`;

const ticket = async (body: Body = {}, who: Who = "admin"): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as(who), { title: "Ticket", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
const list = async (who: Who = "admin", project = P()): Promise<Label[]> => {
  const res = await h.call("GET", labelsPath(project), as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Label[];
};
const create = (body: Body, who: Who = "admin", project = P()) => h.call("POST", labelsPath(project), as(who), body);
const createOk = async (name: string, color?: string): Promise<Label> => {
  const res = await create(color === undefined ? { name } : { name, color });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Label;
};
const patchLabel = (id: string, body: Body, who: Who = "admin") => h.call("PATCH", `${labelsPath()}/${id}`, as(who), body);
const removeLabel = (id: string, who: Who = "admin") => h.call("DELETE", `${labelsPath()}/${id}`, as(who));
const change = (id: string, body: Body, who: Who = "admin") => h.call("POST", `/api/tickets/${id}/labels`, as(who), body);
const changeOk = async (id: string, body: Body, who: Who = "admin"): Promise<{ labels: Label[] }> => {
  const res = await change(id, body, who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { labels: Label[] };
};
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const onTicket = async (id: string): Promise<string[]> =>
  (await rows("select pl.name from ticket_labels tl join project_labels pl on pl.id = tl.label_id where tl.ticket_id = $1 order by pl.name_key", [id])).map((r) => r.name as string);
const labelEvents = async (id: string) => rows("select payload from activity_events where kind = 'ticket.labels_changed' and subject_id = $1 order by occurred_at, id", [id]);
const version = async (): Promise<bigint> => BigInt((await rows("select tickets_version from projects where id = $1", [P()]))[0].tickets_version as string);
const activity = async (id: string): Promise<Body[]> => (await h.call("GET", `/api/tickets/${id}/activity`, as("admin"))).body.entries as Body[];

describe("etiquetas do projeto: listar e criar", () => {
  it("lista vazia; criar devolve a etiqueta com a cor pedida, ou a cor padrão pelo nome", async () => {
    expect(await list()).toEqual([]);
    const bug = await createOk("Bug", "rose");
    expect(bug).toMatchObject({ name: "Bug", color: "rose", ticketCount: 0 });
    const debt = await createOk("  Dívida   técnica  ");
    expect(debt).toMatchObject({ name: "Dívida técnica", color: defaultLabelColor("Dívida técnica") });
  });

  it("lista em ordem de nome (chave), com quantos tickets usam cada uma", async () => {
    const zeta = await createOk("zeta");
    const alfa = await createOk("Alfa");
    const t1 = await ticket();
    const t2 = await ticket();
    await changeOk(t1.id, { add: [{ labelId: zeta.id }, { labelId: alfa.id }] });
    await changeOk(t2.id, { add: [{ labelId: zeta.id }] });
    expect((await list()).map((l) => [l.name, l.ticketCount])).toEqual([["Alfa", 1], ["zeta", 2]]);
  });

  it("nome que já existe (sem diferenciar maiúsculas): 409 label_name_taken; nome vazio depois de limpar: 400 label_name_invalid; cor fora da paleta: 400", async () => {
    await createOk("Bug");
    const dup = await create({ name: "BUG" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("label_name_taken");
    for (const name of ["", "   ", "\n\t\u0000"]) {
      const res = await create({ name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.error.code).toBe("label_name_invalid");
    }
    expect((await create({ name: "X", color: "red" })).status).toBe(400);
    expect((await list()).map((l) => l.name)).toEqual(["Bug"]);
  });

  it("permissões: leitor vê e não cria (403); contribuidor cria; quem não vê o projeto recebe 404", async () => {
    await createOk("Bug");
    expect((await list("reader")).map((l) => l.name)).toEqual(["Bug"]);
    expect((await create({ name: "Leitor" }, "reader")).status).toBe(403);
    expect((await create({ name: "Contribuidor" }, "contributor")).status).toBe(201);
    expect((await h.call("GET", labelsPath(), as("plain"))).status).toBe(404);
    expect((await create({ name: "Fora" }, "plain")).status).toBe(404);
    expect((await h.call("GET", labelsPath(), as("outsider", "org_B"))).status).toBe(404);
  });

  it(`limite de ${LABELS_PER_PROJECT} por projeto: 409 label_limit_project`, async () => {
    await h.pool.query(
      "insert into project_labels (org_id, project_id, name, name_key, color) select $1, $2, 'e' || g, 'e' || g, 'gray' from generate_series(1, $3::int) g",
      [ORG, P(), LABELS_PER_PROJECT],
    );
    const res = await create({ name: "Mais uma" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("label_limit_project");
    expect(res.body.error.message).toMatch(/200/);
  });
});

describe("etiquetas do projeto: renomear, trocar cor, apagar", () => {
  it("quem administra renomeia e troca a cor; contribuidor e leitor recebem 403", async () => {
    const bug = await createOk("Bug", "rose");
    for (const who of ["contributor", "reader"] as const) {
      expect((await patchLabel(bug.id, { name: "Defeito" }, who)).status, who).toBe(403);
      expect((await removeLabel(bug.id, who)).status, who).toBe(403);
    }
    const res = await patchLabel(bug.id, { name: "Defeito", color: "cyan" }, "manager");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: bug.id, name: "Defeito", color: "cyan" });
    expect((await patchLabel(bug.id, { name: "defeito" })).body).toMatchObject({ name: "defeito" }); // só a caixa: a mesma etiqueta
  });

  it("renomear para o nome de outra etiqueta: 409 label_name_taken, nada muda; etiqueta inexistente ou de outro projeto: 404", async () => {
    const bug = await createOk("Bug");
    await createOk("Ideia");
    const res = await patchLabel(bug.id, { name: "IDEIA" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("label_name_taken");
    expect((await list()).map((l) => l.name)).toEqual(["Bug", "Ideia"]);
    const other = (await create({ name: "Aberto" }, "admin", h.world().projects.org)).body as Label;
    expect((await patchLabel(other.id, { color: "cyan" })).status).toBe(404);
    expect((await removeLabel(other.id)).status).toBe(404);
    expect((await patchLabel("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000", { color: "cyan" })).status).toBe(404);
    expect((await patchLabel(bug.id, {})).status).toBe(400);
    expect((await patchLabel(bug.id, { name: "  " })).body.error.code).toBe("label_name_invalid");
  });

  it("apagar devolve quantos tickets a perderam, grava UM evento de projeto e nenhum por ticket", async () => {
    const bug = await createOk("Bug");
    const tickets = [await ticket(), await ticket(), await ticket()];
    for (const t of tickets) await changeOk(t.id, { add: [{ labelId: bug.id }] });
    const before = (await rows("select count(*)::int n from activity_events where kind = 'ticket.labels_changed'"))[0].n as number;
    const res = await removeLabel(bug.id, "manager");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ticketsAffected: 3 });
    expect(await list()).toEqual([]);
    for (const t of tickets) expect(await onTicket(t.id)).toEqual([]);
    expect((await rows("select count(*)::int n from activity_events where kind = 'ticket.labels_changed'"))[0].n).toBe(before);
    const projectEvents = await rows("select subject_type, subject_id, payload from activity_events where kind = 'project.label_deleted'");
    expect(projectEvents).toEqual([{ subject_type: "project", subject_id: P(), payload: { name: "Bug", tickets: 3 } }]);
  });

  it("projeto arquivado: criar, renomear, apagar e pôr no ticket recebem 409 project_archived; listar continua", async () => {
    const bug = await createOk("Bug");
    const t = await ticket();
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    for (const res of [await create({ name: "Nova" }), await patchLabel(bug.id, { color: "cyan" }), await removeLabel(bug.id), await change(t.id, { add: [{ labelId: bug.id }] })]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("project_archived");
    }
    expect((await list()).map((l) => l.name)).toEqual(["Bug"]);
  });
});

describe("pôr e tirar etiquetas no ticket", () => {
  it("põe por id e por nome (nome novo cria com a cor padrão; nome existente, em outra caixa, reusa); devolve as etiquetas do ticket", async () => {
    const bug = await createOk("Bug", "rose");
    const t = await ticket();
    const res = await changeOk(t.id, { add: [{ name: "bug" }, { name: "Cliente X" }] });
    expect(res.labels.map((l) => [l.name, l.color])).toEqual([["Bug", "rose"], ["Cliente X", defaultLabelColor("Cliente X")]]);
    expect(res.labels[0]?.id).toBe(bug.id);
    expect((await list()).map((l) => l.name)).toEqual(["Bug", "Cliente X"]);
    const after = await changeOk(t.id, { remove: [bug.id] });
    expect(after.labels.map((l) => l.name)).toEqual(["Cliente X"]);
  });

  it("permissões: contribuidor põe (inclusive criando); leitor 403; quem não vê, 404", async () => {
    const t = await ticket();
    expect((await change(t.id, { add: [{ name: "Nova" }] }, "contributor")).status).toBe(200);
    expect((await change(t.id, { add: [{ name: "Outra" }] }, "reader")).status).toBe(403);
    expect((await change(t.id, { add: [{ name: "Outra" }] }, "plain")).status).toBe(404);
    expect(await onTicket(t.id)).toEqual(["Nova"]);
  });

  it("idempotente: pôr a que já tem e tirar a que não tem não muda nada nem grava evento nem toca a versão", async () => {
    const bug = await createOk("Bug");
    const other = await createOk("Outra");
    const t = await ticket();
    await changeOk(t.id, { add: [{ labelId: bug.id }] });
    expect(await labelEvents(t.id)).toHaveLength(1);
    const v = await version();
    await changeOk(t.id, { add: [{ labelId: bug.id }, { name: "BUG" }], remove: [other.id] });
    expect(await labelEvents(t.id)).toHaveLength(1);
    expect(await version()).toBe(v);
    expect(await onTicket(t.id)).toEqual(["Bug"]);
  });

  it("várias no mesmo pedido: UM evento com o que entrou e o que saiu (nome da época)", async () => {
    const a = await createOk("Alfa");
    const b = await createOk("Beta");
    const t = await ticket();
    await changeOk(t.id, { add: [{ labelId: a.id }] });
    await changeOk(t.id, { add: [{ labelId: b.id }, { name: "Gama" }], remove: [a.id] });
    const events = await labelEvents(t.id);
    expect(events).toHaveLength(2);
    const gama = (await list()).find((l) => l.name === "Gama") as Label;
    expect(events[1]?.payload).toEqual({ key: t.key, added: [{ id: b.id, name: "Beta" }, { id: gama.id, name: "Gama" }], removed: [{ id: a.id, name: "Alfa" }] });
  });

  it("linha do tempo: UMA entrada labels_changed com o nome da época, mesmo depois de renomear a etiqueta", async () => {
    const a = await createOk("Alfa");
    const t = await ticket();
    await changeOk(t.id, { add: [{ labelId: a.id }, { name: "Beta" }] });
    await patchLabel(a.id, { name: "Alfa renomeada" });
    await changeOk(t.id, { remove: [a.id] });
    const entries = (await activity(t.id)).filter((e) => e["type"] === "labels_changed");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ added: [], removed: [{ id: a.id, name: "Alfa renomeada" }], actor: { id: h.world().people.admin } });
    expect(entries[1]).toMatchObject({ added: [{ id: a.id, name: "Alfa" }, { name: "Beta" }], removed: [] });
    expect(entries[1]).not.toHaveProperty("automatic");
  });

  it("linha do tempo: payload malformado descarta a entrada; o automático do Linear vem marcado", async () => {
    const t = await ticket();
    const insert = (payload: unknown) =>
      h.pool.query("insert into activity_events (org_id, actor_person_id, kind, subject_type, subject_id, payload) values ($1,$2,'ticket.labels_changed','ticket',$3,$4)", [ORG, h.world().people.admin, t.id, JSON.stringify(payload)]);
    const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
    for (const bad of [{}, { added: "x", removed: [] }, { added: [{ id, name: 3 }], removed: [] }, { added: [{ id: "não-uuid", name: "x" }], removed: [] }, { added: [], removed: [] }, [1]]) await insert(bad);
    await insert({ key: t.key, added: [{ id, name: "Do Linear" }], removed: [], automatic: true, source: "linear_reimport", runId: id });
    const entries = (await activity(t.id)).filter((e) => e["type"] === "labels_changed");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ automatic: true, added: [{ id, name: "Do Linear" }], removed: [] });
  });

  it(`limite de ${LABELS_PER_TICKET} por ticket sobre o conjunto final (trocar no limite vale): 409 label_limit_ticket`, async () => {
    const t = await ticket();
    const names = Array.from({ length: LABELS_PER_TICKET }, (_, i) => ({ name: `e${String(i).padStart(2, "0")}` }));
    await changeOk(t.id, { add: names });
    const res = await change(t.id, { add: [{ name: "Vinte e um" }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("label_limit_ticket");
    expect(res.body.error.message).toMatch(/20/);
    expect((await list()).some((l) => l.name === "Vinte e um")).toBe(false); // nada criado
    const first = (await list()).find((l) => l.name === "e00") as Label;
    await changeOk(t.id, { add: [{ name: "Vinte e um" }], remove: [first.id] });
    expect(await onTicket(t.id)).toHaveLength(LABELS_PER_TICKET);
  });

  it(`limite de ${LABELS_PER_PROJECT} por projeto ao criar pelo nome: 409 label_limit_project, nada posto`, async () => {
    await h.pool.query(
      "insert into project_labels (org_id, project_id, name, name_key, color) select $1, $2, 'e' || g, 'e' || g, 'gray' from generate_series(1, $3::int) g",
      [ORG, P(), LABELS_PER_PROJECT],
    );
    const t = await ticket();
    const res = await change(t.id, { add: [{ name: "e1" }, { name: "Nova" }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("label_limit_project");
    expect(await onTicket(t.id)).toEqual([]);
    expect((await changeOk(t.id, { add: [{ name: "E1" }] })).labels.map((l) => l.name)).toEqual(["e1"]); // reusar não cria
  });

  it("entrada inválida: nome vazio 400 label_name_invalid; etiqueta de outro projeto ou inexistente 404 label_not_found; a mesma em pôr e tirar 400", async () => {
    const t = await ticket();
    const bug = await createOk("Bug");
    const res = await change(t.id, { add: [{ name: "   " }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("label_name_invalid");
    const other = (await create({ name: "Aberto" }, "admin", h.world().projects.org)).body as Label;
    for (const body of [{ add: [{ labelId: other.id }] }, { remove: [other.id] }, { add: [{ labelId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000" }] }]) {
      const r = await change(t.id, body);
      expect(r.status, JSON.stringify(body)).toBe(404);
      expect(r.body.error.code).toBe("label_not_found");
    }
    expect((await change(t.id, { add: [{ labelId: bug.id }], remove: [bug.id] })).status).toBe(400);
    expect((await change(t.id, {})).status).toBe(400);
    expect((await change(t.id, { add: [{ labelId: bug.id, name: "x" }] })).status).toBe(400);
    expect(await onTicket(t.id)).toEqual([]);
  });
});

describe("versão do projeto (ADR 0046)", () => {
  it("pôr, tirar, criar, renomear, trocar cor e apagar mudam a versão", async () => {
    const t = await ticket();
    const steps: [string, () => Promise<unknown>][] = [];
    let label: Label | undefined;
    steps.push(["criar", async () => (label = await createOk("Bug"))]);
    steps.push(["pôr", () => changeOk(t.id, { add: [{ labelId: (label as Label).id }] })]);
    steps.push(["renomear", () => patchLabel((label as Label).id, { name: "Defeito" })]);
    steps.push(["trocar cor", () => patchLabel((label as Label).id, { color: "olive" })]);
    steps.push(["tirar", () => changeOk(t.id, { remove: [(label as Label).id] })]);
    steps.push(["pôr pelo nome", () => changeOk(t.id, { add: [{ name: "Defeito" }] })]);
    steps.push(["apagar", () => removeLabel((label as Label).id)]);
    for (const [name, step] of steps) {
      const before = await version();
      await step();
      expect(await version(), name).toBeGreaterThan(before);
    }
  });
});

describe("origens do Linear", () => {
  const ref = (ticketId: string, labelId: string, externalId: string) =>
    h.pool.query("insert into external_item_refs (org_id, project_id, ticket_id, provider, kind, external_id, local_id) values ($1,$2,$3,'linear','label',$4,$5)", [ORG, P(), ticketId, externalId, labelId]);
  const refs = () => rows("select external_id, local_id, removed_here_at is not null as removed from external_item_refs where kind = 'label' order by external_id");

  it("tirar a etiqueta do ticket marca a origem daquele ticket como removida aqui; a de outro ticket fica", async () => {
    const bug = await createOk("Bug");
    const t1 = await ticket();
    const t2 = await ticket();
    for (const t of [t1, t2]) await changeOk(t.id, { add: [{ labelId: bug.id }] });
    await ref(t1.id, bug.id, "i1:l1");
    await ref(t2.id, bug.id, "i2:l1");
    await changeOk(t1.id, { remove: [bug.id] });
    expect(await refs()).toEqual([
      { external_id: "i1:l1", local_id: null, removed: true },
      { external_id: "i2:l1", local_id: bug.id, removed: false },
    ]);
  });

  it("o núcleo para a sincronização: campos a mais no evento (automático na linha do tempo) e tirar sem marcar a origem", async () => {
    const bug = await createOk("Bug");
    const t = await ticket();
    await changeOk(t.id, { add: [{ labelId: bug.id }] });
    await ref(t.id, bug.id, "i1:l1");
    const runId = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
    await asService(h.app(), "admin", ORG, async (tx, principal) => {
      const project = await tx.project.findFirstOrThrow({ where: { id: P() } });
      await h.app().get(LabelsService).applyTicketLabels(tx, principal, project, t, { add: [], remove: [bug.id] }, { event: { automatic: true, source: "linear_reimport", runId }, markRemovedHere: false });
    });
    expect(await onTicket(t.id)).toEqual([]);
    expect(await refs()).toEqual([{ external_id: "i1:l1", local_id: bug.id, removed: false }]);
    expect((await labelEvents(t.id)).at(-1)?.payload).toEqual({ key: t.key, added: [], removed: [{ id: bug.id, name: "Bug" }], automatic: true, source: "linear_reimport", runId });
    const entry = (await activity(t.id)).find((e) => e["type"] === "labels_changed");
    expect(entry).toMatchObject({ automatic: true, removed: [{ id: bug.id, name: "Bug" }] });
  });

  it("apagar a etiqueta marca a origem dela no projeto e os vínculos de todos os tickets como removidos aqui", async () => {
    const bug = await createOk("Bug");
    const keep = await createOk("Fica");
    const t1 = await ticket();
    await changeOk(t1.id, { add: [{ labelId: bug.id }, { labelId: keep.id }] });
    await ref(t1.id, bug.id, "i1:l1");
    await ref(t1.id, keep.id, "i1:l2");
    await h.pool.query("insert into project_label_origins (org_id, project_id, provider, external_id, label_id, applied_name, applied_color) values ($1,$2,'linear','l1',$3,'Bug','gray'), ($1,$2,'linear','l2',$4,'Fica','gray')", [ORG, P(), bug.id, keep.id]);
    expect((await removeLabel(bug.id)).body).toEqual({ ticketsAffected: 1 });
    expect(await refs()).toEqual([
      { external_id: "i1:l1", local_id: null, removed: true },
      { external_id: "i1:l2", local_id: keep.id, removed: false },
    ]);
    expect(await rows("select external_id, label_id, removed_here_at is not null as removed from project_label_origins order by external_id")).toEqual([
      { external_id: "l1", label_id: null, removed: true },
      { external_id: "l2", label_id: keep.id, removed: false },
    ]);
  });
});

describe("concorrência", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("dois pedidos em paralelo criando o mesmo nome em tickets diferentes: uma etiqueta só, nos dois", async () => {
    const t1 = await ticket();
    const t2 = await ticket();
    const [r1, r2] = await Promise.all([change(t1.id, { add: [{ name: "Corrida" }] }), change(t2.id, { add: [{ name: "corrida" }] })]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const all = await list();
    expect(all.map((l) => [l.name, l.ticketCount])).toEqual([["Corrida", 2]]);
  });

  it("outra transação cria o mesmo nome e confirma depois: o pedido espera, reusa a etiqueta dela e não falha", async () => {
    const t = await ticket();
    const client = await h.pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into project_labels (org_id, project_id, name, name_key, color) values ($1, $2, 'Corrida', 'corrida', 'cyan')", [ORG, P()]);
      const pending = change(t.id, { add: [{ name: "CORRIDA" }] }).then((r) => r);
      await wait(400);
      await client.query("commit");
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.labels).toMatchObject([{ name: "Corrida", color: "cyan" }]);
    } finally {
      client.release();
    }
    expect((await list()).map((l) => l.name)).toEqual(["Corrida"]);
  });

  it("apagar a etiqueta enquanto outro pedido a põe: o pedido que chega depois recebe 404, sem 500", async () => {
    const bug = await createOk("Bug");
    const t = await ticket();
    const client = await h.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from project_labels where id = $1", [bug.id]);
      const pending = change(t.id, { add: [{ labelId: bug.id }] }).then((r) => r);
      await wait(400);
      await client.query("commit");
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error.code).toBe("label_not_found");
    } finally {
      client.release();
    }
  });
});

// Revisão E1 (TREEPM-466), item 6.
describe("revisão E1: evento vazio e conflito no limite", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("pôr «Foo» num ticket que já tem a etiqueta renomeada para Foo em paralelo: 200, sem evento vazio e sem subir a versão", async () => {
    const t = await ticket();
    const first = await changeOk(t.id, { add: [{ name: "Velha" }] });
    const id = first.labels[0]?.id as string;
    const events = async () => (await rows("select count(*)::int n from activity_events where subject_id = $1 and kind = 'ticket.labels_changed'", [t.id]))[0].n as number;
    const before = await events();
    const version = async () => (await rows("select tickets_version::text v from projects where id = $1", [P()]))[0].v as string;
    const client = await h.pool.connect();
    let versionBefore = "";
    try {
      await client.query("begin");
      await client.query("update project_labels set name = 'Foo', name_key = 'foo' where id = $1", [id]);
      versionBefore = await version();
      const pending = change(t.id, { add: [{ name: "Foo" }] }).then((r) => r);
      await wait(400);
      await client.query("commit");
      const res = await pending;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.labels.map((label: Label) => label.name)).toEqual(["Foo"]);
    } finally {
      client.release();
    }
    expect(await events()).toBe(before);
    expect(await version()).toBe(versionBefore);
  });

  it(`nome que já existe com o projeto no limite de ${LABELS_PER_PROJECT}: 409 label_name_taken, não label_limit_project`, async () => {
    await h.pool.query(
      "insert into project_labels (org_id, project_id, name, name_key, color) select $1, $2, 'L' || g, 'l' || g, 'gray' from generate_series(1, $3::int) g",
      [ORG, P(), LABELS_PER_PROJECT],
    );
    const res = await create({ name: "l7" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("label_name_taken");
    const fresh = await create({ name: "Nova" });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe("label_limit_project");
  });
});

describe("tickets nascem sem etiqueta", () => {
  it("filho de ticket etiquetado e importação por lista dentro dele nascem sem etiqueta", async () => {
    const parent = await ticket();
    await changeOk(parent.id, { add: [{ name: "Bug" }] });
    const child = await ticket({ parentId: parent.id });
    expect(await onTicket(child.id)).toEqual([]);
    const imported = await h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { parentId: parent.id, items: [{ title: "A", children: [{ title: "B" }] }] });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect((await rows("select count(*)::int n from ticket_labels"))[0].n).toBe(1);
  });
});

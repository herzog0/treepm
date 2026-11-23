import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// ADR 0052, fatia 3: a criação leva as tarefas sugeridas que ficaram e as ligações que ficaram marcadas.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;

const FIXED = "Sugerida pelo assistente, não pedida:";
const open = async (children?: { title: string; description: string }[], description = "Receber só o diff") => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero sincronizar com o Jira" })).body.id as string;
  expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Sincronizar com o Jira", description, ...(children ? { children } : {}) })).status).toBe(200);
  return id;
};
const create = (id: string, extra: Record<string, unknown> = {}, parentId: string | null = null) =>
  h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), { parentId, ...extra });
const task = (title: string, motivo = "sem isso não há diff", description = "Detalhe da tarefa") => ({ title, description, motivo });
const relations = () => rows("select f.number as from_n, t.number as to_n from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = 'depends_on' order by 1, 2");

describe("tarefas sugeridas", () => {
  it("nascem como filhos, depois das partes da pessoa, com a linha fixa e sem a citação do pedido", async () => {
    await seedTree(h.pool, h.world());
    const id = await open([{ title: "Receber o diff", description: "Sem reimportar" }, { title: "Mostrar o estado", description: "" }]);
    const res = await create(id, { suggested: [task("Guardar o cursor"), task("Cadastrar o token", "o Jira exige")] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const kids = res.body.children as { title: string; description: string; key: string }[];
    expect(kids.map((k) => k.title)).toEqual(["Receber o diff", "Mostrar o estado", "Guardar o cursor", "Cadastrar o token"]);
    expect(kids[2]!.description).toBe(`${FIXED} sem isso não há diff\n\nDetalhe da tarefa`);
    expect(kids[3]!.description).toBe(`${FIXED} o Jira exige\n\nDetalhe da tarefa`);
    for (const k of kids.slice(2)) expect(k.description).not.toContain("Pedido original");
    expect(kids[0]!.description).toBe("Sem reimportar");
    expect(res.body.ticket.description).toContain("Pedido original:");
    expect(res.body.warnings).toEqual([]);
  });

  it("o evento de criação guarda que foi sugerida pelo assistente (só ela; as partes e o pai não)", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open([{ title: "Receber o diff", description: "" }]), { suggested: [task("Guardar o cursor")] });
    const events = await rows("select payload from activity_events where kind = 'ticket.created' and subject_id = any($1::text[]) order by occurred_at, id", [[res.body.ticket.id, ...res.body.children.map((c: { id: string }) => c.id)]]);
    expect(events.map((e) => e.payload.suggestedBy ?? null)).toEqual([null, null, "assistant"]);
    expect(JSON.stringify(events[2].payload)).not.toContain("sem isso não há diff");
  });

  it("rascunho de um ticket só com sugeridas aceitas: ele vira o pai delas", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(), { suggested: [task("Guardar o cursor")] });
    expect(res.status).toBe(201);
    expect(res.body.children).toHaveLength(1);
    expect(res.body.children[0].parentId).toBe(res.body.ticket.id);
  });

  it("sem sugeridas nem ligações a criação é a de antes", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open());
    expect(res.status).toBe(201);
    expect(res.body.children).toEqual([]);
    expect(res.body.warnings).toEqual([]);
    expect(await relations()).toEqual([]);
  });

  it("repetir a criação não duplica nada e devolve as sugeridas entre os filhos", async () => {
    await seedTree(h.pool, h.world());
    const id = await open();
    await create(id, { suggested: [task("Guardar o cursor")] });
    const before = await count("tickets");
    const again = await create(id, { suggested: [task("Guardar o cursor"), task("Outra")] });
    expect(again.status).toBe(201);
    expect(await count("tickets")).toBe(before);
    expect(again.body.children.map((c: { title: string }) => c.title)).toEqual(["Guardar o cursor"]);
  });
});

describe("ligações 'depende de'", () => {
  it("são criadas na mesma operação, do pai e de uma parte, pela pessoa que confirmou", async () => {
    await seedTree(h.pool, h.world());
    const id = await open([{ title: "Receber o diff", description: "" }]);
    const res = await create(id, { links: [{ de: "pai", dependeDe: "PRIV-2" }, { de: 0, deTitle: "Receber o diff", dependeDe: "PRIV-4" }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([]);
    expect(await relations()).toEqual([{ from_n: 8, to_n: 2 }, { from_n: 9, to_n: 4 }]);
    const events = await rows("select actor_person_id, payload from activity_events where kind = 'ticket.dependency_added' order by occurred_at, id");
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.actor_person_id)).toEqual([h.world().people.contributor, h.world().people.contributor]);
    expect(events[0].payload).toMatchObject({ key: "PRIV-8", dependsOnKey: "PRIV-2" });
  });

  it("uma parte sugerida também pode ser origem? não: índice fora das partes da pessoa é descartado com aviso", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open([{ title: "Receber o diff", description: "" }]), { suggested: [task("Guardar o cursor")], links: [{ de: 1, deTitle: "Guardar o cursor", dependeDe: "PRIV-2" }] });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([{ code: "link_discarded", de: 1, dependeDe: "PRIV-2", reason: "invalid_part" }]);
    expect(await relations()).toEqual([]);
  });

  it("chave que não existe, de outro projeto, do próprio ticket novo ou repetida: descartada com aviso, a criação segue", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(), {
      links: [
        { de: "pai", dependeDe: "PRIV-999" },
        { de: "pai", dependeDe: "OUTRO-1" },
        { de: "pai", dependeDe: "PRIV-8" }, // o número que o ticket novo vai ter
        { de: "pai", dependeDe: "PRIV-2" },
        { de: "pai", dependeDe: "PRIV-2" },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([
      { code: "link_discarded", de: "pai", dependeDe: "PRIV-999", reason: "unknown_ticket" },
      { code: "link_discarded", de: "pai", dependeDe: "OUTRO-1", reason: "unknown_ticket" },
      { code: "link_discarded", de: "pai", dependeDe: "PRIV-8", reason: "unknown_ticket" },
    ]);
    expect(await relations()).toEqual([{ from_n: 8, to_n: 2 }]);
  });

  it("ticket de outro projeto da mesma organização não é ligável", async () => {
    await seedTree(h.pool, h.world());
    await h.pool.query("update projects set next_ticket_number = 2 where id = $1", [h.world().projects.org]);
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,1,'De outro projeto',$2)", [h.world().projects.org, h.world().people.manager]);
    const key = (await rows("select key from projects where id = $1", [h.world().projects.org]))[0].key as string;
    const res = await create(await open(), { links: [{ de: "pai", dependeDe: `${key}-1` }] });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([{ code: "link_discarded", de: "pai", dependeDe: `${key}-1`, reason: "unknown_ticket" }]);
    expect(await relations()).toEqual([]);
  });
});

describe("a criação confere de novo tudo o que veio do cliente", () => {
  it.each([
    ["mais de cinco sugeridas", { suggested: Array.from({ length: 6 }, (_, i) => task(`T${i}`)) }],
    ["mais de cinco ligações", { links: Array.from({ length: 6 }, () => ({ de: "pai", dependeDe: "PRIV-2" })) }],
    ["sugerida sem título", { suggested: [task("")] }],
    ["sugerida sem motivo", { suggested: [task("A", "")] }],
    ["motivo longo demais", { suggested: [task("A", "x".repeat(301))] }],
    ["título longo demais", { suggested: [task("x".repeat(201))] }],
    ["descrição longa demais", { suggested: [task("A", "ok", "x".repeat(601))] }],
    ["motivo com quebra de linha", { suggested: [task("A", "linha um\nlinha dois")] }],
    ["campo desconhecido na sugerida", { suggested: [{ ...task("A"), id: "x" }] }],
    ["chave mal formada", { links: [{ de: "pai", dependeDe: "uuid-qualquer" }] }],
    ["índice negativo", { links: [{ de: -1, dependeDe: "PRIV-2" }] }],
    ["campo desconhecido na ligação", { links: [{ de: "pai", dependeDe: "PRIV-2", motivo: "x" }] }],
  ])("recusa %s com 400 e nada é criado", async (_n, extra) => {
    await seedTree(h.pool, h.world());
    const before = await count("tickets");
    const res = await create(await open(), extra);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await count("tickets")).toBe(before);
  });

  it("sugerida que cita ticket que não existe é descartada com aviso; a criação segue", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(), { suggested: [task("A", "depende de PRIV-999"), task("B")] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.children.map((c: { title: string }) => c.title)).toEqual(["B"]);
    expect(res.body.warnings).toEqual([{ code: "suggested_discarded", title: "A", reason: "unknown_keys" }]);
  });

  it("chave que não existe no texto do próprio rascunho continua recusando a criação (409)", async () => {
    await seedTree(h.pool, h.world());
    const res = await create(await open(undefined, "Veja PRIV-999"), {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("unknown_ticket_keys");
  });

  it("se a criação falha, nada fica: nem ticket, nem sugerida, nem ligação", async () => {
    await seedTree(h.pool, h.world());
    const id = await open(undefined, "x".repeat(19_990));
    const tickets = await count("tickets");
    const events = await count("activity_events");
    const res = await create(id, { suggested: [task("A")], links: [{ de: "pai", dependeDe: "PRIV-2" }] });
    expect(res.status).toBe(409);
    expect(await count("tickets")).toBe(tickets);
    expect(await relations()).toEqual([]);
    expect(await count("activity_events")).toBe(events);
  });
});

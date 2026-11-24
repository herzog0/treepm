import { describe, expect, it } from "vitest";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;

const open = async (who: Who = "contributor") =>
  (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message: "Quero corrigir o login" })).body.id as string;
const create = (id: string, parentId: string | null, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/ticket-conversations/${id}/ticket`, as(who, org), { placedBy: "map", parentId });

describe("POST /ticket-conversations/:id/ticket — a criação", () => {
  it("cria o ticket do rascunho no pai informado e fecha a conversa", async () => {
    const tree: Tree = await seedTree(h.pool, h.world());
    const id = await open();
    const res = await create(id, tree.sso);
    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({
      projectId: priv(),
      parentId: tree.sso,
      title: "Rascunho 1",
      description: "Pedido original:\n\n> Quero corrigir o login\n\nQuero corrigir o login",
      key: "PRIV-8",
      number: 8,
      createdByPersonId: h.world().people.contributor,
    });
    expect(res.body.conversation).toMatchObject({ id, status: "ticket_created", createdTicketId: res.body.ticket.id });
    const stored = await rows("select status, created_ticket_id, closed_at from ticket_conversations where id = $1", [id]);
    expect(stored[0]).toMatchObject({ status: "ticket_created", created_ticket_id: res.body.ticket.id });
    expect(stored[0].closed_at).not.toBeNull();
  });

  it("o ticket criado pela conversa é um ticket comum, sem tipo, com situação todo e sem progresso", async () => {
    const tree: Tree = await seedTree(h.pool, h.world());
    const id = await open();
    const res = await create(id, tree.auth);
    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({ status: "todo", progress: null });
    expect(res.body.ticket).not.toHaveProperty("kind");
  });

  it("o pai pode ser qualquer ticket do projeto, inclusive um sem filhos", async () => {
    const tree: Tree = await seedTree(h.pool, h.world());
    const id = await open();
    const res = await create(id, tree.login);
    expect(res.status).toBe(201);
    expect(res.body.ticket.parentId).toBe(tree.login);
  });

  it("pai nulo cria um ticket de raiz", async () => {
    await seedTree(h.pool, h.world());
    const id = await open();
    const res = await create(id, null);
    expect(res.status).toBe(201);
    expect(res.body.ticket.parentId).toBeNull();
  });

  it("usa o rascunho atual, inclusive o editado à mão", async () => {
    const id = await open();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Título meu", description: "Texto meu" });
    const res = await create(id, null);
    expect(res.body.ticket).toMatchObject({ title: "Título meu", description: "Pedido original:\n\n> Quero corrigir o login\n\nTexto meu" });
  });

  it("grava ticket.created com a origem assistente e a conversa", async () => {
    const id = await open();
    const res = await create(id, null);
    const events = await rows("select kind, subject_id, actor_person_id, payload from activity_events where kind = 'ticket.created'");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subject_id: res.body.ticket.id, actor_person_id: h.world().people.contributor });
    expect(events[0].payload).toMatchObject({ origin: "assistant", conversationId: id, title: "Rascunho 1", parentId: null, status: "todo" });
  });

  it("administrador e gestor também criam a partir das próprias conversas", async () => {
    const admin = await open("admin");
    expect((await create(admin, null, "admin")).status).toBe(201);
    const manager = await open("manager");
    expect((await create(manager, null, "manager")).status).toBe(201);
  });

  it("não chama nenhum provedor", async () => {
    const id = await open();
    h.conversation().calls.length = 0;
    await create(id, null);
    expect(h.conversation().calls).toHaveLength(0);
    expect(h.judge().calls).toHaveLength(0);
    expect(h.summarizer().calls).toHaveLength(0);
  });
});

describe("criação idempotente", () => {
  it("repetir devolve o mesmo ticket, sem criar outro nem outro evento", async () => {
    const tree = await seedTree(h.pool, h.world());
    const id = await open();
    const first = await create(id, tree.sso);
    const again = await create(id, tree.sso);
    expect(again.status).toBe(201);
    expect(again.body.ticket.id).toBe(first.body.ticket.id);
    expect(await count("tickets")).toBe(8);
    expect((await rows("select count(*)::int as n from activity_events where kind = 'ticket.created'"))[0].n).toBe(1);
  });

  it("repetir com outro pai devolve o ticket já criado, onde ele está", async () => {
    const tree = await seedTree(h.pool, h.world());
    const id = await open();
    const first = await create(id, tree.sso);
    const again = await create(id, tree.billing);
    expect(again.body.ticket.id).toBe(first.body.ticket.id);
    expect(again.body.ticket.parentId).toBe(tree.sso);
  });

  it("duas chamadas em paralelo criam um só ticket", async () => {
    const tree = await seedTree(h.pool, h.world());
    const id = await open();
    const [a, b, c] = await Promise.all([create(id, tree.sso), create(id, tree.sso), create(id, tree.sso)]);
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(new Set([a.body.ticket.id, b.body.ticket.id, c.body.ticket.id]).size).toBe(1);
    expect(await count("tickets")).toBe(8);
    expect((await rows("select count(*)::int as n from activity_events where kind = 'ticket.created'"))[0].n).toBe(1);
  });

  it("se o ticket criado foi removido depois, a conversa continua fechada: 409 conversation_closed", async () => {
    const id = await open();
    const first = await create(id, null);
    await h.pool.query("delete from tickets where id = $1", [first.body.ticket.id]);
    const res = await create(id, null);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("conversation_closed");
  });
});

describe("criação — validações do ticket", () => {
  it("pai inexistente: 404 e a conversa continua aberta", async () => {
    const id = await open();
    const res = await create(id, UNKNOWN_ID);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Ticket pai não encontrado.");
    expect((await rows("select status from ticket_conversations where id = $1", [id]))[0].status).toBe("open");
    expect(await count("tickets")).toBe(0);
  });

  it("pai de outro projeto da mesma organização: 404", async () => {
    const id = await open();
    const other = await rows(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,1,'Fora',$2) returning id",
      [h.world().projects.org, h.world().people.manager],
    );
    const res = await create(id, other[0].id);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Ticket pai não encontrado.");
  });

  it("pai de outra organização: 404", async () => {
    const id = await open();
    const other = await rows(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_B',$1,1,'Fora',$2) returning id",
      [h.world().other.project, h.world().other.person],
    );
    const res = await create(id, other[0].id);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Ticket pai não encontrado.");
  });

  it("sem rascunho: 409 draft_required", async () => {
    h.conversation().reply = () => ({ message: "Conte mais", draft: null, ready: false, model: "claude-opus-5-5" });
    const id = await open();
    const res = await create(id, null);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("draft_required");
  });

  it.each([
    ["sem parentId", {}],
    ["parentId que não é id", { parentId: "abc" }],
    ["campo desconhecido", { parentId: null, title: "outro" }],
  ])("corpo inválido (%s): 400", async (_n, body) => {
    const id = await open();
    expect((await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), body)).status).toBe(400);
    expect(await count("tickets")).toBe(0);
  });

  it("conversa descartada: 409 conversation_closed", async () => {
    const id = await open();
    await h.pool.query("update ticket_conversations set status = 'discarded' where id = $1", [id]);
    expect(errorOf(await create(id, null))).toBe("conversation_closed");
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const id = await open();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect(errorOf(await create(id, null))).toBe("project_archived");
    expect(await count("tickets")).toBe(0);
  });

  it("papel rebaixado a leitor: 403", async () => {
    const id = await open();
    await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]);
    expect((await create(id, null)).status).toBe(403);
    expect(await count("tickets")).toBe(0);
  });
});

describe("criação — privacidade", () => {
  it.each(["admin", "manager", "teamAdmin", "reader", "plain"] as const)("%s não cria a partir da conversa alheia (404)", async (who) => {
    const id = await open();
    const res = await create(id, null, who);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Conversa não encontrada.");
    expect(await count("tickets")).toBe(0);
    expect((await rows("select status from ticket_conversations where id = $1", [id]))[0].status).toBe("open");
  });

  it("outra organização não enxerga a conversa (404)", async () => {
    const id = await open();
    const res = await create(id, null, "outsider", "org_B");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Conversa não encontrada.");
  });

  it("projeto que a pessoa deixou de ver: 404", async () => {
    const id = await open();
    await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]);
    const res = await create(id, null);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe("Projeto não encontrado.");
  });

  it("apagar a conversa não apaga o ticket criado", async () => {
    const id = await open();
    const res = await create(id, null);
    expect((await h.call("DELETE", `/api/ticket-conversations/${id}`, as("contributor"))).status).toBe(204);
    expect(await count("tickets")).toBe(1);
    expect((await rows("select id from tickets"))[0].id).toBe(res.body.ticket.id);
  });
});

describe("criação — sem as chaves da IA", () => {
  const off = useHarness(TEST_CONFIG);

  it("funciona: criar não chama provedor", async () => {
    const world = off.world();
    const inserted = await off.pool.query(
      "insert into ticket_conversations (org_id, project_id, author_person_id, draft_title, draft_description) values ('org_A',$1,$2,'Do rascunho','Texto') returning id",
      [world.projects.priv, world.people.contributor],
    );
    const res = await off.call("POST", `/api/ticket-conversations/${inserted.rows[0].id}/ticket`, as("contributor"), { placedBy: "map", parentId: null });
    expect(res.status).toBe(201);
    expect(res.body.ticket.title).toBe("Do rascunho");
  });
});

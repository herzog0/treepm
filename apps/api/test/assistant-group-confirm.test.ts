import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import type { Tree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;

const open = async (who: Who = "contributor") =>
  (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message: "Quero corrigir o login" })).body.id as string;
type Group = { title: string; description: string; ticketIds: string[] };
const confirm = (id: string, parentId: string | null, group: Group | undefined, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/ticket-conversations/${id}/ticket`, as(who, org), group ? { placedBy: "map", parentId, group } : { placedBy: "map", parentId });
const group = (ticketIds: string[], over: Partial<Group> = {}): Group => ({ title: "Entrada alternativa", description: "Formas de entrar.", ticketIds, ...over });

let tree: Tree;
const start = async () => {
  tree = await seedTree(h.pool, h.world());
  return open();
};
/** Dois tickets soltos em SSO (SAML já está lá). */
const addToSso = async (title: string) => {
  const number = (await rows("select next_ticket_number as n from projects where id = $1", [priv()]))[0].n as number;
  await h.pool.query("update projects set next_ticket_number = next_ticket_number + 1 where id = $1", [priv()]);
  return (
    await rows(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5) returning id",
      [priv(), number, tree.sso, title, h.world().people.manager],
    )
  )[0].id as string;
};

describe("POST /ticket-conversations/:id/ticket com group — o caminho feliz", () => {
  it("cria o agrupador em parentId, move os tickets para ele e cria o ticket novo dentro", async () => {
    const id = await start();
    const extra = await addToSso("Parser de XML");
    const res = await confirm(id, tree.sso, group([tree.saml, extra]));
    expect(res.status).toBe(201);
    const created = (await rows("select id, parent_id, title, description, status from tickets where title = 'Entrada alternativa'"))[0];
    // O pai novo é um ticket comum, com situação todo.
    expect(created).toMatchObject({ parent_id: tree.sso, description: "Formas de entrar.", status: "todo" });
    for (const moved of [tree.saml, extra]) {
      expect((await rows("select parent_id from tickets where id = $1", [moved]))[0]).toEqual({ parent_id: created.id });
    }
    expect(res.body.ticket).toMatchObject({ parentId: created.id, status: "todo", title: "Rascunho 1" });
    expect(res.body.conversation).toMatchObject({ status: "ticket_created", createdTicketId: res.body.ticket.id });
    expect(await count("tickets")).toBe(7 + 1 + 1 + 1);
  });

  it("na raiz do projeto (parentId nulo) o agrupador nasce na raiz e o ticket solto vai para ele", async () => {
    const id = await start();
    const res = await confirm(id, null, group([tree.loose]));
    expect(res.status).toBe(201);
    const created = (await rows("select id, parent_id from tickets where title = 'Entrada alternativa'"))[0];
    expect(created).toMatchObject({ parent_id: null });
    expect(res.body.ticket.parentId).toBe(created.id);
    expect((await rows("select parent_id from tickets where id = $1", [tree.loose]))[0].parent_id).toBe(created.id);
  });

  it("grava ticket.created do agrupador, ticket.updated de cada movido e ticket.created do novo, todos com a origem assistente", async () => {
    const id = await start();
    const extra = await addToSso("Parser de XML");
    const res = await confirm(id, tree.sso, group([tree.saml, extra]));
    const created = (await rows("select id from tickets where title = 'Entrada alternativa'"))[0].id as string;
    const events = await rows("select kind, subject_id, actor_person_id, payload from activity_events order by created_at, id");
    expect(events.map((e) => e.kind)).toEqual(["ticket.created", "ticket.updated", "ticket.updated", "ticket.created"]);
    expect(events[0]).toMatchObject({ subject_id: created, actor_person_id: h.world().people.contributor });
    expect(events[0].payload).toMatchObject({ origin: "assistant", conversationId: id, title: "Entrada alternativa", parentId: tree.sso });
    expect(events.slice(1, 3).map((e) => e.subject_id)).toEqual([tree.saml, extra]);
    for (const event of events.slice(1, 3)) {
      expect(event.payload).toMatchObject({ origin: "assistant", conversationId: id, fields: ["parentId"], parentId: { from: tree.sso, to: created } });
    }
    expect(events[3]).toMatchObject({ subject_id: res.body.ticket.id });
    expect(events[3].payload).toMatchObject({ origin: "assistant", conversationId: id, parentId: created });
  });

  it("a ordem dos números: agrupador, depois o ticket novo", async () => {
    const id = await start();
    const res = await confirm(id, null, group([tree.loose]));
    const numbers = await rows("select title, number from tickets where title in ('Entrada alternativa', 'Rascunho 1') order by number");
    expect(numbers.map((r) => r.title)).toEqual(["Entrada alternativa", "Rascunho 1"]);
    expect(res.body.ticket.number).toBe(numbers[1].number);
  });
});

describe("POST /ticket-conversations/:id/ticket com group — grouping_changed", () => {
  const untouched = async (before: number, id: string) => {
    expect(await count("tickets")).toBe(before);
    expect(await count("activity_events")).toBe(0);
    expect((await rows("select status from ticket_conversations where id = $1", [id]))[0].status).toBe("open");
    expect((await rows("select count(*)::int as n from tickets where title = 'Entrada alternativa'"))[0].n).toBe(0);
  };

  it("ticket que mudou de pai: 409 e nada é criado nem movido", async () => {
    const id = await start();
    const extra = await addToSso("Parser de XML");
    await h.pool.query("update tickets set parent_id = $2 where id = $1", [extra, tree.billing]);
    const res = await confirm(id, tree.sso, group([tree.saml, extra]));
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("grouping_changed");
    await untouched(8, id);
    expect((await rows("select parent_id from tickets where id = $1", [tree.saml]))[0].parent_id).toBe(tree.sso);
  });

  it("ticket que ganhou um filho desde a proposta: 409", async () => {
    const id = await start();
    await h.pool.query(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A', $1, 40, $2, 'Filho do SAML', $3)",
      [priv(), tree.saml, h.world().people.manager],
    );
    await h.pool.query("update projects set next_ticket_number = 41 where id = $1", [priv()]);
    const res = await confirm(id, tree.sso, group([tree.saml]));
    expect(errorOf(res)).toBe("grouping_changed");
    await untouched(8, id);
  });

  it("ticket removido: 409", async () => {
    const id = await start();
    await h.pool.query("delete from tickets where id = $1", [tree.saml]);
    const res = await confirm(id, tree.sso, group([tree.saml]));
    expect(errorOf(res)).toBe("grouping_changed");
    await untouched(6, id);
  });

  it("ticket de outro projeto: 409", async () => {
    const id = await start();
    const foreign = (
      await rows(
        "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,1,'De outro projeto',$2) returning id",
        [h.world().projects.org, h.world().people.manager],
      )
    )[0].id as string;
    const res = await confirm(id, tree.sso, group([tree.saml, foreign]));
    expect(errorOf(res)).toBe("grouping_changed");
    expect(await count("tickets")).toBe(8);
    expect((await rows("select parent_id from tickets where id = $1", [tree.saml]))[0].parent_id).toBe(tree.sso);
  });

  it("id inexistente (ou de outra organização, pela RLS): 409", async () => {
    const id = await start();
    const res = await confirm(id, tree.sso, group(["0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000"]));
    expect(errorOf(res)).toBe("grouping_changed");
    await untouched(7, id);
  });

  it("a conversa continua utilizável depois do 409", async () => {
    const id = await start();
    await h.pool.query("delete from tickets where id = $1", [tree.saml]);
    await confirm(id, tree.sso, group([tree.saml]));
    expect((await confirm(id, tree.sso, undefined)).status).toBe(201);
  });
});

describe("POST /ticket-conversations/:id/ticket com group — regras da rota", () => {
  it("sem group o comportamento é o de sempre", async () => {
    const id = await start();
    const res = await confirm(id, tree.sso, undefined);
    expect(res.status).toBe(201);
    expect(res.body.ticket.parentId).toBe(tree.sso);
    expect(await count("tickets")).toBe(8);
  });

  it("repetir depois de criado devolve o ticket criado e ignora group (inclusive um group inválido)", async () => {
    const id = await start();
    const first = await confirm(id, tree.sso, group([tree.saml]));
    const again = await confirm(id, tree.sso, group([tree.saml, "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000"]));
    expect(again.status).toBe(201);
    expect(again.body.ticket.id).toBe(first.body.ticket.id);
    expect(again.body.ticket.parentId).toBe(first.body.ticket.parentId);
    expect(await count("tickets")).toBe(9);
    expect(await count("activity_events")).toBe(3);
  });

  it("duas chamadas em paralelo criam um só agrupador", async () => {
    const id = await start();
    const [a, b] = await Promise.all([confirm(id, tree.sso, group([tree.saml])), confirm(id, tree.sso, group([tree.saml]))]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.ticket.id).toBe(b.body.ticket.id);
    expect((await rows("select count(*)::int as n from tickets where title = 'Entrada alternativa'"))[0].n).toBe(1);
  });

  it.each([
    ["sem tickets", group([])],
    ["ticket repetido", group([tree_loose(), tree_loose()])],
    ["título vazio", group([tree_loose()], { title: "  " })],
    ["título de 201 caracteres", group([tree_loose()], { title: "x".repeat(201) })],
    ["descrição de 20001 caracteres", group([tree_loose()], { description: "x".repeat(20_001) })],
    ["id que não é uuid", group(["abc"])],
  ])("corpo inválido (%s): 400 e nada é criado", async (_n, body) => {
    const id = await start();
    const patched = { ...body, ticketIds: body.ticketIds.map((t) => (t === "LOOSE" ? tree.loose : t)) };
    const res = await confirm(id, null, patched);
    expect(res.status).toBe(400);
    expect(await count("tickets")).toBe(7);
  });

  it("campo desconhecido em group: 400", async () => {
    const id = await start();
    const res = await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), {
      placedBy: "map",
      parentId: null,
      group: { ...group([tree.loose]), kind: "ticket" },
    });
    expect(res.status).toBe(400);
  });

  it("parentId pode ser qualquer ticket, inclusive um sem filhos (ADR 0034)", async () => {
    const id = await start();
    const kid = (await rows(
      "insert into tickets (org_id, project_id, number, parent_id, title, created_by_person_id) values ('org_A', $1, 40, $2, 'Filho do login', $3) returning id",
      [priv(), tree.login, h.world().people.manager],
    ))[0].id as string;
    await h.pool.query("update projects set next_ticket_number = 41 where id = $1", [priv()]);
    const res = await confirm(id, tree.login, group([kid]));
    expect(res.status).toBe(201);
    const created = (await rows("select parent_id from tickets where title = 'Entrada alternativa'"))[0];
    expect(created.parent_id).toBe(tree.login);
  });

  it("não chama nenhum provedor", async () => {
    const id = await start();
    await confirm(id, tree.sso, group([tree.saml]));
    expect(h.affinity().calls.length + h.namer().calls.length + h.judge().calls.length + h.summarizer().calls.length).toBe(0);
  });
});

describe("POST /ticket-conversations/:id/ticket com group — permissão e isolamento", () => {
  it("leitor não confirma: 403, nada é criado nem movido", async () => {
    const id = await start();
    await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]);
    const res = await confirm(id, tree.sso, group([tree.saml]));
    expect(res.status).toBe(403);
    expect(await count("tickets")).toBe(7);
    expect((await rows("select parent_id from tickets where id = $1", [tree.saml]))[0].parent_id).toBe(tree.sso);
  });

  it("projeto arquivado: 409 project_archived", async () => {
    const id = await start();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect(errorOf(await confirm(id, tree.sso, group([tree.saml])))).toBe("project_archived");
    expect(await count("tickets")).toBe(7);
  });

  it("outra organização: 404", async () => {
    const id = await start();
    const res = await confirm(id, tree.sso, group([tree.saml]), "outsider", "org_B");
    expect(res.status).toBe(404);
    expect(await count("tickets")).toBe(7);
  });

  it("conversa de outra pessoa: 404", async () => {
    const id = await start();
    expect((await confirm(id, tree.sso, group([tree.saml]), "manager")).status).toBe(404);
    expect(await count("tickets")).toBe(7);
  });
});

/** Marcador trocado pelo id real dentro do teste (a árvore só existe depois do `start`). */
function tree_loose(): string {
  return "LOOSE";
}

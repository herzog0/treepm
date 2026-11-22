import { describe, expect, it } from "vitest";
import { APP_URL } from "@treepm/db/testing";
import { createPrismaClient, withTenant } from "@treepm/db";
import type { TenantClient } from "@treepm/db";
import { buildActor } from "../src/access/actor.js";
import { TicketActivityService } from "../src/tickets/ticket-activity.service.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0040, fatia 2: comentar, editar e remover; a atividade passa a intercalar comentários e mudanças.
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const MIN = 60_000;
const BASE = Date.parse("2026-11-01T12:00:00Z");
type Body = Record<string, unknown>;
type Person = { id: string; displayName: string; avatarUrl: string | null };
type Entry = { id: string; type: string; occurredAt: string; actor: Person | null; [k: string]: unknown };
type Page = { entries: Entry[]; before: string | null; canComment: boolean };
type Reader = Who | "outsider";

const personId = (who: Who) => h.world().people[who];
const add = async (body: Body = {}, project = priv()): Promise<{ id: string; number: number; key: string }> => {
  const res = await h.call("POST", `/api/projects/${project}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; key: string };
};
const patch = async (id: string, body: Body, who: Who = "admin") => {
  const res = await h.call("PATCH", `/api/tickets/${id}`, as(who), body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};
const post = (ticketId: string, body: unknown, who: Reader = "contributor", org = "org_A") => h.call("POST", `/api/tickets/${ticketId}/comments`, as(who, org), body);
const edit = (commentId: string, body: unknown, who: Reader = "contributor", org = "org_A") => h.call("PATCH", `/api/comments/${commentId}`, as(who, org), body);
const remove = (commentId: string, who: Reader = "contributor", org = "org_A") => h.call("DELETE", `/api/comments/${commentId}`, as(who, org));
const say = async (ticketId: string, text: string, who: Who = "contributor"): Promise<Entry> => {
  const res = await post(ticketId, { body: text }, who);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Entry;
};
const feed = (id: string, query = "", who: Reader = "admin", org = "org_A") => h.call("GET", `/api/tickets/${id}/activity${query}`, as(who, org));
const page = async (id: string, query = "", who: Reader = "admin"): Promise<Page> => {
  const res = await feed(id, query, who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Page;
};
const types = (p: Page) => p.entries.map((e) => e.type);
const row = async (commentId: string) => (await h.pool.query("select * from ticket_comments where id = $1", [commentId])).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await h.pool.query(sql, params)).rows[0].count);
const commentEvents = async () => (await h.pool.query("select * from activity_events where kind like 'ticket.comment_%' order by occurred_at, id")).rows;
const events = async (id: string) => (await h.pool.query("select * from activity_events where subject_id = $1 and kind not like 'ticket.comment_%' order by occurred_at, id", [id])).rows;
const placeEvents = async (id: string, minutes: number[]) => {
  for (const [i, r] of (await events(id)).entries()) await h.pool.query("update activity_events set occurred_at = $1 where id = $2", [new Date(BASE + (minutes[i] ?? 0) * MIN), r.id]);
};
const placeComment = (commentId: string, minutes: number) => h.pool.query("update ticket_comments set created_at = $1 where id = $2", [new Date(BASE + minutes * MIN), commentId]);

describe("comentar: POST tickets/:id/comments", () => {
  it("gestor, colaborador e administrador comentam; a resposta é a entrada de atividade do comentário", async () => {
    const t = await add();
    for (const who of ["manager", "contributor", "admin"] as Who[]) {
      const res = await post(t.id, { body: `Olá de ${who}` }, who);
      expect(res.status, who).toBe(201);
      const entry = res.body as Entry;
      expect(entry).toMatchObject({
        type: "comment",
        body: `Olá de ${who}`,
        editedAt: null,
        removed: false,
        canEdit: true,
        canRemove: true,
        actor: { id: personId(who), displayName: `Nome ${who}` },
      });
      expect(typeof entry.occurredAt).toBe("string");
      expect(Object.keys(entry).sort()).toEqual(["actor", "area", "body", "canEdit", "canRemove", "editedAt", "id", "occurredAt", "removed", "type"]);
      const saved = await row(entry.id);
      expect(saved).toMatchObject({ body: `Olá de ${who}`, author_person_id: personId(who), project_id: priv(), ticket_id: t.id, edited_at: null, removed_at: null, removed_by_person_id: null });
    }
  });

  it("leitor recebe 403; sem acesso ao projeto, ticket inexistente e outra organização recebem 404, sem gravar", async () => {
    const t = await add();
    expect((await post(t.id, { body: "x" }, "reader")).status).toBe(403);
    const denied = await post(t.id, { body: "x" }, "plain");
    const unknown = await post(UNKNOWN_ID, { body: "x" });
    const other = await post(t.id, { body: "x" }, "outsider", "org_B");
    expect([denied.status, unknown.status, other.status]).toEqual([404, 404, 404]);
    expect(denied.body).toEqual(unknown.body);
    expect(await count("select count(*) from ticket_comments")).toBe(0);
    expect(await commentEvents()).toHaveLength(0);
  });

  it("corpo: apara, aceita 1 a 10.000 e recusa vazio, só espaços, grande demais, tipo errado e campo extra", async () => {
    const t = await add();
    expect(((await post(t.id, { body: "  oi \n" })).body as Entry).body).toBe("oi");
    expect((await post(t.id, { body: "a" })).status).toBe(201);
    expect((await post(t.id, { body: "a".repeat(10_000) })).status).toBe(201);
    expect((await post(t.id, { body: `  ${"a".repeat(10_000)}\n` })).status).toBe(201);
    for (const bad of [{ body: "" }, { body: " \n\t " }, { body: "a".repeat(10_001) }, { body: 7 }, {}, { body: "x", extra: 1 }, { body: null }]) {
      const res = await post(t.id, bad);
      expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect(await count("select count(*) from ticket_comments")).toBe(4);
  });

  it("projeto arquivado recusa comentar, editar e remover com a mesma recusa das outras alterações", async () => {
    const t = await add();
    const made = await say(t.id, "antes de arquivar");
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const patchTicket = await h.call("PATCH", `/api/tickets/${t.id}`, as("manager"), { title: "x" });
    expect(patchTicket.status).toBe(409);
    for (const res of [await post(t.id, { body: "x" }), await edit(made.id, { body: "y" }), await remove(made.id)]) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "project_archived" } });
    }
    expect((await row(made.id)).body).toBe("antes de arquivar");
    expect((await row(made.id)).removed_at).toBeNull();
  });

  it("a chave de outro ticket no corpo não cria nem mexe em ligações", async () => {
    const target = await add({ title: "Alvo" });
    const t = await add({ title: "Origem", description: `vê ${target.key}` });
    const relations = async () => JSON.stringify((await h.pool.query("select * from ticket_relations order by id")).rows);
    const before = await relations();
    expect(JSON.parse(before)).toHaveLength(1);
    await say(t.id, `Depende de ${target.key} e de ${target.key.toLowerCase()}.`);
    await say(target.id, `Voltando para ${t.key}.`);
    expect(await relations()).toBe(before);
  });
});

describe("editar: PATCH comments/:id", () => {
  it("só o autor edita: grava o corpo novo e a data de edição", async () => {
    const t = await add();
    const made = await say(t.id, "primeiro");
    const res = await edit(made.id, { body: "  segundo " });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: made.id, type: "comment", body: "segundo", removed: false, canEdit: true, canRemove: true });
    expect(typeof (res.body as Entry).editedAt).toBe("string");
    const saved = await row(made.id);
    expect(saved.body).toBe("segundo");
    expect(saved.edited_at).toBeInstanceOf(Date);
    expect(saved.created_at.getTime()).toBe(Date.parse(made.occurredAt));
  });

  it("gestor, administrador, outro colaborador e leitor não editam texto alheio (403)", async () => {
    const t = await add();
    const made = await say(t.id, "meu");
    for (const who of ["manager", "admin", "reader"] as Who[]) expect((await edit(made.id, { body: "x" }, who)).status, who).toBe(403);
    expect((await row(made.id)).body).toBe("meu");
  });

  it("quem escreveu e deixou de poder comentar (virou leitor) não edita mais", async () => {
    const t = await add();
    const made = await say(t.id, "meu");
    await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [personId("contributor")]);
    expect((await edit(made.id, { body: "x" })).status).toBe(403);
  });

  it("corpo igual ao atual não grava nada, nem evento", async () => {
    const t = await add();
    const made = await say(t.id, "igual");
    const events0 = await count("select count(*) from activity_events");
    const res = await edit(made.id, { body: "  igual\n" });
    expect(res.status).toBe(200);
    expect((res.body as Entry).editedAt).toBeNull();
    expect((await row(made.id)).edited_at).toBeNull();
    expect(await count("select count(*) from activity_events")).toBe(events0);
  });

  it("comentário removido não pode ser editado: 409 comment_removed", async () => {
    const t = await add();
    const made = await say(t.id, "x");
    expect((await remove(made.id)).status).toBe(204);
    const res = await edit(made.id, { body: "ressuscita" });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "comment_removed" } });
    expect((await row(made.id)).body).toBe("");
  });

  it("inexistente, sem acesso e outra organização: o mesmo 404; corpo inválido é 400; id inválido é 400", async () => {
    const t = await add();
    const made = await say(t.id, "x");
    const denied = await edit(made.id, { body: "y" }, "plain");
    const unknown = await edit(UNKNOWN_ID, { body: "y" });
    const other = await edit(made.id, { body: "y" }, "outsider", "org_B");
    expect([denied.status, unknown.status, other.status]).toEqual([404, 404, 404]);
    expect(denied.body).toEqual(unknown.body);
    for (const bad of [{ body: "" }, { body: "a".repeat(10_001) }, {}, { body: "y", x: 1 }]) expect((await edit(made.id, bad)).status).toBe(400);
    expect((await edit("nao-e-uuid", { body: "y" })).status).toBe(400);
  });
});

describe("remover: DELETE comments/:id", () => {
  it("o autor, o gestor e o administrador removem; o corpo some do banco na mesma gravação", async () => {
    const t = await add();
    for (const who of ["contributor", "manager", "admin"] as Who[]) {
      const made = await say(t.id, `segredo de ${who}`);
      const res = await remove(made.id, who);
      expect(res.status, who).toBe(204);
      const saved = await row(made.id);
      expect(saved.body).toBe("");
      expect(saved.removed_at).toBeInstanceOf(Date);
      expect(saved.removed_by_person_id).toBe(personId(who));
      expect(saved.author_person_id).toBe(personId("contributor"));
    }
  });

  it("outro colaborador, o leitor e quem não vê o projeto não removem texto alheio", async () => {
    const t = await add();
    const made = await say(t.id, "do gestor", "manager");
    expect((await remove(made.id, "contributor")).status).toBe(403);
    expect((await remove(made.id, "reader")).status).toBe(403);
    expect((await remove(made.id, "plain")).status).toBe(404);
    expect((await remove(made.id, "outsider", "org_B")).status).toBe(404);
    expect((await remove(UNKNOWN_ID)).status).toBe(404);
    expect((await row(made.id)).removed_at).toBeNull();
  });

  it("é idempotente: repetir não grava de novo, não muda quem removeu e não cria outro evento", async () => {
    const t = await add();
    const made = await say(t.id, "x");
    expect((await remove(made.id, "contributor")).status).toBe(204);
    const first = await row(made.id);
    const events0 = await count("select count(*) from activity_events");
    expect((await remove(made.id, "manager")).status).toBe(204);
    expect((await remove(made.id, "contributor")).status).toBe(204);
    const second = await row(made.id);
    expect(second.removed_at).toEqual(first.removed_at);
    expect(second.removed_by_person_id).toBe(personId("contributor"));
    expect(await count("select count(*) from activity_events")).toBe(events0);
  });
});

describe("eventos: três tipos, sem o corpo", () => {
  it("comment_added, comment_edited e comment_removed no assunto ticket, com a chave e o id do comentário", async () => {
    const t = await add({ title: "Com comentário" });
    const made = await say(t.id, "texto-reconhecivel-ABC", "contributor");
    await edit(made.id, { body: "texto-editado-DEF" });
    await remove(made.id, "manager");
    const rows = await commentEvents();
    expect(rows.map((r) => r.kind)).toEqual(["ticket.comment_added", "ticket.comment_edited", "ticket.comment_removed"]);
    for (const r of rows) {
      expect(r.subject_type).toBe("ticket");
      expect(r.subject_id).toBe(t.id);
      expect(r.payload).toEqual({ key: t.key, commentId: made.id });
    }
    expect(rows.map((r) => r.actor_person_id)).toEqual([personId("contributor"), personId("contributor"), personId("manager")]);
  });

  it("nem o corpo nem trecho dele chegam a activity_events, em nenhum momento", async () => {
    const t = await add();
    const made = await say(t.id, "frase-secreta-unica-123 com mais texto");
    await edit(made.id, { body: "outra-frase-secreta-456 com mais texto" });
    const all = async () => JSON.stringify((await h.pool.query("select * from activity_events")).rows);
    for (const needle of ["frase-secreta-unica", "frase-secreta-456", "mais texto", "secreta"]) expect(await all()).not.toContain(needle);
    await remove(made.id);
    for (const needle of ["frase-secreta-unica", "frase-secreta-456", "mais texto", "secreta"]) expect(await all()).not.toContain(needle);
  });
});

describe("a atividade intercala comentários e mudanças", () => {
  it("na ordem de tempo (da mais nova para a mais antiga), sem os eventos ticket.comment_*", async () => {
    const t = await add({ title: "A" });
    await patch(t.id, { title: "B" });
    const c1 = await say(t.id, "um");
    await patch(t.id, { status: "in_progress" });
    const c2 = await say(t.id, "dois");
    await edit(c2.id, { body: "dois!" });
    await placeEvents(t.id, [0, 1, 3, 5, 6, 7]);
    await placeComment(c1.id, 2);
    await placeComment(c2.id, 4);
    const p = await page(t.id);
    expect(types(p)).toEqual(["comment", "status_changed", "comment", "title_changed", "created"]);
    expect(p.entries.map((e) => e.id).slice(0, 1)).toEqual([c2.id]);
    expect(p.entries[2]?.id).toBe(c1.id);
    expect(p.before).toBeNull();
    expect(Date.parse(p.entries[0]?.occurredAt as string)).toBe(BASE + 4 * MIN);
    expect(p.entries[0]).toMatchObject({ body: "dois!", removed: false, actor: { id: personId("contributor") } });
    expect(typeof p.entries[0]?.editedAt).toBe("string");
    expect(p.entries[2]).toMatchObject({ body: "um", editedAt: null });
  });

  it("removido: body nulo, removed verdadeiro, com autor e data de criação, sem ações", async () => {
    const t = await add();
    const made = await say(t.id, "apagado");
    await remove(made.id, "manager");
    const p = await page(t.id, "", "manager");
    const entry = p.entries.find((e) => e.type === "comment") as Entry;
    expect(entry).toMatchObject({ id: made.id, body: null, removed: true, canEdit: false, canRemove: false, actor: { id: personId("contributor") } });
    expect(Date.parse(entry.occurredAt)).toBe(Date.parse(made.occurredAt));
    expect(JSON.stringify(p)).not.toContain("apagado");
  });

  it("canComment, canEdit e canRemove para cada quem lê", async () => {
    const t = await add();
    const mine = await say(t.id, "da colaboradora", "contributor");
    const theirs = await say(t.id, "do gestor", "manager");
    const expected: Record<string, { canComment: boolean; mine: [boolean, boolean]; theirs: [boolean, boolean] }> = {
      admin: { canComment: true, mine: [false, true], theirs: [false, true] },
      manager: { canComment: true, mine: [false, true], theirs: [true, true] },
      contributor: { canComment: true, mine: [true, true], theirs: [false, false] },
      reader: { canComment: false, mine: [false, false], theirs: [false, false] },
    };
    for (const [who, want] of Object.entries(expected)) {
      const p = await page(t.id, "", who as Who);
      const flags = (id: string) => {
        const e = p.entries.find((x) => x.id === id) as Entry;
        return [e["canEdit"], e["canRemove"]];
      };
      expect(p.canComment, who).toBe(want.canComment);
      expect(flags(mine.id), `${who} mine`).toEqual(want.mine);
      expect(flags(theirs.id), `${who} theirs`).toEqual(want.theirs);
    }
  });

  it("projeto arquivado: lê os comentários, mas canComment, canEdit e canRemove são falsos para todos", async () => {
    const t = await add();
    const made = await say(t.id, "lido");
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    for (const who of ["admin", "manager", "contributor", "reader"] as Who[]) {
      const p = await page(t.id, "", who);
      expect(p.canComment, who).toBe(false);
      expect(p.entries.find((e) => e.id === made.id)).toMatchObject({ body: "lido", canEdit: false, canRemove: false });
    }
  });

  it("a rota continua sendo só de leitura para quem não pode ver o ticket", async () => {
    const t = await add();
    await say(t.id, "x");
    expect((await feed(t.id, "", "plain")).status).toBe(404);
    expect((await feed(t.id, "", "outsider", "org_B")).status).toBe(404);
  });

  it("autor inativo continua aparecendo pelo nome", async () => {
    const t = await add();
    await say(t.id, "de quem saiu");
    await h.pool.query("update people set active = false where id = $1", [personId("contributor")]);
    const p = await page(t.id);
    expect(p.entries.find((e) => e.type === "comment")).toMatchObject({ body: "de quem saiu", actor: { id: personId("contributor"), displayName: "Nome contributor" } });
  });

  it("excluir o ticket exclui os comentários", async () => {
    const t = await add();
    await say(t.id, "some junto");
    expect((await h.call("DELETE", `/api/tickets/${t.id}`, as("manager"))).status).toBe(204);
    expect(await count("select count(*) from ticket_comments")).toBe(0);
  });

  it("duas edições da descrição com um comentário entre elas não se juntam", async () => {
    const t = await add({});
    await patch(t.id, { description: "a" });
    const c = await say(t.id, "no meio");
    await patch(t.id, { description: "b" });
    await placeEvents(t.id, [0, 1, 3]);
    await placeComment(c.id, 2);
    expect(types(await page(t.id))).toEqual(["description_changed", "comment", "description_changed", "created"]);
  });

  it("edições da descrição sem comentário entre elas continuam juntas, mesmo havendo comentários antes e depois", async () => {
    const t = await add({});
    const early = await say(t.id, "antes");
    await patch(t.id, { description: "a" });
    await patch(t.id, { description: "b" });
    const late = await say(t.id, "depois");
    await placeEvents(t.id, [0, 3, 4]);
    await placeComment(early.id, 2);
    await placeComment(late.id, 6);
    expect(types(await page(t.id))).toEqual(["comment", "description_changed", "comment", "created"]);
  });

  it("a paginação dá o mesmo resultado para qualquer limit, com comentários no meio e instantes iguais", async () => {
    const t = await add({});
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      await patch(t.id, { description: `v${i}` });
      await patch(t.id, { description: `w${i}` });
      ids.push((await say(t.id, `c${i}`)).id);
    }
    await patch(t.id, { title: "fim" });
    const evs = await events(t.id);
    await placeEvents(t.id, evs.map((_, i) => 1 + i * 2));
    // Comentários: metade em instantes próprios, metade no mesmo instante de um evento (empate decidido pelo id).
    for (const [i, id] of ids.entries()) await placeComment(id, i % 2 === 0 ? 2 + i * 4 : 1 + (i + 1) * 4);
    const whole = await page(t.id, "?limit=100");
    expect(whole.before).toBeNull();
    expect(whole.entries.filter((e) => e.type === "comment")).toHaveLength(6);
    for (const limit of [1, 2, 3, 4, 5, 7]) {
      const seen: Entry[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const p: Page = await page(t.id, `?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
        expect(p.entries.length).toBeLessThanOrEqual(limit);
        seen.push(...p.entries);
        before = p.before;
        pages += 1;
      } while (before && pages < 60);
      expect(seen, `limit ${limit}`).toEqual(whole.entries);
    }
  });

  it("só comentários, sem nenhum evento de criação (ticket importado): created fecha a lista", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets/import`, as("manager"), { items: [{ title: "Importado" }] });
    const id = (res.body as { id: string }[])[0]?.id as string;
    await say(id, "um");
    await say(id, "dois");
    const first = await page(id, "?limit=2");
    expect(types(first)).toEqual(["comment", "comment"]);
    expect(first.before).not.toBeNull();
    const second = await page(id, `?limit=2&before=${encodeURIComponent(first.before as string)}`);
    expect(types(second)).toEqual(["created"]);
    expect(second.before).toBeNull();
  });
});

describe("custo da leitura", () => {
  const queriesOf = async (ticketId: string, limit: number): Promise<{ queries: number; entries: number }> => {
    const prisma = createPrismaClient(APP_URL);
    try {
      return await withTenant(prisma, { orgId: "org_A", userId: "u_admin" }, async (tx) => {
        const ticket = await tx.ticket.findFirstOrThrow({ where: { id: ticketId } });
        const project = await tx.project.findFirstOrThrow({ where: { id: ticket.projectId } });
        let queries = 0;
        const counting = new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop === "$queryRaw" || prop === "$executeRaw") return (...args: unknown[]) => { queries += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
            if (typeof prop === "string" && !prop.startsWith("$") && typeof value === "object" && value !== null) {
              return new Proxy(value, {
                get(model, method) {
                  const fn = Reflect.get(model, method) as unknown;
                  return typeof fn === "function" ? (...args: unknown[]) => { queries += 1; return (fn as (...a: unknown[]) => unknown).apply(model, args); } : fn;
                },
              });
            }
            return value;
          },
        }) as TenantClient;
        const viewer = { personId: personId("manager"), actor: buildActor("member", [], [{ projectId: project.id, role: "manager" }]) };
        const result = await new TicketActivityService().read(counting, project, ticket, { limit }, viewer);
        return { queries, entries: result.entries.length };
      });
    } finally {
      await prisma.$disconnect();
    }
  };

  it("a quantidade de consultas não cresce com as entradas nem com os comentários (4 no total)", async () => {
    const parent = await add({ title: "P" });
    const t = await add({});
    const round = async (i: number) => {
      await patch(t.id, { title: `x${i}`, parentId: i % 2 === 0 ? parent.id : null, status: i % 2 === 0 ? "in_progress" : "todo" });
      await say(t.id, `comentário ${i}`, i % 2 === 0 ? "contributor" : "manager");
    };
    await round(0);
    const few = await queriesOf(t.id, 30);
    for (let i = 1; i < 12; i++) await round(i);
    const many = await queriesOf(t.id, 30);
    expect(many.entries).toBeGreaterThan(few.entries);
    expect(many.entries).toBe(30);
    expect(many.queries).toBe(few.queries);
    expect(many.queries).toBeLessThanOrEqual(4);
  });
});

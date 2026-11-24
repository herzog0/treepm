import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ModulesContainer } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { errorCode, openTicket, post, reply, seedChatTickets, send, view } from "./chat-support.js";
import { ConversationAccess } from "../src/assistant/conversation-access.js";
import { ConversationService } from "../src/assistant/conversation.service.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0055, regra 3 (o centro da fatia): toda rota de conversa passa pela regra de visibilidade; quem não participa recebe 404 e nenhum
// dado; quem foi marcado numa thread não obtém, por rota nenhuma, nada da conversa de cima.
const S = { main: "SEGREDO-PRINCIPAL-9c1", d1: "SEGREDO-D1-ALICE-4e2", d1reply: "SEGREDO-D1-RESPOSTA-77f", d2: "SEGREDO-ABERTURA-D2-31a", d2reply: "SEGREDO-D2-BOB-5d8", other: "SEGREDO-OUTRA-THREAD-b02" };

/** O controlador injeta o serviço ou a porta de acesso das conversas? (por tipo ou por `@Inject`) */
function usesConversations(type: new () => object): boolean {
  const byType = (Reflect.getMetadata("design:paramtypes", type) as unknown[] | undefined) ?? [];
  const byToken = ((Reflect.getMetadata("self:paramtypes", type) as { param: unknown }[] | undefined) ?? []).map((p) => p.param);
  return [...byType, ...byToken].some((t) => t === ConversationService || t === ConversationAccess);
}

/**
 * Todas as rotas dos controladores que injetam o serviço ou a porta de acesso das conversas (método e caminho), tiradas da aplicação:
 * uma rota nova, com qualquer nome, que leia as mesmas tabelas por esse caminho entra na lista e faz o teste falhar até ganhar prova.
 */
export function conversationRoutes(app: INestApplication): string[] {
  const out: string[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const ctrl of mod.controllers.values()) {
      const type = ctrl.metatype as (new () => object) | null;
      if (!type || !usesConversations(type)) continue;
      const base = (Reflect.getMetadata(PATH_METADATA, type) as string) ?? "";
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const fn = (type.prototype as Record<string, unknown>)[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
        if (method === undefined) continue;
        const path = [base, Reflect.getMetadata(PATH_METADATA, fn) as string].filter(Boolean).join("/");
        out.push(`${RequestMethod[method]} /${path.replace(/\/+/g, "/").replace(/^\//, "")}`);
      }
    }
  }
  return out.sort();
}
/** Rotas que recebem o id de uma conversa: quem não participa recebe 404. */
const BY_ID = ["GET /conversations/:id", "POST /conversations/:id/messages", "POST /conversations/:id/participants", "POST /conversations/:id/read", "DELETE /conversations/:id/messages"];
/** Rotas "minhas": só devolvem o que é da própria pessoa. */
const MINE = ["GET /conversations", "POST /conversations/general", "GET /tickets/:ticketId/conversation", "POST /tickets/:ticketId/conversation"];

type Call = ReturnType<Harness["call"]>;
/** Uma sondagem por rota por id: a lista de rotas enumerada tem de ter exatamente estas chaves, ou o teste falha. */
const PROBES: Record<string, (h: Harness, id: string, who: Who | "target", reader: string) => Call> = {
  "GET /conversations/:id": (h, id, who) => h.call("GET", `/api/conversations/${id}`, as(who)),
  "POST /conversations/:id/messages": (h, id, who, reader) => h.call("POST", `/api/conversations/${id}/messages`, as(who), { body: "intruso", mentions: [reader] }),
  "POST /conversations/:id/participants": (h, id, who, reader) => h.call("POST", `/api/conversations/${id}/participants`, as(who), { personIds: [reader] }),
  "POST /conversations/:id/read": (h, id, who) => h.call("POST", `/api/conversations/${id}/read`, as(who), {}),
  "DELETE /conversations/:id/messages": (h, id, who) => h.call("DELETE", `/api/conversations/${id}/messages`, as(who)),
};
/** Uma sondagem por rota "minha": devolvem só o que é da própria pessoa. */
const MINE_PROBES: Record<string, (h: Harness, who: Who | "target", ticket: string) => Call> = {
  "GET /conversations": (h, who) => h.call("GET", "/api/conversations", as(who)),
  "POST /conversations/general": (h, who) => h.call("POST", "/api/conversations/general", as(who)),
  "GET /tickets/:ticketId/conversation": (h, who, ticket) => h.call("GET", `/api/tickets/${ticket}/conversation`, as(who)),
  "POST /tickets/:ticketId/conversation": (h, who, ticket) => h.call("POST", `/api/tickets/${ticket}/conversation`, as(who)),
};

async function scenario(h: Harness) {
  const world = h.world();
  const t = await seedChatTickets(h.pool, world);
  const main = await openTicket(h, "manager", t.ticket);
  expect((await post(h, "manager", main, S.main)).status).toBe(201);
  const d1 = (await post(h, "manager", main, S.d1, [world.people.reader])).body;
  expect(d1.kind).toBe("thread");
  expect((await reply(h, "reader", d1.thread.id, S.d1reply)).status).toBe(201);
  // Dentro da thread D1, a Alice (reader) marca o Bob (contributor): D2.
  const d2 = (await post(h, "reader", d1.thread.id, S.d2, [world.people.contributor])).body;
  expect(d2.kind).toBe("thread");
  expect((await reply(h, "contributor", d2.thread.id, S.d2reply)).status).toBe(201);
  // Outra thread do gestor, em que o Bob nem a Alice participam.
  const other = (await post(h, "manager", main, S.other, [world.people.target])).body;
  return { t, main, d1: d1.thread.id as string, d2: d2.thread.id as string, other: other.thread.id as string, world };
}

describe("rotas de conversa: enumeração", () => {
  const h = useHarness(AI_CONFIG);

  it("a lista de rotas registradas é exatamente a declarada (rota nova sem entrar na lista falha)", () => {
    expect(conversationRoutes(h.app())).toEqual([...BY_ID, ...MINE].sort());
    // Cada rota enumerada tem sondagem de 404 (por id) ou de "nenhum dado alheio" (minhas): sem sondagem, falha.
    expect(Object.keys(PROBES).sort()).toEqual([...BY_ID].sort());
    expect(Object.keys(MINE_PROBES).sort()).toEqual([...MINE].sort());
  });

  it.each(["admin", "teamAdmin", "plain", "contributor", "target"] as const)("pessoa de fora (%s) recebe 404 e nenhum dado em toda rota por id, nas conversas principal, D1 e a outra", async (who: Who | "target") => {
    const s = await scenario(h);
    // `contributor` participa de D2 (não da principal, nem de D1, nem da outra); `target`, só da outra.
    const forbidden: Record<string, string[]> = {
      admin: [s.main, s.d1, s.d2, s.other],
      teamAdmin: [s.main, s.d1, s.d2, s.other],
      plain: [s.main, s.d1, s.d2, s.other],
      contributor: [s.main, s.d1, s.other],
      target: [s.main, s.d1, s.d2],
    };
    for (const id of forbidden[who] ?? []) {
      const calls = Object.values(PROBES).map((probe) => probe(h, id, who, s.world.people.reader));
      for (const res of await Promise.all(calls)) {
        expect(res.status, `${who} ${id}`).toBe(404);
        expect(errorCode(res)).toBe("not_found");
        expect(JSON.stringify(res.body)).not.toMatch(/SEGREDO|intruso/);
        for (const known of [s.main, s.d1, s.d2, s.other]) expect(JSON.stringify(res.body)).not.toContain(known);
      }
    }
    // Nada foi gravado pelos intrusos.
    expect((await h.pool.query("select count(*)::int as n from conversation_messages where body = 'intruso'")).rows[0].n).toBe(0);
  });

  it("rotas 'minhas': para cada rota enumerada, quem é de fora não recebe id, texto nem metadado de conversa alheia", async () => {
    const s = await scenario(h);
    for (const who of ["admin", "plain", "target"] as const) {
      for (const [route, probe] of Object.entries(MINE_PROBES)) {
        const res = await probe(h, who, s.t.ticket);
        expect([200, 201, 404], `${who} ${route}`).toContain(res.status);
        const text = JSON.stringify(res.body);
        for (const known of [S.main, S.d1, S.d1reply, S.d2, S.d2reply, s.main, s.d1, s.d2]) expect(text, `${who} ${route}`).not.toContain(known);
      }
    }
  });

  it("metadados: contagens, não lidas, prévia, participantes, datas e respostas de cada pessoa batem com o que a regra permite", async () => {
    const s = await scenario(h);
    const count = async (sql: string, ...params: unknown[]) => (await h.pool.query(sql, params)).rows[0].n as number;
    // O Bob (contributor) só participa de D2: a árvore dele traz o ticket SEM conversa (sem id, contagem, prévia ou data) e D2 com o que ele lê.
    const tree = await h.call("GET", "/api/conversations", as("contributor"));
    const ticketNode = tree.body.items.find((n: { kind: string }) => n.kind === "ticket");
    // Sem conversa própria no ticket: só ele mesmo, nenhuma prévia, e a data é a da atividade que ELE lê (a da D2), nunca a do que está acima.
    expect(ticketNode).toMatchObject({ id: null, participantCount: 1, unread: 0, preview: null, participants: [{ id: s.world.people.contributor }] });
    const d2Node = ticketNode.children[0];
    expect(ticketNode.lastActivityAt).toBe(d2Node.lastActivityAt);
    // Atividade nova em cima (principal e D1), que ele não lê, não mexe em nada do que a árvore dele devolve.
    await post(h, "manager", s.main, "movimento acima 1");
    await post(h, "reader", s.d1, "movimento acima 2");
    const again = await h.call("GET", "/api/conversations", as("contributor"));
    expect(again.body).toEqual(tree.body);
    expect(d2Node.id).toBe(s.d2);
    expect(d2Node.participantCount).toBe(await count("select count(*)::int as n from conversation_participants where conversation_id = $1", s.d2));
    expect(d2Node.preview).toBe(S.d2reply.slice(0, 80));
    expect(d2Node.unread).toBe(1); // a abertura (escrita pela Alice); a resposta é dele
    const lastD2 = (await h.pool.query<{ created_at: Date }>("select max(created_at) as created_at from conversation_messages where conversation_id = $1 or id = (select opening_message_id from conversations where id = $1)", [s.d2])).rows[0]!.created_at;
    expect(new Date(d2Node.lastActivityAt).getTime()).toBeLessThanOrEqual(lastD2.getTime() + 1000);
    // O cartão da D2 na leitura do ticket: as contagens são só as da D2.
    const byTicket = await h.call("GET", `/api/tickets/${s.t.ticket}/conversation`, as("contributor"));
    expect(byTicket.body.conversation).toBeNull();
    expect(byTicket.body.messages.items).toEqual([]);
    expect(byTicket.body.unread).toBe(0);
    expect(byTicket.body.threads).toHaveLength(1);
    expect(byTicket.body.threads[0]).toMatchObject({ id: s.d2, participantCount: 3, replyCount: 1, startedByMe: false });
    // A principal do dono: contagens da principal e nada de D2 (ele a lê por D1, mas a contagem de D1 é a dele).
    const owner = await h.call("GET", "/api/conversations", as("manager"));
    const mainNode = owner.body.items.find((n: { kind: string }) => n.kind === "ticket");
    expect(mainNode.participantCount).toBe(1);
    expect(mainNode.children.map((c: { id: string }) => c.id).sort()).toEqual([s.d1, s.other].sort());
  });

  it("chat geral com thread de ticket e perda de acesso: quem perde o projeto recebe 404 em toda rota por id e nada vaza pelo chat geral", async () => {
    const world = h.world();
    const t = await seedChatTickets(h.pool, world);
    const general = (await h.call("POST", "/api/conversations/general", as("manager"))).body.id as string;
    const t1 = (await post(h, "manager", general, "SEGREDO-GERAL-T1", [world.people.reader])).body.thread.id as string;
    const t2 = (await post(h, "manager", t1, "SEGREDO-GERAL-T2", [world.people.contributor], t.ticket)).body.thread.id as string;
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [world.people.reader, world.projects.priv]);
    for (const probe of Object.values(PROBES)) {
      const res = await probe(h, t2, "reader", world.people.manager);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/SEGREDO/);
    }
    const seenByReader = JSON.stringify([(await view(h, "reader", t1)).body, (await h.call("GET", "/api/conversations", as("reader"))).body]);
    expect(seenByReader).not.toContain(t2);
    // O texto da mensagem que abriu T2 mora em T1 e continua legível ali (aceito na ADR); o id, o cartão e as contagens da T2 não saem.
    expect((await h.call("GET", `/api/conversations/${t2}`, as("outsider", "org_B"))).status).toBe(404);
    expect((await h.call("POST", `/api/conversations/${t1}/participants`, as("outsider", "org_B"), { personIds: [world.people.reader] })).status).toBe(404);
  });

  it("outra organização recebe 404 em toda rota por id, e nada na árvore", async () => {
    const s = await scenario(h);
    const outsider = as("outsider", "org_B");
    for (const id of [s.main, s.d1, s.d2]) {
      for (const [method, path, body] of [["GET", `/api/conversations/${id}`], ["POST", `/api/conversations/${id}/messages`, { body: "x" }], ["POST", `/api/conversations/${id}/participants`, { personIds: [s.world.people.reader] }], ["POST", `/api/conversations/${id}/read`, {}], ["DELETE", `/api/conversations/${id}/messages`]] as const) {
        expect((await h.call(method, path, outsider, body)).status, `${method} ${path}`).toBe(404);
      }
    }
    const tree = await h.call("GET", "/api/conversations", outsider);
    expect(JSON.stringify(tree.body)).not.toContain(s.main);
    expect((await h.call("GET", `/api/tickets/${s.t.ticket}/conversation`, outsider)).status).toBe(404);
    expect((await h.call("POST", `/api/tickets/${s.t.ticket}/conversation`, outsider)).status).toBe(404);
  });

  it("rotas 'minhas' como pessoa de fora: 200 só com o que é dela, nunca texto, id ou contagem de conversa alheia", async () => {
    const s = await scenario(h);
    for (const who of ["admin", "plain"] as const) {
      const tree = await h.call("GET", "/api/conversations", as(who));
      expect(tree.status).toBe(200);
      for (const known of [S.main, S.d1, S.d2, s.main, s.d1, s.d2, s.other]) expect(JSON.stringify(tree.body)).not.toContain(known);
      const general = await h.call("POST", "/api/conversations/general", as(who));
      expect(general.status).toBe(200);
      const ticket = await h.call("GET", `/api/tickets/${s.t.ticket}/conversation`, as(who));
      if (who === "plain") expect(ticket.status).toBe(404);
      else {
        expect(ticket.status).toBe(200);
        expect(ticket.body.conversation).toBeNull();
        expect(ticket.body.threads).toEqual([]);
        expect(JSON.stringify(ticket.body)).not.toMatch(/SEGREDO/);
      }
    }
  });

  it("o convidado (Bob) lê só a thread dele: nenhuma rota entrega id, título, contagem, prévia ou existência do que está acima", async () => {
    const s = await scenario(h);
    const bob = "contributor" as const;
    const own = await h.call("GET", `/api/conversations/${s.d2}`, as(bob));
    expect(own.status).toBe(200);
    const texts = JSON.stringify(own.body);
    // Lê a abertura (a primeira da thread, escrita em D1) e a resposta dele; nada mais de D1 nem da principal.
    expect(texts).toContain(S.d2);
    expect(texts).toContain(S.d2reply);
    for (const secret of [S.main, S.d1, S.d1reply, S.other]) expect(texts).not.toContain(secret);
    for (const hidden of [s.main, s.d1, s.other]) expect(texts).not.toContain(hidden);
    expect(own.body.conversation.trail).toEqual([]);
    expect(own.body.messages.items.map((m: { body: string }) => m.body)).toEqual([S.d2reply, S.d2]);
    // A árvore dele: a thread, sob o ticket de que trata, sem nada do pai real.
    const tree = await h.call("GET", "/api/conversations", as(bob));
    const treeText = JSON.stringify(tree.body);
    for (const secret of [S.main, S.d1, S.d1reply, S.other]) expect(treeText).not.toContain(secret);
    for (const hidden of [s.main, s.d1, s.other]) expect(treeText).not.toContain(hidden);
    const node = (tree.body.items as { ticket: { key: string } | null; id: string | null; children: { id: string }[] }[]).find((n) => n.ticket?.key === "PRIV-3");
    expect(node?.id).toBeNull();
    expect(node?.children.map((c) => c.id)).toEqual([s.d2]);
    // O ticket dele: nenhuma conversa principal, a thread dele como ponta de baixo.
    const ticket = await h.call("GET", `/api/tickets/${s.t.ticket}/conversation`, as(bob));
    expect(ticket.body.conversation).toBeNull();
    expect(ticket.body.threads.map((c: { id: string }) => c.id)).toEqual([s.d2]);
    expect(JSON.stringify(ticket.body)).not.toMatch(/SEGREDO-(PRINCIPAL|D1|OUTRA)/);
    // Pelo caminho de escrita: marcar alguém dentro da thread dele funciona e continua sem revelar o de cima.
    const deeper = await post(h, bob, s.d2, "mais um nível", [s.world.people.target]);
    expect(deeper.status).toBe(201);
    expect(JSON.stringify(deeper.body)).not.toMatch(/SEGREDO-(PRINCIPAL|D1|OUTRA)/);
  });

  it("a trilha da Alice começa na D1 (ela entrou ali): a principal do gestor não aparece para ela", async () => {
    const s = await scenario(h);
    const alice = await h.call("GET", `/api/conversations/${s.d2}`, as("reader"));
    expect(alice.body.conversation.trail.map((t: { id: string }) => t.id)).toEqual([s.d1]);
    const tree = await h.call("GET", "/api/conversations", as("reader"));
    expect(JSON.stringify(tree.body)).not.toMatch(/SEGREDO-PRINCIPAL|SEGREDO-OUTRA/);
    expect(JSON.stringify(tree.body)).not.toContain(s.main);
    // O gestor vê a trilha inteira.
    const manager = await h.call("GET", `/api/conversations/${s.d2}`, as("manager"));
    expect(manager.body.conversation.trail.map((t: { id: string }) => t.id)).toEqual([s.main, s.d1]);
  });

  it("o assistente nunca lê thread: a única chamada ao provedor foi a da mensagem da principal, sem nada das threads", async () => {
    await scenario(h);
    expect(h.chat().calls).toHaveLength(1);
    expect(JSON.stringify(h.chat().calls)).not.toMatch(/SEGREDO-(D1|ABERTURA|OUTRA|D2)/);
  });
});

async function gateOrder(h: Harness, expected: number) {
  const t = await seedChatTickets(h.pool, h.world());
  const main = await openTicket(h, "manager", t.ticket);
  expect((await post(h, "contributor", main, "oi")).status).toBe(404);
  expect((await post(h, "manager", main, "oi")).status).toBe(expected);
}
describe("sem aceite: quem não participa recebe 404, e o dono recebe 403", () => {
  const h = useHarness(AI_CONFIG, { consent: false });
  it("ordem das checagens", () => gateOrder(h, 403));
});
describe("sem provedor: quem não participa recebe 404, e o dono recebe 503", () => {
  const h = useHarness(TEST_CONFIG);
  it("ordem das checagens", () => gateOrder(h, 503));
});

void send;

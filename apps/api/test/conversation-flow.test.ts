import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHAT_ASSISTANT_PER_PERSON_PER_MINUTE, CHAT_MAX_MENTIONS, CHAT_THREAD_PER_PERSON_PER_MINUTE, CONVERSATION_MAX_DEPTH, CONVERSATION_MAX_PARTICIPANTS } from "@treepm/domain";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { errorCode, openGeneral, openTicket, post, seedChatTickets, send, ticketView, view } from "./chat-support.js";
import { as } from "./world.js";

const CLERK_KEY = "sk_test_fake";
const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();

describe("conversas em níveis: fluxos (ADR 0055)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;
  const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
  /** A invariante da ADR conferida no banco depois de cada operação. */
  const invariant = async () => expect(await rows("select c.id from conversations c join conversation_participants up on up.conversation_id = c.parent_id where not exists (select 1 from conversation_participants me where me.conversation_id = c.id and me.person_id = up.person_id)")).toEqual([]);

  it("principal → thread com Alice → dentro dela, thread com Bob: Bob lê só a dele; os participantes são o dono, Alice e Bob", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = await post(h, "manager", main, "Alice, olha", [p().reader]);
    expect(d1.status).toBe(201);
    expect(d1.body.kind).toBe("thread");
    expect(h.chat().calls).toHaveLength(0);
    expect(ids(d1.body.thread.participants)).toEqual([p().manager, p().reader].sort());
    expect(d1.body.thread.startedByMe).toBe(true);
    expect(d1.body.message.thread.id).toBe(d1.body.thread.id);
    const d2 = await post(h, "reader", d1.body.thread.id, "Bob, e você?", [p().contributor]);
    expect(ids(d2.body.thread.participants)).toEqual([p().manager, p().reader, p().contributor].sort());
    expect((await view(h, "contributor", d2.body.thread.id)).status).toBe(200);
    expect((await view(h, "contributor", d1.body.thread.id)).status).toBe(404);
    expect((await view(h, "contributor", main)).status).toBe(404);
    await invariant();
  });

  it("irmãs no mesmo nível; várias pessoas numa mensagem são uma thread só", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const a = await post(h, "manager", main, "para dois", [p().reader, p().contributor]);
    const b = await post(h, "manager", main, "para um", [p().target]);
    expect(ids(a.body.thread.participants)).toEqual([p().manager, p().reader, p().contributor].sort());
    const seen = await view(h, "manager", main);
    expect(ids(seen.body.threads)).toEqual([a.body.thread.id, b.body.thread.id].sort());
    expect(seen.body.messages.items.filter((m: { thread: unknown }) => m.thread !== null)).toHaveLength(2);
    expect((await rows("select count(*)::int as n from conversations where kind = 'thread'"))[0].n).toBe(2);
  });

  it("a mensagem de abertura mora na conversa de cima e é a primeira da thread, para quem participa dela", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = await post(h, "manager", main, "abre aqui", [p().reader]);
    await post(h, "reader", d1.body.thread.id, "resposta");
    const alice = await view(h, "reader", d1.body.thread.id);
    expect(alice.body.messages.items.map((m: { body: string }) => m.body)).toEqual(["resposta", "abre aqui"]);
    expect((await view(h, "manager", main)).body.messages.items.map((m: { body: string }) => m.body)).toEqual(["abre aqui"]);
    // Cursor: a página de uma mensagem só ainda chega à abertura.
    const first = await view(h, "reader", d1.body.thread.id, "?limit=1");
    expect(first.body.messages.items).toHaveLength(1);
    const second = await view(h, "reader", d1.body.thread.id, `?limit=1&before=${first.body.messages.nextBefore}`);
    expect(second.body.messages.items[0].body).toBe("abre aqui");
    expect(second.body.messages.nextBefore).toBeNull();
  });

  it("chat geral: um por pessoa; thread com e sem ticket; ticket que a pessoa não vê é recusado", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "manager");
    expect(await openGeneral(h, "manager")).toBe(general);
    expect(await openGeneral(h, "reader")).not.toBe(general);
    const loose = await post(h, "manager", general, "sem ticket", [p().plain]);
    expect(loose.status).toBe(201);
    expect(loose.body.thread.participants.map((x: { id: string }) => x.id).sort()).toEqual([p().manager, p().plain].sort());
    const withTicket = await post(h, "manager", general, "sobre o ticket", [p().reader], t.ticket);
    expect(withTicket.status).toBe(201);
    const tree = await h.call("GET", "/api/conversations", as("reader"));
    const node = tree.body.items.find((n: { ticket: { key: string } | null }) => n.ticket?.key === "PRIV-3");
    expect(node.id).toBeNull();
    expect(node.children.map((c: { id: string }) => c.id)).toEqual([withTicket.body.thread.id]);
    expect(node.ticket).toMatchObject({ status: "in_progress", blocked: false });
    // Quem não vê o projeto do ticket não entra numa thread sobre ele; e a thread do chat geral nunca troca de ticket depois.
    expect(errorCode(await post(h, "manager", general, "x", [p().plain], t.ticket))).toBe("mention_not_allowed");
    expect(errorCode(await post(h, "plain", await openGeneral(h, "plain"), "x", [], t.ticket))).toBeUndefined();
    const onTicket = await openTicket(h, "manager", t.ticket);
    expect(errorCode(await post(h, "manager", onTicket, "x", [p().reader], randomUUID()))).toBe("ticket_mismatch");
  });

  it("adicionar uma pessoa a uma thread a inscreve em todas as de dentro, na mesma transação, e ela lê o histórico", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "primeira", [p().reader])).body.thread.id as string;
    await post(h, "manager", d1, "histórico antigo");
    const d2 = (await post(h, "reader", d1, "nível dois", [p().target])).body.thread.id as string;
    expect((await view(h, "contributor", d1)).status).toBe(404);
    const added = await h.call("POST", `/api/conversations/${d1}/participants`, as("manager"), { personIds: [p().contributor] });
    expect(added.status).toBe(201);
    expect(added.body.participants.map((x: { id: string }) => x.id)).toContain(p().contributor);
    const bob = await view(h, "contributor", d1);
    expect(bob.body.messages.items.map((m: { body: string }) => m.body)).toContain("histórico antigo");
    expect(bob.body.messages.items.length).toBe(3);
    expect((await view(h, "contributor", d2)).status).toBe(200);
    expect((await view(h, "contributor", main)).status).toBe(404);
    await invariant();
  });

  it("incluir pessoa: só quem abriu a thread (403 para outro participante); principal não aceita (422); quem não enxerga o ticket é recusado", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "oi", [p().reader])).body.thread.id as string;
    const add = (who: "manager" | "reader", id: string, people: string[]) => h.call("POST", `/api/conversations/${id}/participants`, as(who), { personIds: people });
    const byAlice = await add("reader", d1, [p().contributor]);
    expect(byAlice.status).toBe(403);
    expect(errorCode(byAlice)).toBe("not_thread_owner");
    expect(errorCode(await add("manager", main, [p().reader]))).toBe("principal_conversation");
    const refused = await add("manager", d1, [p().plain]);
    expect(errorCode(refused)).toBe("mention_not_allowed");
    expect(refused.body.error.details.personIds).toEqual([p().plain]);
    expect((await rows("select count(*)::int as n from conversation_participants where conversation_id = $1", [d1]))[0].n).toBe(2);
  });

  it("dez níveis: marcar alguém numa conversa de nível 10 é recusado com código próprio", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    let current = await openTicket(h, "manager", t.ticket);
    for (let level = 1; level <= CONVERSATION_MAX_DEPTH; level += 1) {
      const res = await post(h, "manager", current, `nível ${level}`, [p().reader]);
      expect(res.status, `nível ${level}`).toBe(201);
      current = res.body.thread.id;
    }
    const last = await view(h, "manager", current);
    expect(last.body.conversation.canOpenThread).toBe(false);
    expect(last.body.conversation.trail).toHaveLength(CONVERSATION_MAX_DEPTH);
    const refused = await post(h, "manager", current, "demais", [p().reader]);
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe("max_depth");
    // Sem menção, a mensagem normal no último nível funciona.
    expect((await post(h, "manager", current, "ainda dá para falar")).status).toBe(201);
    await invariant();
  });

  it.each([
    ["quem não enxerga o ticket", () => p().plain],
    ["id que não existe", () => randomUUID()],
    ["pessoa de outra organização", () => h.world().other.person],
  ])("mencionar %s é recusado (422 mention_not_allowed) dizendo só o id enviado, sem criar nada", async (_n, who) => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const id = who();
    const res = await post(h, "manager", main, "oi", [p().reader, id]);
    expect(errorCode(res)).toBe("mention_not_allowed");
    expect(res.body.error.details.personIds).toEqual([id]);
    expect((await rows("select count(*)::int as n from conversations where kind = 'thread'"))[0].n).toBe(0);
    expect((await rows("select count(*)::int as n from conversation_messages"))[0].n).toBe(0);
  });

  it("menção a si mesma, acima do teto de menções e a pessoa inativa são recusadas; repetir a mesma conta uma", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    expect(errorCode(await post(h, "manager", main, "oi", [p().manager]))).toBe("cannot_mention_self");
    expect(errorCode(await post(h, "manager", main, "oi", Array.from({ length: CHAT_MAX_MENTIONS + 1 }, () => randomUUID())))).toBe("too_many_mentions");
    expect((await post(h, "manager", main, "oi", [p().reader, p().reader])).body.thread.participants).toHaveLength(2);
    await h.pool.query("update people set active = false where id = $1", [p().contributor]);
    expect(errorCode(await post(h, "manager", main, "oi", [p().contributor]))).toBe("mention_not_allowed");
  });

  it("25 participantes por conversa: abrir e incluir recusam no teto, e uma descendente cheia derruba a operação inteira", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "raiz", [p().reader])).body.thread.id as string;
    const d2 = (await post(h, "manager", d1, "fundo", [p().target])).body.thread.id as string;
    // Enche D2 até o teto com pessoas semeadas direto no banco (D2 tem manager, reader e target).
    for (let i = 0; i < CONVERSATION_MAX_PARTICIPANTS - 3; i += 1) {
      const person = (await h.pool.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_A',$1,'x',$2,'member') returning id", [`fill${i}`, `fill${i}@x.io`])).rows[0]!.id;
      await h.pool.query("insert into conversation_participants (org_id, conversation_id, person_id) values ('org_A',$1,$2)", [d2, person]);
    }
    const full = await h.call("POST", `/api/conversations/${d1}/participants`, as("manager"), { personIds: [p().contributor] });
    expect(errorCode(full)).toBe("thread_full");
    expect((await rows("select count(*)::int as n from conversation_participants where person_id = $1", [p().contributor]))[0].n).toBe(0);
    expect(errorCode(await post(h, "manager", d2, "mais", [p().contributor]))).toBe("thread_full");
  });

  it("não lidas por pessoa e por conversa; ler zera só a conversa; cursor opaco, adulterado é 400; nunca passa do mais novo", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "abertura", [p().reader])).body.thread.id as string;
    await post(h, "manager", d1, "um");
    await post(h, "manager", d1, "dois");
    const tree = async (who: "reader" | "manager") => (await h.call("GET", "/api/conversations", as(who))).body.items.find((n: { ticket: { key: string } | null }) => n.ticket?.key === "PRIV-3");
    expect((await tree("reader")).children[0].unread).toBe(3);
    expect((await tree("manager")).unread).toBe(0);
    const cursor = (await view(h, "reader", d1)).body.messages.items[0].cursor as string;
    expect(cursor).not.toMatch(/^\d+$/);
    expect((await view(h, "reader", d1, "?before=lixo")).status).toBe(400);
    const part = await h.call("POST", `/api/conversations/${d1}/read`, as("reader"), { upTo: (await view(h, "reader", d1, "?limit=2")).body.messages.items[1].cursor });
    expect(part.body.unread).toBe(1);
    expect((await h.call("POST", `/api/conversations/${d1}/read`, as("reader"), {})).body.unread).toBe(0);
    expect((await h.call("POST", `/api/conversations/${d1}/read`, as("reader"), { upTo: "AAAAAAAAAAAAAAAAAAAAAA" })).status).toBe(400);
    expect(encodeUnused()).toBe(CLERK_KEY);
    await post(h, "manager", d1, "tres");
    expect((await h.call("GET", "/api/conversations", as("reader"))).body.items.find((n: { ticket: unknown }) => n.ticket !== null).children[0].unread).toBe(1);
  });

  it("o assistente responde só na conversa principal e a resposta conta como não lida; a thread não chama provedor", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const answered = await post(h, "manager", main, "oi");
    expect(answered.body.kind).toBe("assistant");
    expect(h.chat().calls).toHaveLength(1);
    const d1 = (await post(h, "manager", main, "thread", [p().reader])).body.thread.id as string;
    expect((await post(h, "reader", d1, "sem assistente")).body.kind).toBe("message");
    expect(h.chat().calls).toHaveLength(1);
  });

  it("limites por minuto: assistente (429 chat_rate_limited) e threads (429 chat_thread_rate_limited), separados", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "contributor", t.ticket);
    for (let i = 0; i < CHAT_ASSISTANT_PER_PERSON_PER_MINUTE; i += 1) expect((await post(h, "contributor", main, `m${i}`)).status).toBe(201);
    const blocked = await post(h, "contributor", main, "demais");
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked)).toBe("chat_rate_limited");
    const d1 = (await post(h, "contributor", main, "thread", [p().reader])).body.thread.id as string;
    for (let i = 1; i < CHAT_THREAD_PER_PERSON_PER_MINUTE; i += 1) expect((await post(h, "contributor", d1, `r${i}`)).status).toBe(201);
    expect(errorCode(await post(h, "contributor", d1, "demais"))).toBe("chat_thread_rate_limited");
    expect((await post(h, "reader", d1, "outra pessoa")).status).toBe(201);
  });

  it("projeto arquivado: lê e marca como lido; não escreve (409 project_archived)", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "oi", [p().reader])).body.thread.id as string;
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
    expect((await view(h, "manager", main)).body.ticket.archived).toBe(true);
    expect((await h.call("POST", `/api/conversations/${d1}/read`, as("reader"), {})).status).toBe(200);
    for (const res of [await post(h, "manager", main, "x"), await post(h, "reader", d1, "x"), await post(h, "manager", d1, "x", [p().target])]) {
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("project_archived");
    }
  });

  it("quem perde o acesso ao projeto deixa de ler e de escrever, na thread e na árvore; as mensagens dela ficam para os outros", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "oi", [p().reader])).body.thread.id as string;
    await post(h, "reader", d1, "da leitora");
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [p().reader, h.world().projects.priv]);
    expect((await view(h, "reader", d1)).status).toBe(404);
    expect((await post(h, "reader", d1, "x")).status).toBe(404);
    expect(JSON.stringify((await h.call("GET", "/api/conversations", as("reader"))).body)).not.toContain(d1);
    expect(JSON.stringify((await view(h, "manager", d1)).body)).toContain("da leitora");
  });

  it("limpar: apaga só a conversa com o assistente; as mensagens que abriram threads ficam; thread não se limpa; quem perdeu o acesso ainda limpa a própria", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "reader", t.ticket);
    await post(h, "reader", main, "pergunta");
    const d1 = (await post(h, "reader", main, "abre", [p().manager])).body.thread.id as string;
    expect((await h.call("DELETE", `/api/conversations/${d1}/messages`, as("reader"))).status).toBe(422);
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [p().reader, h.world().projects.priv]);
    expect((await h.call("DELETE", `/api/conversations/${main}/messages`, as("reader"))).status).toBe(204);
    expect((await rows("select body from conversation_messages where conversation_id = $1", [main])).map((r) => r.body)).toEqual(["abre"]);
    expect((await h.call("DELETE", `/api/conversations/${main}/messages`, as("reader"))).status).toBe(204);
  });

  it("a árvore: o dono vê a principal com as threads aninhadas; ticket com responsável e sem conversa aparece sem id; prévia e avatares", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "primeira", [p().reader, p().contributor])).body.thread.id as string;
    const d2 = (await post(h, "reader", d1, "segunda", [p().target])).body.thread.id as string;
    await post(h, "target", d2, "última palavra");
    const tree = (await h.call("GET", "/api/conversations", as("manager"))).body;
    expect(tree.items[0]).toMatchObject({ kind: "general", id: null });
    const node = tree.items.find((n: { id: string | null }) => n.id === main);
    expect(node.ticket.key).toBe("PRIV-3");
    expect(node.children.map((c: { id: string }) => c.id)).toEqual([d1]);
    expect(node.children[0].children.map((c: { id: string }) => c.id)).toEqual([d2]);
    expect(node.children[0].children[0]).toMatchObject({ kind: "thread", preview: "última palavra", participantCount: 4 });
    expect(node.children[0].participants.length).toBeLessThanOrEqual(5);
    // O gestor é responsável pelo ticket PRIV-3 semeado; quem não tem conversa mas é responsável vê o ticket sem id.
    await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ('org_A',$1,$2)", [t.child1, p().reader]);
    const alice = (await h.call("GET", "/api/conversations", as("reader"))).body.items.find((n: { ticket: { key: string } | null }) => n.ticket?.key === "PRIV-4");
    expect(alice).toMatchObject({ id: null, kind: "ticket", unread: 0 });
    expect((await ticketView(h, "reader", t.child1)).body.assignedToMe).toBe(true);
  });

  it("a vez do assistente é reservada ANTES de chamar o provedor: requisições paralelas gastam uma chamada só", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "contributor", t.ticket);
    h.chat().onCall = () => new Promise((resolve) => setTimeout(resolve, 300));
    const [a, b] = await Promise.all([post(h, "contributor", main, "um"), post(h, "contributor", main, "dois")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(h.chat().calls).toHaveLength(1);
    expect(errorCode(a.status === 409 ? a : b)).toBe("chat_busy");
  });

  it("nenhuma operação de conversa grava atividade nem mexe na versão do projeto ou no ticket", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const snapshot = async () => (await rows("select (select count(*) from activity_events)::int as events, (select tickets_version from projects where id = $1)::int as version, (select updated_at from tickets where id = $2) as touched", [h.world().projects.priv, t.ticket]))[0];
    const before = await snapshot();
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "oi", [p().reader])).body.thread.id as string;
    await post(h, "manager", main, "ao assistente");
    await h.call("POST", `/api/conversations/${d1}/participants`, as("manager"), { personIds: [p().contributor] });
    expect(await snapshot()).toEqual(before);
  });

  it.each([["byte NUL", "oi\u0000tchau"], ["controle", "oi\u0001"], ["substituto solto", "oi\ud800"]])("corpo com %s: 400 antes de qualquer provedor", async (_n, body) => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    expect((await post(h, "manager", main, body)).status).toBe(400);
    expect((await post(h, "manager", main, "a".repeat(4001))).status).toBe(400);
    expect((await h.call("POST", `/api/conversations/${main}/messages`, as("manager"), { body: "x", extra: 1 })).status).toBe(400);
    expect(h.chat().calls).toHaveLength(0);
  });
});

function encodeUnused(): string {
  return CLERK_KEY;
}
void send;

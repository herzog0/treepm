import { describe, expect, it, vi } from "vitest";
import { CONVERSATION_MAX_DEPTH } from "@treepm/domain";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { errorCode, openGeneral, openTicket, post, seedChatTickets, send, view } from "./chat-support.js";
import { ConversationService } from "../src/assistant/conversation.service.js";
import { as } from "./world.js";

/** Revisão 1 (ADR 0055, fatia 2): os achados da revisão de privacidade, cada um com o teste que falhava antes da correção. */
describe("revisão 1: thread com ticket dentro de conversa sem ticket (item 1)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;
  const priv = () => h.world().projects.priv;

  it("recusa abrir a thread com ticket se alguém da conversa de cima não enxerga o projeto, sem dizer quem", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "manager");
    const t1 = (await post(h, "manager", general, "sem ticket", [p().plain])).body.thread.id as string;
    // a conversa de cima tem quem não enxerga o projeto: recusa, mesmo marcando só quem enxerga
    const refused = await post(h, "manager", t1, "agora com ticket", [p().reader], t.ticket);
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe("participant_cannot_view_ticket");
    expect(refused.body.error.message).toBe("Alguém desta conversa não enxerga o projeto deste ticket.");
    expect(refused.body.error.details).toBeUndefined();
    expect(JSON.stringify(refused.body)).not.toContain(p().plain);
    expect((await h.pool.query("select count(*)::int as n from conversations where parent_id = $1", [t1])).rows[0].n).toBe(0);
  });

  it("quem perde o acesso depois não vê o cartão da thread com ticket, nem na leitura da conversa de cima, nem nos cartões das mensagens", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "manager");
    const t1 = (await post(h, "manager", general, "sem ticket", [p().reader])).body.thread.id as string;
    const t2 = (await post(h, "manager", t1, "com ticket", [p().contributor], t.ticket)).body.thread.id as string;
    expect(JSON.stringify((await view(h, "reader", t1)).body)).toContain(t2);
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [p().reader, priv()]);
    const after = await view(h, "reader", t1);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).not.toContain(t2);
    expect(after.body.messages.items.every((m: { thread: unknown }) => m.thread === null)).toBe(true);
    expect((await view(h, "reader", t2)).status).toBe(404);
  });

  it("incluir pessoa numa conversa confere o acesso dela aos projetos de todas as descendentes", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "manager");
    const t1 = (await post(h, "manager", general, "sem ticket", [p().reader])).body.thread.id as string;
    await post(h, "manager", t1, "com ticket", [p().contributor], t.ticket);
    const refused = await h.call("POST", `/api/conversations/${t1}/participants`, as("manager"), { personIds: [p().plain] });
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe("mention_not_allowed");
    expect((await h.pool.query("select count(*)::int as n from conversation_participants where conversation_id = $1 and person_id = $2", [t1, p().plain])).rows[0].n).toBe(0);
  });
});

describe("revisão 1: o limite de níveis conta pela trilha visível (item 2)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;

  it("Bob, marcado no nível 3, abre dez níveis abaixo da dele; o dono, que vê tudo, é recusado antes", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    let current = await openTicket(h, "manager", t.ticket);
    const chain: string[] = [];
    for (let level = 1; level <= CONVERSATION_MAX_DEPTH; level += 1) {
      const res = await post(h, "manager", current, `nível ${level}`, [level === 3 ? p().contributor : p().reader]);
      expect(res.status, `dono, nível ${level}`).toBe(201);
      current = res.body.thread.id;
      chain.push(current);
    }
    expect(errorCode(await post(h, "manager", current, "demais", [p().reader]))).toBe("max_depth");
    // Bob entra no nível 3: não vê nada acima e conta os dez níveis a partir da dele.
    let bob = chain[2] as string;
    expect((await view(h, "contributor", bob)).body.conversation.trail).toEqual([]);
    for (let level = 1; level <= CONVERSATION_MAX_DEPTH; level += 1) {
      const res = await post(h, "contributor", bob, `do Bob ${level}`, [p().manager]);
      expect(res.status, `Bob, nível ${level}`).toBe(201);
      bob = res.body.thread.id;
    }
    const last = await view(h, "contributor", bob);
    expect(last.body.conversation.canOpenThread).toBe(false);
    const refused = await post(h, "contributor", bob, "demais", [p().manager]);
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe("max_depth");
  });
});

describe("revisão 1: limpar e o caminho do assistente (itens 5 e 6)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;

  it("DELETE numa thread responde 404 a quem perdeu o acesso ao projeto, e 204 na própria principal", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "reader", t.ticket);
    const d1 = (await post(h, "reader", main, "abre", [p().manager])).body.thread.id as string;
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [p().reader, h.world().projects.priv]);
    expect((await h.call("DELETE", `/api/conversations/${d1}/messages`, as("reader"))).status).toBe(404);
    expect((await h.call("DELETE", `/api/conversations/${main}/messages`, as("reader"))).status).toBe(204);
  });

  it("o serviço recusa thread que não é de assunto antes de ler qualquer histórico (prepareAssistantTurn e recordAssistantTurn)", async () => {
    const service = h.app().get(ConversationService);
    const access = (service as unknown as { access: { resolve: unknown } }).access;
    const principal = { person: { id: "p" }, organization: { orgId: "o" } };
    const tx = new Proxy({}, { get: () => { throw new Error("leu o banco"); } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (fn: "prepareAssistantTurn" | "recordAssistantTurn") => (service as any)[fn](tx, principal, "x", "oi", { message: "r", model: "m" }, 0);
    for (const purpose of ["people", "creation", null]) {
      const resolve = vi.spyOn(access as { resolve: () => Promise<unknown> }, "resolve").mockResolvedValue({ conv: { kind: "thread", purpose, id: "x" }, participantIds: new Set(), lastReadSeq: 0n, seen: null });
      await expect(call("prepareAssistantTurn"), `${purpose}`).rejects.toMatchObject({ response: { code: "not_principal" } });
      await expect(call("recordAssistantTurn"), `${purpose}`).rejects.toMatchObject({ response: { code: "not_principal" } });
      resolve.mockRestore();
    }
    // A thread de assunto passa da recusa (e só então toca o banco).
    const resolve = vi.spyOn(access as { resolve: () => Promise<unknown> }, "resolve").mockResolvedValue({ conv: { kind: "thread", purpose: "topic", id: "x", openingMessageId: null }, participantIds: new Set(), lastReadSeq: 0n, seen: null });
    await expect(call("prepareAssistantTurn")).rejects.toThrow("leu o banco");
    await expect(call("recordAssistantTurn")).rejects.toThrow("leu o banco");
    resolve.mockRestore();
  });
});

describe("revisão 1: concorrência do assistente, testes portados (item 7)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;
  const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;

  it("a conversa mudou durante a chamada ao provedor: 409 chat_changed e nada é gravado dessa troca", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await send(h, "contributor", t.ticket, "um");
    h.chat().onCall = async () => {
      const conv = (await h.pool.query<{ id: string }>("select id from conversations where owner_person_id = $1 and kind = 'ticket'", [p().contributor])).rows[0]!.id;
      await h.pool.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('org_A',$1,$2,'de outro aparelho')", [conv, p().contributor]);
    };
    const res = await send(h, "contributor", t.ticket, "dois");
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("chat_changed");
    expect((await rows("select count(*)::int as n from conversation_messages where body = 'dois'"))[0].n).toBe(0);
  });

  it("a reserva esquecida (processo caiu) vence sozinha", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await send(h, "contributor", t.ticket, "um");
    await h.pool.query("update conversations set turn_started_at = now() - interval '10 minutes'");
    expect((await send(h, "contributor", t.ticket, "dois")).status).toBe(201);
    await h.pool.query("update conversations set turn_started_at = now()");
    expect(errorCode(await send(h, "contributor", t.ticket, "três"))).toBe("chat_busy");
  });
});

describe("revisão 2: herança com inativo e não lida escondida (itens 3 e 4)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;

  it("participante desativado na conversa de cima não trava a thread com ticketId", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "manager");
    const t1 = (await post(h, "manager", general, "sem ticket", [p().plain])).body.thread.id as string;
    expect(errorCode(await post(h, "manager", t1, "com ticket", [p().reader], t.ticket))).toBe("participant_cannot_view_ticket");
    await h.pool.query("update people set active = false where id = $1", [p().plain]);
    expect((await post(h, "manager", t1, "com ticket", [p().reader], t.ticket)).status).toBe(201);
  });

  it("a mensagem que abriu uma thread escondida não conta como não lida (item e contagem coerentes)", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "manager");
    const t1 = (await post(h, "manager", general, "sem ticket", [p().reader])).body.thread.id as string;
    await post(h, "manager", t1, "com ticket", [p().contributor], t.ticket);
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [p().reader, h.world().projects.priv]);
    const after = await view(h, "reader", t1);
    // Só a abertura da própria T1 ("sem ticket") é não lida; a que abriu a thread escondida não conta, no item nem na contagem.
    expect(after.body.unread).toBe(1);
    expect(after.body.messages.items.filter((m: { unread: boolean }) => m.unread)).toHaveLength(after.body.unread);
    expect(after.body.messages.items.filter((m: { unread: boolean; body: string }) => m.unread && m.body === "com ticket")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { CHAT_ASSISTANT_PER_PERSON_PER_MINUTE } from "@treepm/domain";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { errorCode, openGeneral, openTicket, post, seedChatTickets, send, topic, view } from "./chat-support.js";
import { as } from "./world.js";

// ADR 0056, fatia 2 (TREEPM-398): o texto livre da barra vira thread de assunto, uma conversa do assistente com UM participante.
const S = { main: "SENTINELA-PRINCIPAL-d41", other: "SENTINELA-OUTRA-THREAD-8e2", people: "SENTINELA-PESSOAS-17c" };

describe("thread de assunto: fluxo", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;
  const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;

  it("no chat geral: a abertura fica em cima, a thread nasce com purpose topic e a resposta do assistente fica DENTRO dela", async () => {
    const general = await openGeneral(h, "manager");
    const res = await topic(h, "manager", general, "Como divido a migração?");
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("topic");
    expect(res.body.message.body).toBe("Como divido a migração?");
    expect(res.body.reply.authorKind).toBe("assistant");
    expect(res.body.thread.participantCount).toBe(1);
    const thread = res.body.thread.id as string;
    const conv = (await rows("select kind, purpose, title, parent_id, owner_person_id from conversations where id = $1", [thread]))[0];
    expect(conv).toMatchObject({ kind: "thread", purpose: "topic", title: "Assunto de teste", parent_id: general, owner_person_id: p().manager });
    expect((await rows("select person_id from conversation_participants where conversation_id = $1", [thread])).map((r) => r.person_id)).toEqual([p().manager]);
    // A abertura mora na conversa de cima; a resposta, na thread.
    expect((await rows("select body from conversation_messages where conversation_id = $1 order by seq", [general])).map((r) => r.body)).toEqual(["Como divido a migração?"]);
    expect((await rows("select author_person_id, body from conversation_messages where conversation_id = $1", [thread])).map((r) => r.author_person_id)).toEqual([null]);
    // Lida pela pessoa, a thread mostra a abertura e a resposta.
    const seen = await view(h, "manager", thread);
    expect(seen.status).toBe(200);
    expect(seen.body.messages.items.map((m: { authorKind: string }) => m.authorKind)).toEqual(["assistant", "person"]);
    expect(seen.body.conversation).toMatchObject({ purpose: "topic", title: "Assunto de teste", canAddParticipants: false });
  });

  it("no chat de um ticket: o contexto do ticket vai ao provedor e a resposta fica na thread, não na conversa de cima", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const res = await topic(h, "manager", main, "O que falta aqui?");
    expect(res.status).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expect(h.chat().calls[0]!.ticket?.key).toBe(t.keys.ticket);
    expect(h.chat().calls[0]!.history).toEqual([{ author: "person", body: "O que falta aqui?" }]);
    expect((await rows("select count(*)::int as n from conversation_messages where conversation_id = $1 and author_person_id is null", [main]))[0].n).toBe(0);
    expect((await rows("select count(*)::int as n from conversation_messages where conversation_id = $1 and author_person_id is null", [res.body.thread.id]))[0].n).toBe(1);
  });

  it("o provedor lê SÓ a thread: nada da conversa de cima além da abertura, nada de outras threads, nem de threads entre pessoas", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    expect((await post(h, "manager", main, S.main)).status).toBe(201);
    expect((await post(h, "manager", main, S.people, [p().reader])).status).toBe(201);
    const other = await topic(h, "manager", main, S.other);
    expect(other.status).toBe(201);
    h.chat().calls.length = 0;
    const first = await topic(h, "manager", main, "Primeira do assunto");
    expect(h.chat().calls).toHaveLength(1);
    expect(h.chat().calls[0]!.history).toEqual([{ author: "person", body: "Primeira do assunto" }]);
    expect(JSON.stringify(h.chat().calls)).not.toMatch(/SENTINELA-(PRINCIPAL|OUTRA|PESSOAS)/);
    const thread = first.body.thread.id as string;
    // Segunda mensagem na thread: a abertura, a resposta e a nova, e só isso.
    const second = await post(h, "manager", thread, "Segunda do assunto");
    expect(second.status).toBe(201);
    expect(second.body.kind).toBe("assistant");
    expect(h.chat().calls).toHaveLength(2);
    expect(h.chat().calls[1]!.history.map((m) => m.author)).toEqual(["person", "assistant", "person"]);
    expect(h.chat().calls[1]!.history.map((m) => m.body)[0]).toBe("Primeira do assunto");
    expect(h.chat().calls[1]!.history.at(-1)).toEqual({ author: "person", body: "Segunda do assunto" });
    expect(JSON.stringify(h.chat().calls[1])).not.toMatch(/SENTINELA-(PRINCIPAL|OUTRA|PESSOAS)/);
    expect(h.chat().calls[1]!.ticket?.key).toBe(t.keys.ticket);
    // A resposta nova também ficou na thread.
    expect((await rows("select count(*)::int as n from conversation_messages where conversation_id = $1", [thread]))[0].n).toBe(3);
    // E a conversa de cima só tem a resposta da mensagem normal (a do assistente na principal), nenhuma das threads de assunto.
    expect((await rows("select count(*)::int as n from conversation_messages where conversation_id = $1 and author_person_id is null", [main]))[0].n).toBe(1);
  });

  it("o título vem na primeira resposta, é gravado e devolvido na árvore e na conversa; a segunda vez o provedor nem o pede", async () => {
    const general = await openGeneral(h, "manager");
    const res = await topic(h, "manager", general, "Quero planejar a release");
    expect(h.chat().calls[0]!.wantTitle).toBe(true);
    const thread = res.body.thread.id as string;
    expect(res.body.thread).toMatchObject({ purpose: "topic", title: "Assunto de teste" });
    const tree = await h.call("GET", "/api/conversations", as("manager"));
    const node = tree.body.items[0].children.find((c: { id: string }) => c.id === thread);
    expect(node).toMatchObject({ kind: "thread", purpose: "topic", title: "Assunto de teste", participantCount: 1 });
    expect(node.label).toBe("Quero planejar a release");
    await post(h, "manager", thread, "Mais uma");
    expect(h.chat().calls[1]!.wantTitle).toBe(false);
    expect((await rows("select title from conversations where id = $1", [thread]))[0].title).toBe("Assunto de teste");
  });

  it("depois de abrir threads de assunto, um turno na principal não leva ao provedor as aberturas nem as respostas de dentro delas", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    expect((await post(h, "manager", main, "Mensagem normal antes")).status).toBe(201);
    h.chat().reply_ = () => "RESPOSTA-DENTRO-DO-ASSUNTO-9f3";
    const opened = await topic(h, "manager", main, "ABERTURA-DE-ASSUNTO-52b");
    expect(opened.status).toBe(201);
    h.chat().reply_ = null;
    expect((await topic(h, "manager", main, "OUTRA-ABERTURA-6c0")).status).toBe(201);
    h.chat().calls.length = 0;
    expect((await post(h, "manager", main, "Agora na principal")).status).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    const sent = h.chat().calls[0]!;
    expect(sent.history.map((m) => m.body)).toEqual(["Mensagem normal antes", expect.any(String), "Agora na principal"]);
    expect(JSON.stringify(sent)).not.toMatch(/ABERTURA-DE-ASSUNTO|OUTRA-ABERTURA|RESPOSTA-DENTRO-DO-ASSUNTO/);
  });

  it("um turno na thread de assunto, depois de existir uma thread com pessoas dentro dela, não leva nada do convidado ao provedor", async () => {
    const general = await openGeneral(h, "manager");
    const opened = await topic(h, "manager", general, "Primeira do assunto");
    const thread = opened.body.thread.id as string;
    const guest = await post(h, "manager", thread, "Alice, veja", [p().reader]);
    expect(guest.body.kind).toBe("thread");
    const child = guest.body.thread.id as string;
    expect((await post(h, "reader", child, "TEXTO-DO-CONVIDADO-a77")).status).toBe(201);
    h.chat().calls.length = 0;
    expect((await post(h, "manager", thread, "Seguindo no assunto")).status).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expect(JSON.stringify(h.chat().calls)).not.toMatch(/TEXTO-DO-CONVIDADO|Alice, veja/);
    expect(h.chat().calls[0]!.history.at(-1)).toEqual({ author: "person", body: "Seguindo no assunto" });
  });

  it("título inválido na abertura: o provedor pede o título de novo na mensagem seguinte, enquanto a thread não tem título", async () => {
    h.chat().title_ = () => "Termina com ponto.";
    const general = await openGeneral(h, "manager");
    const opened = await topic(h, "manager", general, "Assunto sem título bom");
    expect(opened.body.thread.title).toBeNull();
    const thread = opened.body.thread.id as string;
    h.chat().title_ = null;
    await post(h, "manager", thread, "Mais uma");
    expect(h.chat().calls.at(-1)!.wantTitle).toBe(true);
    expect((await rows("select title from conversations where id = $1", [thread]))[0].title).toBe("Assunto de teste");
    await post(h, "manager", thread, "E outra");
    expect(h.chat().calls.at(-1)!.wantTitle).toBe(false);
  });

  it("duas aberturas de assunto ao mesmo tempo na mesma conversa: as duas terminam, ou uma é recusada ANTES de chamar o provedor; nunca depois", async () => {
    const general = await openGeneral(h, "manager");
    let arrived = 0;
    h.chat().onCall = async () => {
      arrived += 1;
      // Segura cada chamada até a outra chegar (ou 400 ms), para as duas gravações competirem.
      const until = Date.now() + 400;
      while (arrived < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    };
    const [a, b] = await Promise.all([topic(h, "manager", general, "Assunto A"), topic(h, "manager", general, "Assunto B")]);
    const statuses = [a.status, b.status].sort();
    const calls = h.chat().calls.length;
    for (const res of [a, b]) {
      if (res.status !== 201) expect(calls, "recusada depois de chamar o provedor").toBe(1);
    }
    expect(statuses.every((s) => s === 201) || (statuses.includes(201) && calls === 1)).toBe(true);
    const made = (await rows("select count(*)::int as n from conversations where parent_id = $1 and purpose = 'topic'", [general]))[0].n;
    expect(made).toBe(statuses.filter((s) => s === 201).length);
  });

  it.each([
    ["ponto final", "Planejar a release."],
    ["comprido demais", "x".repeat(61)],
    ["vazio", "   "],
    ["com quebra de linha", "Duas\nlinhas"],
  ])("título inválido (%s) é ignorado: a thread nasce sem título e a resposta vale", async (_name, bad) => {
    h.chat().title_ = () => bad;
    const general = await openGeneral(h, "manager");
    const res = await topic(h, "manager", general, "Assunto com título ruim");
    expect(res.status).toBe(201);
    expect(res.body.thread.title).toBeNull();
    expect((await rows("select title from conversations where id = $1", [res.body.thread.id]))[0].title).toBeNull();
    // O título do provedor, quando existe e é válido, é aparado.
    h.chat().title_ = () => "  Bom título  ";
    const ok = await topic(h, "manager", general, "Outro assunto");
    expect(ok.body.thread.title).toBe("Bom título");
  });

  it("topic junto de mentions: 422; topic dentro de thread: 422; topic com ticketId: 422; nada é gravado nem chama o provedor", async () => {
    const general = await openGeneral(h, "manager");
    const both = await topic(h, "manager", general, "oi", { mentions: [p().reader] });
    expect(both.status).toBe(422);
    expect(errorCode(both)).toBe("topic_with_mentions");
    const inside = await topic(h, "manager", general, "primeiro");
    const nested = await topic(h, "manager", inside.body.thread.id, "dentro");
    expect(nested.status).toBe(422);
    expect(errorCode(nested)).toBe("topic_in_thread");
    const people = (await post(h, "manager", general, "marca", [p().reader])).body.thread.id as string;
    expect((await topic(h, "manager", people, "dentro de pessoas")).status).toBe(422);
    const t = await seedChatTickets(h.pool, h.world());
    const withTicket = await topic(h, "manager", general, "com ticket", { ticketId: t.ticket });
    expect(withTicket.status).toBe(422);
    expect(errorCode(withTicket)).toBe("topic_with_ticket");
    expect(h.chat().calls).toHaveLength(1);
    expect((await rows("select count(*)::int as n from conversations where kind = 'thread'"))[0].n).toBe(2);
  });

  it("incluir pessoa numa thread de assunto: 422 private_thread, e canAddParticipants é falso", async () => {
    const general = await openGeneral(h, "manager");
    const res = await topic(h, "manager", general, "Só meu");
    const add = await h.call("POST", `/api/conversations/${res.body.thread.id}/participants`, as("manager"), { personIds: [p().reader] });
    expect(add.status).toBe(422);
    expect(errorCode(add)).toBe("private_thread");
    expect((await rows("select count(*)::int as n from conversation_participants where conversation_id = $1", [res.body.thread.id]))[0].n).toBe(1);
    expect((await view(h, "manager", res.body.thread.id)).body.conversation.canAddParticipants).toBe(false);
  });

  it("marcar alguém dentro da thread de assunto abre uma thread `people` separada; essa pessoa não lê a de assunto (404 igual ao de inexistente), nem o título, nem contagem", async () => {
    const general = await openGeneral(h, "manager");
    const res = await topic(h, "manager", general, "SEGREDO-ASSUNTO-5a1");
    h.chat().title_ = () => "SEGREDO-TITULO-3b9";
    const secret = await topic(h, "manager", general, "SEGREDO-OUTRO-ASSUNTO-77e");
    const thread = secret.body.thread.id as string;
    h.chat().calls.length = 0;
    const mention = await post(h, "manager", thread, "Alice, olha isto", [p().reader]);
    expect(mention.status).toBe(201);
    expect(mention.body.kind).toBe("thread");
    expect(h.chat().calls).toHaveLength(0);
    const child = mention.body.thread.id as string;
    expect((await rows("select purpose, title, parent_id from conversations where id = $1", [child]))[0]).toMatchObject({ purpose: "people", title: null, parent_id: thread });
    expect(mention.body.thread.purpose).toBe("people");
    // Alice lê a thread filha e nada mais.
    expect((await view(h, "reader", child)).status).toBe(200);
    for (const id of [thread, general, res.body.thread.id]) {
      const read = await view(h, "reader", id);
      expect(read.status).toBe(404);
      expect(read.body).toEqual((await view(h, "reader", "00000000-0000-4000-8000-000000000000")).body);
    }
    const everything = JSON.stringify([await h.call("GET", "/api/conversations", as("reader")), await view(h, "reader", child)]);
    expect(everything).not.toMatch(/SEGREDO-(TITULO|ASSUNTO|OUTRO)/);
    for (const id of [thread, general, res.body.thread.id]) expect(everything).not.toContain(id);
    // A filha dentro da thread de assunto não deixa o assistente falar nela (continua entre pessoas).
    const chat = await post(h, "reader", child, "sem menção");
    expect(chat.body.kind).toBe("message");
    expect(h.chat().calls).toHaveLength(0);
  });

  it("quem não participa recebe 404 ao abrir ou escrever (antes de qualquer outra coisa)", async () => {
    const general = await openGeneral(h, "manager");
    const own = await topic(h, "manager", general, "meu assunto");
    for (const id of [general, own.body.thread.id]) {
      const res = await topic(h, "reader", id, "intruso");
      expect(res.status).toBe(404);
      expect((await post(h, "reader", id, "intruso")).status).toBe(404);
    }
    expect(h.chat().calls).toHaveLength(1);
  });

  it("vez do assistente: segunda mensagem enquanto a primeira espera o provedor é 409 chat_busy; erro do provedor solta a vez e não grava nada", async () => {
    const general = await openGeneral(h, "manager");
    const first = await topic(h, "manager", general, "abre");
    const thread = first.body.thread.id as string;
    await h.pool.query("update conversations set turn_started_at = now() where id = $1", [thread]);
    const calls = h.chat().calls.length;
    const busy = await post(h, "manager", thread, "ao mesmo tempo");
    expect(busy.status).toBe(409);
    expect(errorCode(busy)).toBe("chat_busy");
    expect(h.chat().calls).toHaveLength(calls);
    await h.pool.query("update conversations set turn_started_at = null where id = $1", [thread]);
    // A vez é reservada enquanto o provedor pensa (e só da thread: a principal continua livre).
    h.chat().onCall = async () => {
      expect((await rows("select turn_started_at from conversations where id = $1", [thread]))[0].turn_started_at).not.toBeNull();
      expect((await rows("select turn_started_at from conversations where id = $1", [general]))[0].turn_started_at).toBeNull();
    };
    expect((await post(h, "manager", thread, "devagar")).status).toBe(201);
    h.chat().onCall = null;
    expect((await rows("select turn_started_at from conversations where id = $1", [thread]))[0].turn_started_at).toBeNull();
    h.chat().fail = true;
    const failed = await post(h, "manager", thread, "vai falhar");
    expect(failed.status).toBe(503);
    expect((await rows("select turn_started_at from conversations where id = $1", [thread]))[0].turn_started_at).toBeNull();
    expect((await rows("select count(*)::int as n from conversation_messages where body = 'vai falhar'"))[0].n).toBe(0);
    // Abrir com o provedor falhando não cria thread nem deixa a mensagem de abertura.
    const before = (await rows("select count(*)::int as n from conversation_messages"))[0].n;
    const none = await topic(h, "manager", general, "abertura que falha");
    expect(none.status).toBe(503);
    expect((await rows("select count(*)::int as n from conversation_messages"))[0].n).toBe(before);
    expect((await rows("select count(*)::int as n from conversations where kind = 'thread' and parent_id = $1", [general]))[0].n).toBe(1);
    h.chat().fail = false;
    expect((await post(h, "manager", thread, "agora vai")).status).toBe(201);
  });

  it("a mensagem no projeto arquivado: abrir assunto num ticket de projeto arquivado é 409 project_archived e não chama o provedor", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
    const res = await topic(h, "manager", main, "num arquivado");
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe("project_archived");
    expect(h.chat().calls).toHaveLength(0);
  });
});

describe("thread de assunto: aceite e provedor antes de tudo", () => {
  const noConsent = useHarness(AI_CONFIG, { consent: false });
  it("sem aceite: quem não participa recebe 404 e o dono 403; nada é criado", async () => {
    const general = await openGeneral(noConsent, "manager");
    expect((await topic(noConsent, "reader", general, "oi")).status).toBe(404);
    const res = await topic(noConsent, "manager", general, "oi");
    expect(res.status).toBe(403);
    expect(noConsent.chat().calls).toHaveLength(0);
    expect((await noConsent.pool.query("select count(*)::int as n from conversations where kind = 'thread'")).rows[0].n).toBe(0);
  });
});
describe("thread de assunto: sem provedor", () => {
  const none = useHarness(TEST_CONFIG);
  it("sem provedor: quem não participa recebe 404 e o dono 503; nada é criado", async () => {
    const general = await openGeneral(none, "manager");
    expect((await topic(none, "reader", general, "oi")).status).toBe(404);
    expect((await topic(none, "manager", general, "oi")).status).toBe(503);
    expect((await none.pool.query("select count(*)::int as n from conversations where kind = 'thread'")).rows[0].n).toBe(0);
  });
});

describe("thread de assunto: limite por minuto", () => {
  const clock = { t: 1_000_000, now: () => clock.t };
  const h = useHarness(AI_CONFIG, { clock });
  it("o teto do assistente conta as mensagens da principal, as aberturas de assunto e as respostas dentro das threads de assunto", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    clock.t += 61_000;
    const opened = await topic(h, "manager", main, "primeira");
    const thread = opened.body.thread.id as string;
    let sent = 1;
    const kinds = [() => send(h, "manager", t.ticket, "na principal"), () => post(h, "manager", thread, "na thread"), () => topic(h, "manager", main, "outro assunto")];
    while (sent < CHAT_ASSISTANT_PER_PERSON_PER_MINUTE) {
      const res = await kinds[sent % kinds.length]!();
      expect(res.status, `mensagem ${sent}`).toBe(201);
      sent += 1;
    }
    const over = await post(h, "manager", thread, "uma a mais");
    expect(over.status).toBe(429);
    expect(errorCode(over)).toBe("chat_rate_limited");
    // Depois da janela, volta.
    clock.t += 61_000;
    expect((await post(h, "manager", thread, "de novo")).status).toBe(201);
  });
});

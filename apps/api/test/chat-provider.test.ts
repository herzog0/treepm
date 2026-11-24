import { describe, expect, it } from "vitest";
import { CHAT_HISTORY_MAX_MESSAGES } from "@treepm/domain";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { SENTINEL, errorCode, openGeneral, openTicket, post, reply, seedChatTickets, send } from "./chat-support.js";
import { as, giveConsent } from "./world.js";

// ADR 0049, regra 3: o que vai ao provedor do chat é título, descrição, situação, prioridade que vale, caminho, filhos e dependências do
// ticket, e as mensagens da própria conversa da pessoa. Nada mais. Provedor falso grava o que recebeu e cada item proibido é afirmado por ausência.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("o que vai ao provedor do chat", () => {
  const h = useHarness(AI_CONFIG);

  it("manda o contexto do ticket e a mensagem, e só isso", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const res = await send(h, "contributor", t.ticket, "Como eu começo?");
    expect(res.status).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    const call = h.chat().calls[0]!;
    expect(call.history).toEqual([{ author: "person", body: "Como eu começo?" }]);
    expect(call.ticket).toEqual({
      key: "PRIV-3",
      title: "Ticket do chat",
      description: "Descrição do ticket do chat.",
      status: "in_progress",
      priority: 5, // herdada da raiz (ADR 0047): a que vale, não a do próprio ticket
      path: [{ key: "PRIV-1", title: "Raiz do caminho" }, { key: "PRIV-2", title: "Pai do ticket" }],
      children: [{ key: "PRIV-4", title: "Filho um", status: "in_progress" }, { key: "PRIV-5", title: "Filho dois", status: "todo" }],
      dependsOn: [{ key: "PRIV-6", title: "Depende deste", status: "done" }],
      blocks: [{ key: "PRIV-7", title: "Bloqueado por este", status: "todo" }],
    });
    expect(res.body.kind).toBe("assistant");
    expect(res.body.message.body).toBe("Como eu começo?");
    expect(res.body.reply.authorKind).toBe("assistant");
  });

  it("nunca manda comentário, histórico, área, nota do marcador, neto, nome, e-mail, id nem mensagem de outra pessoa ou de thread", async () => {
    const world = h.world();
    const t = await seedChatTickets(h.pool, world);
    // Outra pessoa conversa com o assistente e há uma thread entre pessoas, com o nome de quem foi mencionado no texto.
    expect((await send(h, "manager", t.ticket, SENTINEL.otherPerson)).status).toBe(201);
    const thread = await send(h, "manager", t.ticket, `${SENTINEL.thread} @Nome reader`, [world.people.reader]);
    expect(thread.status).toBe(201);
    expect((await reply(h, "reader", thread.body.thread.id, SENTINEL.threadReply)).status).toBe(201);
    // O leitor também conversa com o assistente, e a mensagem DELE é a única que o provedor pode receber nesta chamada.
    h.chat().calls.length = 0;
    expect((await send(h, "reader", t.ticket, "Minha pergunta")).status).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    const wire = JSON.stringify(h.chat().calls);
    for (const [name, text] of Object.entries(SENTINEL)) expect(wire.includes(text), `vazou ${name}`).toBe(false);
    expect(wire).not.toMatch(UUID);
    for (const forbidden of ["Nome ", "@exemplo", "exemplo.test", "Área sentinela", "reader", "manager", "contributor"]) expect(wire.includes(forbidden), `vazou ${forbidden}`).toBe(false);
    expect(h.chat().calls[0]!.history).toEqual([{ author: "person", body: "Minha pergunta" }]);
  });

  it("a conversa seguinte leva só as mensagens DA PRÓPRIA pessoa com o assistente, em ordem", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await send(h, "contributor", t.ticket, "primeira");
    await send(h, "manager", t.ticket, SENTINEL.otherPerson);
    await send(h, "contributor", t.ticket, "segunda");
    const second = h.chat().calls[2]!;
    expect(second.history.map((m) => `${m.author}:${m.body.replace(/^Resposta sobre PRIV-3: /, "")}`)).toEqual(["person:primeira", "assistant:primeira", "person:segunda"]);
    expect(JSON.stringify(second)).not.toContain(SENTINEL.otherPerson);
  });

  it("o teto: as mais recentes, no máximo 20 mensagens, começando por uma da pessoa e terminando na nova", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    // 15 trocas semeadas direto no banco (o limite por minuto vale para a API, não para a semente).
    const chat = await openTicket(h, "contributor", t.ticket);
    for (let i = 1; i <= 15; i += 1) {
      await h.pool.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('org_A',$1,$2,$3)", [chat, h.world().people.contributor, `p${i}`]);
      await h.pool.query("insert into conversation_messages (org_id, conversation_id, body, model) values ('org_A',$1,$2,'m')", [chat, `a${i}`]);
    }
    expect((await send(h, "contributor", t.ticket, "nova")).status).toBe(201);
    const history = h.chat().calls[0]!.history;
    expect(history.length).toBeLessThanOrEqual(CHAT_HISTORY_MAX_MESSAGES);
    expect(history[0]!.author).toBe("person");
    expect(history[history.length - 1]).toEqual({ author: "person", body: "nova" });
    expect(history.map((m) => m.body)).not.toContain("p1");
    expect(history.map((m) => m.body)).toContain("a15");
  });

  it("depois de a pessoa limpar o chat, o provedor não recebe mais nada do que foi apagado", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await send(h, "contributor", t.ticket, "antiga");
    await h.call("DELETE", `/api/conversations/${await openTicket(h, "contributor", t.ticket)}/messages`, as("contributor"));
    h.chat().calls.length = 0;
    await send(h, "contributor", t.ticket, "nova");
    expect(JSON.stringify(h.chat().calls)).not.toContain("antiga");
  });

  it("o provedor lê o ticket na hora de cada resposta (título novo vale)", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await send(h, "contributor", t.ticket, "um");
    await h.pool.query("update tickets set title = 'Título novo' where id = $1", [t.ticket]);
    await send(h, "contributor", t.ticket, "dois");
    expect(h.chat().calls[1]!.ticket?.title).toBe("Título novo");
  });

  it("provedor fora do ar: 503 assistant_unavailable e a mensagem da pessoa NÃO fica guardada", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    h.chat().fail = true;
    const res = await send(h, "contributor", t.ticket, "se perde");
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe("assistant_unavailable");
    const n = await h.pool.query("select count(*)::int as n from conversation_messages");
    expect(n.rows[0].n).toBe(0);
  });

  it("a mensagem que abriu uma thread mora na conversa principal mas nunca vai ao provedor, e não atrapalha a conversa", async () => {
    const world = h.world();
    const t = await seedChatTickets(h.pool, world);
    expect((await send(h, "contributor", t.ticket, "primeira ao assistente")).status).toBe(201);
    const opened = await send(h, "contributor", t.ticket, `${SENTINEL.thread} abre`, [world.people.reader]);
    expect(opened.body.kind).toBe("thread");
    expect((await reply(h, "reader", opened.body.thread.id, SENTINEL.threadReply)).status).toBe(201);
    h.chat().calls.length = 0;
    expect((await send(h, "contributor", t.ticket, "segunda ao assistente")).status).toBe(201);
    const call = h.chat().calls[0]!;
    expect(call.history.map((m) => m.author)).toEqual(["person", "assistant", "person"]);
    expect(JSON.stringify(h.chat().calls)).not.toContain(SENTINEL.thread);
    expect(JSON.stringify(h.chat().calls)).not.toContain(SENTINEL.threadReply);
  });

  it("o chat geral não trata de ticket: o provedor recebe só a conversa da pessoa, sem contexto de ticket", async () => {
    const world = h.world();
    await seedChatTickets(h.pool, world);
    const general = await openGeneral(h, "contributor");
    const res = await post(h, "contributor", general, "Ideia solta");
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("assistant");
    const call = h.chat().calls[0]!;
    expect(call.ticket).toBeNull();
    expect(call.history).toEqual([{ author: "person", body: "Ideia solta" }]);
    expect(JSON.stringify(call)).not.toMatch(UUID);
  });

  it("a mensagem muda nada em log ou atividade: nenhum evento de histórico nem versão do projeto", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const before = await h.pool.query("select (select count(*) from activity_events)::int as events, (select tickets_version from projects where id = $1)::int as version", [h.world().projects.priv]);
    await send(h, "contributor", t.ticket, "oi");
    const after = await h.pool.query("select (select count(*) from activity_events)::int as events, (select tickets_version from projects where id = $1)::int as version", [h.world().projects.priv]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe("sem aceite ou sem provedor configurado, a mensagem não vai a provedor nenhum", () => {
  const noConsent = useHarness(AI_CONFIG, { consent: false });
  it("sem aceite: 403 assistant_consent_required, nada chamado, nada guardado", async () => {
    const t = await seedChatTickets(noConsent.pool, noConsent.world());
    const res = await send(noConsent, "contributor", t.ticket, "oi");
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("assistant_consent_required");
    expect(noConsent.chat().calls).toHaveLength(0);
    expect((await noConsent.pool.query("select count(*)::int as n from conversation_messages")).rows[0].n).toBe(0);
  });

  it("thread (com menção) funciona SEM aceite: é conversa entre pessoas, não vai a provedor", async () => {
    const t = await seedChatTickets(noConsent.pool, noConsent.world());
    const res = await send(noConsent, "contributor", t.ticket, "olha isto", [noConsent.world().people.reader]);
    expect(res.status).toBe(201);
    expect(noConsent.chat().calls).toHaveLength(0);
    expect(noConsent.conversation().calls).toHaveLength(0);
  });

  it("depois do aceite dado, a conversa passa", async () => {
    const t = await seedChatTickets(noConsent.pool, noConsent.world());
    await giveConsent(noConsent.pool, "org_A", noConsent.world().people.admin);
    expect((await send(noConsent, "contributor", t.ticket, "oi")).status).toBe(201);
  });
});

describe("assistente não configurado", () => {
  const off = useHarness(TEST_CONFIG);
  it("503 assistant_not_configured para a conversa; a thread segue funcionando", async () => {
    const t = await seedChatTickets(off.pool, off.world());
    const res = await send(off, "contributor", t.ticket, "oi");
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe("assistant_not_configured");
    expect((await send(off, "contributor", t.ticket, "oi", [off.world().people.reader])).status).toBe(201);
  });
});

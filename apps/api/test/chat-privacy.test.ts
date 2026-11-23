import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { SENTINEL, errorCode, reply, seedChatTickets, send, view } from "./chat-support.js";
import { WHO, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0049, regra 1: a conversa da pessoa com o assistente só é lida por ela; a thread, só por quem participa dela. Nenhum papel
// (nem administrador da organização, nem gestor do projeto) lê o chat de outra pessoa. Cada rota de leitura, com cada papel.
const SECRET = { contributor: "SEGREDO-DO-CONTRIBUTOR-4471", manager: "SEGREDO-DO-GESTOR-90bd", thread: "SEGREDO-DA-THREAD-GESTOR-LEITOR-12ce", threadReply: "SEGREDO-RESPOSTA-DA-THREAD-77aa" };
const ALL: (Who | "target")[] = [...WHO, "target"];
/** Quem enxerga o projeto privado (papel Clerk de administrador ou papel no projeto): os demais recebem 404 em tudo. */
const SEES = new Set<Who | "target">(["admin", "manager", "contributor", "reader", "target"]);

describe("privacidade do chat", () => {
  const h = useHarness(AI_CONFIG);

  async function scenario() {
    const world = h.world();
    const t = await seedChatTickets(h.pool, world);
    expect((await send(h, "contributor", t.ticket, SECRET.contributor)).status).toBe(201);
    expect((await send(h, "manager", t.ticket, SECRET.manager)).status).toBe(201);
    const started = await send(h, "manager", t.ticket, SECRET.thread, [world.people.reader]);
    expect(started.status).toBe(201);
    const threadId = started.body.thread.id as string;
    expect((await reply(h, "reader", threadId, SECRET.threadReply)).status).toBe(201);
    return { t, threadId, world };
  }

  /** O que cada pessoa PODE ver dos segredos: a conversa é da dona; a thread, de quem participa (gestor e leitor). */
  const mayRead = (who: Who | "target", secret: string): boolean => {
    if (secret === SECRET.contributor) return who === "contributor";
    if (secret === SECRET.manager) return who === "manager";
    return who === "manager" || who === "reader";
  };

  it.each(ALL)("GET /tickets/:id/chat como %s: nunca devolve o que é de outra pessoa", async (who) => {
    const { t } = await scenario();
    const res = await view(h, who, t.ticket);
    if (!SEES.has(who)) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("SEGREDO");
      return;
    }
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    // As respostas da thread só vêm na rota da thread; aqui vem a raiz.
    for (const secret of [SECRET.contributor, SECRET.manager, SECRET.thread]) expect(text.includes(secret), `${who} lê ${secret}`).toBe(mayRead(who, secret));
    expect(text).not.toContain(SECRET.threadReply);
  });

  it.each(ALL)("GET /tickets/:id/chat paginado (limit=1, before) como %s: as páginas também respeitam", async (who) => {
    const { t } = await scenario();
    if (!SEES.has(who)) return;
    let text = "";
    let before = "";
    for (let i = 0; i < 5; i += 1) {
      const res = await view(h, who, t.ticket, `?limit=1${before}`);
      expect(res.status).toBe(200);
      text += JSON.stringify(res.body);
      if (res.body.messages.nextBefore === null) break;
      before = `&before=${res.body.messages.nextBefore}`;
    }
    for (const secret of [SECRET.contributor, SECRET.manager]) expect(text.includes(secret), `${who} lê ${secret}`).toBe(mayRead(who, secret));
  });

  it.each(ALL)("GET /chat-threads/:id como %s: só participante lê, os demais recebem o mesmo 404", async (who) => {
    const { threadId } = await scenario();
    const res = await h.call("GET", `/api/chat-threads/${threadId}`, as(who));
    if (who === "manager" || who === "reader") {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(SECRET.thread);
      expect(JSON.stringify(res.body)).toContain(SECRET.threadReply);
    } else {
      expect(res.status).toBe(404);
      expect(errorCode(res)).toBe("not_found");
      expect(JSON.stringify(res.body)).not.toContain("SEGREDO");
    }
  });

  it.each(ALL)("GET /chats como %s: a lista nunca traz o texto de mensagem nenhuma, nem tickets de outra pessoa", async (who) => {
    const { t } = await scenario();
    const res = await h.call("GET", "/api/chats", as(who));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("SEGREDO");
    const tickets = (res.body.items as { ticketId: string }[]).map((i) => i.ticketId);
    // Quem conversou, participa de thread ou é responsável tem o ticket na lista; os demais, não.
    const involved = who === "contributor" || who === "manager" || who === "reader";
    expect(tickets.includes(t.ticket), `${who}`).toBe(involved);
  });

  it.each(ALL)("o administrador, o gestor e quem não participa não leem a thread nem pela página de um chat próprio (%s)", async (who) => {
    const { t } = await scenario();
    // Quem abre o chat do ticket e não participa da thread recebe a lista de threads vazia.
    if (!SEES.has(who)) return;
    const res = await view(h, who, t.ticket);
    const ids = (res.body.threads as { root: { body: string } }[]).map((x) => x.root.body);
    expect(ids.includes(SECRET.thread)).toBe(who === "manager" || who === "reader");
  });

  it("ler, marcar como lido ou limpar o próprio chat não toca o de outra pessoa", async () => {
    const { t } = await scenario();
    for (const who of ["admin", "manager", "reader"] as const) {
      expect((await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as(who), {})).status).toBe(200);
      expect((await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as(who))).status).toBe(204);
    }
    // O administrador, o gestor e o leitor limparam os DELES; o do colaborador continua inteiro.
    expect(JSON.stringify((await view(h, "contributor", t.ticket)).body)).toContain(SECRET.contributor);
    // A thread de que o gestor e o leitor participam sobrevive à limpeza do chat de cada um.
    const manager = await view(h, "manager", t.ticket);
    expect(JSON.stringify(manager.body)).toContain(SECRET.thread);
    expect(JSON.stringify(manager.body)).not.toContain(SECRET.manager);
  });

  it("outra organização não lê nada", async () => {
    const { t, threadId } = await scenario();
    expect((await h.call("GET", `/api/tickets/${t.ticket}/chat`, as("outsider", "org_B"))).status).toBe(404);
    expect((await h.call("GET", `/api/chat-threads/${threadId}`, as("outsider", "org_B"))).status).toBe(404);
    const list = await h.call("GET", "/api/chats", as("outsider", "org_B"));
    expect(JSON.stringify(list.body)).not.toContain(t.ticket);
  });

  it("rota de leitura do chat de outra pessoa não existe: nada aceita o id de pessoa ou de chat", async () => {
    const { t, world } = await scenario();
    for (const path of [`/api/tickets/${t.ticket}/chat?personId=${world.people.contributor}`, `/api/tickets/${t.ticket}/chat?chatId=${world.people.contributor}`]) {
      const res = await h.call("GET", path, as("admin"));
      expect(res.status).toBe(400);
    }
    expect(SENTINEL.comment).toBeTruthy();
  });
});

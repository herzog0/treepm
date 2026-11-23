import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHAT_ASSISTANT_PER_PERSON_PER_MINUTE, CHAT_MAX_MENTIONS, CHAT_THREAD_PER_PERSON_PER_MINUTE } from "@treepm/domain";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { errorCode, reply, seedChatTickets, send, view } from "./chat-support.js";
import { as } from "./world.js";
import { encodeChatCursor } from "../src/assistant/chat-cursor.js";
import { Logger } from "@nestjs/common";
import { vi } from "vitest";

const CLERK_KEY = "sk_test_fake";

describe("chat de trabalho: menções, threads, lista, leitura, limpeza e limites", () => {
  const h = useHarness(AI_CONFIG);
  const people = () => h.world().people;
  const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;

  describe("menção abre thread (regras 4 e 5)", () => {
    it("a mensagem com menção não vai ao assistente: vira raiz de thread, com os mencionados como participantes", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const res = await send(h, "contributor", t.ticket, "Reader, você viu isto?", [people().reader, people().manager]);
      expect(res.status).toBe(201);
      expect(res.body.kind).toBe("thread");
      expect(h.chat().calls).toHaveLength(0);
      const thread = res.body.thread;
      expect(thread.startedByMe).toBe(true);
      expect(thread.root.body).toBe("Reader, você viu isto?");
      expect(thread.participants.map((p: { id: string }) => p.id).sort()).toEqual([people().contributor, people().manager, people().reader].sort());
      // Cada participante ganhou o chat daquele ticket (o do mencionado nasce aqui).
      expect((await rows("select count(*)::int as n from ticket_chats where ticket_id = $1", [t.ticket]))[0].n).toBe(3);
    });

    it("o mencionado vê a thread no chat dele, com a origem; não vê nada mais da conversa de quem o mencionou", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "pergunta privada ao assistente");
      const started = await send(h, "contributor", t.ticket, "Reader, olha", [people().reader]);
      const seen = await view(h, "reader", t.ticket);
      expect(seen.status).toBe(200);
      expect(seen.body.messages.items).toEqual([]);
      expect(seen.body.threads).toHaveLength(1);
      expect(seen.body.threads[0].startedByMe).toBe(false);
      expect(seen.body.threads[0].root.author.id).toBe(people().contributor);
      expect(seen.body.threads[0].id).toBe(started.body.thread.id);
      expect(JSON.stringify(seen.body)).not.toContain("pergunta privada");
    });

    it.each([
      ["quem não enxerga o ticket", () => people().plain],
      ["id que não existe", () => randomUUID()],
      ["pessoa de outra organização", () => h.world().other.person],
    ])("mencionar %s é recusado (422 mention_not_allowed) dizendo só o id enviado, sem criar nada", async (_name, who) => {
      const t = await seedChatTickets(h.pool, h.world());
      const id = who();
      const res = await send(h, "contributor", t.ticket, "oi", [people().reader, id]);
      expect(res.status).toBe(422);
      expect(errorCode(res)).toBe("mention_not_allowed");
      expect(res.body.error.details.personIds).toEqual([id]);
      expect(JSON.stringify(res.body)).not.toContain("Nome ");
      expect((await rows("select count(*)::int as n from ticket_chat_messages"))[0].n).toBe(0);
      expect((await rows("select count(*)::int as n from ticket_chat_thread_members"))[0].n).toBe(0);
    });

    it("pessoa inativa não pode ser mencionada", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await h.pool.query("update people set active = false where id = $1", [people().reader]);
      const res = await send(h, "contributor", t.ticket, "oi", [people().reader]);
      expect(errorCode(res)).toBe("mention_not_allowed");
    });

    it("mencionar a si mesma é recusado; passar do teto de menções também", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const self = await send(h, "contributor", t.ticket, "oi", [people().contributor]);
      expect(self.status).toBe(422);
      expect(errorCode(self)).toBe("cannot_mention_self");
      const many = await send(h, "contributor", t.ticket, "oi", Array.from({ length: CHAT_MAX_MENTIONS + 1 }, () => randomUUID()));
      expect(many.status).toBe(422);
      expect(errorCode(many)).toBe("too_many_mentions");
    });

    it("a mesma pessoa mencionada duas vezes conta uma", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const res = await send(h, "contributor", t.ticket, "oi", [people().reader, people().reader]);
      expect(res.status).toBe(201);
      expect(res.body.thread.participants).toHaveLength(2);
    });

    it("admin de organização que não está no projeto privado... enxerga (papel Clerk) e pode ser mencionado", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      expect((await send(h, "contributor", t.ticket, "oi", [people().admin])).status).toBe(201);
    });
  });

  describe("thread: responder, participar e perder acesso", () => {
    async function open() {
      const t = await seedChatTickets(h.pool, h.world());
      const started = await send(h, "contributor", t.ticket, "primeira da thread", [people().reader]);
      return { t, threadId: started.body.thread.id as string };
    }

    it("participantes respondem; as respostas aparecem para todos; o assistente nunca participa", async () => {
      const { threadId } = await open();
      const r1 = await reply(h, "reader", threadId, "resposta do leitor");
      expect(r1.status).toBe(201);
      expect(r1.body.message.threadId).toBe(threadId);
      expect(r1.body.thread.replyCount).toBe(1);
      const seen = await h.call("GET", `/api/chat-threads/${threadId}`, as("contributor"));
      expect(seen.body.replies.items.map((m: { body: string }) => m.body)).toEqual(["resposta do leitor"]);
      expect(seen.body.thread.root.body).toBe("primeira da thread");
      expect(h.chat().calls).toHaveLength(0);
    });

    it("quem não participa não responde nem lê (404)", async () => {
      const { threadId } = await open();
      expect((await reply(h, "manager", threadId, "intruso")).status).toBe(404);
      expect((await h.call("GET", `/api/chat-threads/${threadId}`, as("manager"))).status).toBe(404);
    });

    it("a resposta com menção inclui mais gente, que passa a ler a thread inteira", async () => {
      const { t, threadId } = await open();
      await reply(h, "reader", threadId, "meio");
      const res = await reply(h, "contributor", threadId, "chamando o gestor", [people().manager]);
      expect(res.status).toBe(201);
      const seen = await h.call("GET", `/api/chat-threads/${threadId}`, as("manager"));
      expect(seen.status).toBe(200);
      expect(seen.body.replies.items.map((m: { body: string }) => m.body).sort()).toEqual(["chamando o gestor", "meio"]);
      expect((await view(h, "manager", t.ticket)).body.threads).toHaveLength(1);
    });

    it("responder mencionando quem já participa não duplica nem recusa", async () => {
      const { threadId } = await open();
      const res = await reply(h, "reader", threadId, "de novo", [people().contributor]);
      expect(res.status).toBe(201);
      expect(res.body.thread.participants).toHaveLength(2);
    });

    it("quem deixa de enxergar o ticket deixa de ler e de escrever, inclusive na thread; as mensagens dela ficam para os outros", async () => {
      const { t, threadId } = await open();
      await reply(h, "reader", threadId, "mensagem do leitor");
      await send(h, "reader", t.ticket, "pergunta ao assistente");
      await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [people().reader, h.world().projects.priv]);
      expect((await view(h, "reader", t.ticket)).status).toBe(404);
      expect((await send(h, "reader", t.ticket, "oi")).status).toBe(404);
      expect((await send(h, "reader", t.ticket, "oi", [people().contributor])).status).toBe(404);
      expect((await h.call("GET", `/api/chat-threads/${threadId}`, as("reader"))).status).toBe(404);
      expect((await reply(h, "reader", threadId, "ainda?")).status).toBe(404);
      expect((await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("reader"), {})).status).toBe(404);
      const list = await h.call("GET", "/api/chats", as("reader"));
      expect(JSON.stringify(list.body)).not.toContain(t.ticket);
      const others = await h.call("GET", `/api/chat-threads/${threadId}`, as("contributor"));
      expect(others.body.replies.items.map((m: { body: string }) => m.body)).toContain("mensagem do leitor");
      // Ao voltar a enxergar, ela retoma o chat dela como estava.
      await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ('org_A',$1,$2,'reader')", [h.world().projects.priv, people().reader]);
      expect((await view(h, "reader", t.ticket)).body.messages.items.map((m: { body: string }) => m.body)).toContain("pergunta ao assistente");
    });
  });

  describe("quem pode abrir o chat (regra 2)", () => {
    it("leitor do projeto conversa com o assistente (a regra é enxergar o ticket, não poder comentar)", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      expect((await send(h, "reader", t.ticket, "oi")).status).toBe(201);
    });
    it.each(["plain", "teamAdmin"] as const)("%s não enxerga o projeto privado: 404 em tudo", async (who) => {
      const t = await seedChatTickets(h.pool, h.world());
      expect((await view(h, who, t.ticket)).status).toBe(404);
      expect((await send(h, who, t.ticket, "oi")).status).toBe(404);
      // Limpar o próprio chat nunca depende de enxergar o ticket (Revisão 1); sem chat, é inócuo.
      expect((await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as(who))).status).toBe(204);
    });
    it("ticket que não existe: 404", async () => {
      expect((await view(h, "contributor", randomUUID())).status).toBe(404);
    });
    it("projeto arquivado: lê, marca lido e limpa; não escreve (409 project_archived)", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "antes");
      await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
      expect((await view(h, "contributor", t.ticket)).status).toBe(200);
      const res = await send(h, "contributor", t.ticket, "depois");
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("project_archived");
      expect(errorCode(await send(h, "contributor", t.ticket, "depois", [people().reader]))).toBe("project_archived");
      expect((await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), {})).status).toBe(200);
    });
  });

  describe("lista \"Meus chats\" e não lidas (regra 6)", () => {
    it("o responsável tem o ticket na lista mesmo sem mensagem; depois da primeira, vem com chatId", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const before = await h.call("GET", "/api/chats", as("manager"));
      expect(before.body.items).toHaveLength(1);
      expect(before.body.items[0]).toMatchObject({ ticketId: t.ticket, ticketKey: "PRIV-3", title: "Ticket do chat", chatId: null, assignedToMe: true, unread: 0 });
      await send(h, "manager", t.ticket, "oi");
      const after = await h.call("GET", "/api/chats", as("manager"));
      expect(after.body.items).toHaveLength(1);
      expect(after.body.items[0].chatId).toBeTruthy();
      expect(after.body.items[0].assignedToMe).toBe(true);
    });

    it("quem conversou e quem foi mencionado também têm; quem não tem nada, lista vazia", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "oi");
      await send(h, "contributor", t.ticket, "olha", [people().reader]);
      for (const who of ["contributor", "reader"] as const) {
        const items = (await h.call("GET", "/api/chats", as(who))).body.items as { ticketId: string }[];
        expect(items.map((i) => i.ticketId)).toEqual([t.ticket]);
      }
      expect((await h.call("GET", "/api/chats", as("target"))).body.items).toEqual([]);
    });

    it("não lidas: a resposta do assistente e as mensagens de OUTRAS pessoas nas threads; as próprias não contam; ler zera", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "oi"); // resposta do assistente: 1 não lida
      const started = await send(h, "contributor", t.ticket, "olha", [people().reader]); // própria: não conta; para o leitor: 1
      const threadId = started.body.thread.id as string;
      await reply(h, "reader", threadId, "vi");
      const unread = async (who: "contributor" | "reader") => (await h.call("GET", "/api/chats", as(who))).body.items[0].unread as number;
      expect(await unread("contributor")).toBe(2); // resposta do assistente + resposta do leitor na thread
      expect(await unread("reader")).toBe(1); // a raiz do contribuidor (a resposta dele mesmo não conta)
      const read = await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), {});
      expect(read.body.unread).toBe(0);
      expect(await unread("contributor")).toBe(0);
      expect(await unread("reader")).toBe(1);
      await reply(h, "reader", threadId, "e mais uma");
      expect(await unread("contributor")).toBe(1);
      expect((await view(h, "contributor", t.ticket)).body.unread).toBe(1);
    });

    it("marcar como lido até um cursor lê só até ali; nunca recua; sem chat devolve zeros", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      expect((await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), {})).body).toEqual({ lastRead: null, unread: 0 });
      const first = await send(h, "contributor", t.ticket, "um");
      await send(h, "contributor", t.ticket, "dois");
      const upTo = first.body.reply.cursor as string;
      const half = await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), { upTo });
      expect(half.body).toEqual({ lastRead: upTo, unread: 1 });
      const back = await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), { upTo: first.body.message.cursor });
      expect(back.body.lastRead).toBe(upTo);
    });

    it("o cursor é opaco: nada de número global, e cursor adulterado é 400 invalid_cursor", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const one = await send(h, "contributor", t.ticket, "um");
      const two = await send(h, "contributor", t.ticket, "dois");
      const cursors = [one.body.message.cursor, one.body.reply.cursor, two.body.message.cursor];
      for (const c of cursors) expect(c).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      expect(JSON.stringify(one.body)).not.toMatch(/"seq"|"lastSeq"|"lastReadSeq"/);
      expect((await view(h, "contributor", t.ticket, "?before=123")).status).toBe(400);
      expect(errorCode(await view(h, "contributor", t.ticket, `?before=${(cursors[0][0] === "A" ? "B" : "A") + cursors[0].slice(1)}`))).toBe("invalid_cursor");
      expect(errorCode(await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), { upTo: "x".repeat(22) }))).toBe("invalid_cursor");
    });

    it("marcar como lido nunca passa do mais novo que a pessoa pode ler: mensagem que chega depois continua não lida", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const first = await send(h, "contributor", t.ticket, "um");
      const ahead = encodeChatCursor(CLERK_KEY, "org_A", 9_000_000_000_000n);
      const read = await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), { upTo: ahead });
      expect(read.body.lastRead).toBe(first.body.reply.cursor);
      const started = await send(h, "reader", t.ticket, "olha", [people().contributor]);
      expect(started.status).toBe(201);
      expect(((await h.call("GET", "/api/chats", as("contributor"))).body.items[0].unread)).toBe(1);
    });

    it("ordena pela última atividade, a mais recente primeiro", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const other = (await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,20,'Outro',$2) returning id", [h.world().projects.priv, people().manager])).rows[0]!.id;
      await send(h, "manager", t.ticket, "um");
      await send(h, "manager", other, "dois");
      expect(((await h.call("GET", "/api/chats", as("manager"))).body.items as { ticketId: string }[]).map((i) => i.ticketId)).toEqual([other, t.ticket]);
      await send(h, "manager", t.ticket, "três");
      expect(((await h.call("GET", "/api/chats", as("manager"))).body.items as { ticketId: string }[]).map((i) => i.ticketId)).toEqual([t.ticket, other]);
    });
  });

  describe("limpar e paginar (regra 7)", () => {
    it("limpar apaga a conversa da pessoa com o assistente e preserva as threads; repetir é inócuo", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "apagável");
      const started = await send(h, "contributor", t.ticket, "thread", [people().reader]);
      expect((await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as("contributor"))).status).toBe(204);
      expect((await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as("contributor"))).status).toBe(204);
      expect((await view(h, "contributor", t.ticket)).body.messages.items).toEqual([]);
      expect((await view(h, "reader", t.ticket)).body.threads[0].id).toBe(started.body.thread.id);
      expect((await view(h, "contributor", t.ticket)).body.threads[0].id).toBe(started.body.thread.id);
    });

    it("limpar sem ter chat não falha", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      expect((await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as("reader"))).status).toBe(204);
    });

    it("as mensagens vêm das mais recentes para as mais antigas, com cursor, sem repetir nem pular", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      for (const n of [1, 2, 3]) await send(h, "contributor", t.ticket, `m${n}`); // 6 mensagens (3 pessoa + 3 assistente)
      const seen: string[] = [];
      let url = "?limit=4";
      for (let i = 0; i < 5; i += 1) {
        const page = (await view(h, "contributor", t.ticket, url)).body.messages;
        seen.push(...page.items.map((m: { cursor: string }) => m.cursor));
        if (page.nextBefore === null) break;
        url = `?limit=4&before=${page.nextBefore}`;
      }
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
    });

    it("as respostas de uma thread também paginam", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const started = await send(h, "contributor", t.ticket, "raiz", [people().reader]);
      for (const n of [1, 2, 3]) await reply(h, "reader", started.body.thread.id, `r${n}`);
      const page1 = (await h.call("GET", `/api/chat-threads/${started.body.thread.id}?limit=2`, as("contributor"))).body.replies;
      expect(page1.items.map((m: { body: string }) => m.body)).toEqual(["r3", "r2"]);
      const page2 = (await h.call("GET", `/api/chat-threads/${started.body.thread.id}?limit=2&before=${page1.nextBefore}`, as("contributor"))).body.replies;
      expect(page2.items.map((m: { body: string }) => m.body)).toEqual(["r1"]);
      expect(page2.nextBefore).toBeNull();
    });
  });

  describe("limites (regra 8)", () => {
    it("mensagem vazia, acima de 4.000 caracteres ou com campo desconhecido: 400", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      for (const body of [{ body: "   " }, { body: "a".repeat(4001) }, { body: "oi", extra: 1 }, { body: "oi", mentions: ["não-é-id"] }]) {
        const res = await h.call("POST", `/api/tickets/${t.ticket}/chat/messages`, as("contributor"), body);
        expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect((await send(h, "contributor", t.ticket, "a".repeat(4000))).status).toBe(201);
      expect(h.chat().calls).toHaveLength(1);
    });

    it("limite de mensagens ao assistente por pessoa por minuto: a seguinte é 429 chat_rate_limited, sem chamar o provedor; outra pessoa e as threads não são afetadas", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      for (let i = 0; i < CHAT_ASSISTANT_PER_PERSON_PER_MINUTE; i += 1) expect((await send(h, "contributor", t.ticket, `m${i}`)).status).toBe(201);
      const calls = h.chat().calls.length;
      const blocked = await send(h, "contributor", t.ticket, "demais");
      expect(blocked.status).toBe(429);
      expect(errorCode(blocked)).toBe("chat_rate_limited");
      expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(h.chat().calls).toHaveLength(calls);
      expect((await send(h, "contributor", t.ticket, "thread", [people().reader])).status).toBe(201);
      expect((await send(h, "reader", t.ticket, "outra pessoa")).status).toBe(201);
    });

    it("uma thread aceita no máximo 25 participantes", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const started = await send(h, "contributor", t.ticket, "raiz", [people().reader]);
      // Semeia participantes até o teto, direto no banco (pessoas que enxergam: projeto privado, então com papel).
      for (let i = 0; i < 23; i += 1) {
        const id = (await h.pool.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_A',$1,'X',$2,'admin') returning id", [`u_extra${i}`, `x${i}@x.test`])).rows[0]!.id;
        await h.pool.query("insert into ticket_chat_thread_members (org_id, thread_id, person_id, project_id, ticket_id) values ('org_A',$1,$2,$3,$4)", [started.body.thread.id, id, h.world().projects.priv, t.ticket]);
      }
      const res = await reply(h, "reader", started.body.thread.id, "mais um", [people().manager]);
      expect(res.status).toBe(422);
      expect(errorCode(res)).toBe("thread_full");
    });
  });

  describe("concorrência", () => {
    it("a conversa mudou durante a chamada ao provedor: 409 chat_changed e nada é gravado dessa troca", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "um");
      h.chat().onCall = async () => {
        const chat = (await h.pool.query<{ id: string }>("select id from ticket_chats where person_id = $1", [people().contributor])).rows[0]!.id;
        await h.pool.query("insert into ticket_chat_messages (org_id, project_id, ticket_id, chat_id, author_person_id, body) values ('org_A',$1,$2,$3,$4,'de outro aparelho')", [h.world().projects.priv, t.ticket, chat, people().contributor]);
      };
      const res = await send(h, "contributor", t.ticket, "dois");
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe("chat_changed");
      expect((await rows("select count(*)::int as n from ticket_chat_messages where body = 'dois'"))[0].n).toBe(0);
    });

    it("perdeu o acesso durante a chamada ao provedor: a escrita confere de novo e responde 404, sem gravar", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      h.chat().onCall = async () => {
        await h.pool.query("delete from project_memberships where person_id = $1", [people().contributor]);
      };
      const res = await send(h, "contributor", t.ticket, "oi");
      expect(res.status).toBe(404);
      expect((await rows("select count(*)::int as n from ticket_chat_messages"))[0].n).toBe(0);
    });
  });

  describe("regra 9: o chat não é estrutura nem resumo do ticket", () => {
    it("nenhuma operação do chat grava atividade, mexe na versão do projeto ou no ticket", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const snap = async () => (await h.pool.query("select (select count(*) from activity_events)::int as events, (select tickets_version from projects where id = $1)::int as version, (select max(updated_at) from tickets)::text as touched", [h.world().projects.priv])).rows[0];
      const before = await snap();
      await send(h, "contributor", t.ticket, "oi");
      const started = await send(h, "contributor", t.ticket, "thread", [people().reader]);
      await reply(h, "reader", started.body.thread.id, "ok", [people().manager]);
      await h.call("POST", `/api/tickets/${t.ticket}/chat/read`, as("contributor"), {});
      await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as("contributor"));
      expect(await snap()).toEqual(before);
    });
  });

  describe("Revisão 1", () => {
    it("quem perdeu o acesso ainda apaga a própria conversa com o assistente, sem ler nada", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "reader", t.ticket, "minha conversa");
      await h.pool.query("delete from project_memberships where person_id = $1", [people().reader]);
      expect((await view(h, "reader", t.ticket)).status).toBe(404);
      expect((await h.call("DELETE", `/api/tickets/${t.ticket}/chat/messages`, as("reader"))).status).toBe(204);
      expect((await rows("select count(*)::int as n from ticket_chat_messages where chat_id is not null"))[0].n).toBe(0);
    });

    it("mensagens de thread têm limite por pessoa por minuto, separado do limite do assistente", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const started = await send(h, "contributor", t.ticket, "raiz", [people().reader]);
      for (let i = 1; i < CHAT_THREAD_PER_PERSON_PER_MINUTE; i += 1) expect((await reply(h, "contributor", started.body.thread.id, `r${i}`)).status).toBe(201);
      const blocked = await reply(h, "contributor", started.body.thread.id, "demais");
      expect(blocked.status).toBe(429);
      expect(errorCode(blocked)).toBe("chat_thread_rate_limited");
      expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(errorCode(await send(h, "contributor", t.ticket, "nova thread", [people().reader]))).toBe("chat_thread_rate_limited");
      expect((await send(h, "contributor", t.ticket, "ao assistente")).status).toBe(201);
      expect((await reply(h, "reader", started.body.thread.id, "outra pessoa")).status).toBe(201);
    });

    it("a vez do assistente é reservada ANTES de chamar o provedor: requisições paralelas gastam uma chamada só", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      h.chat().onCall = () => new Promise((resolve) => setTimeout(resolve, 300));
      const results = await Promise.all([1, 2, 3, 4].map((n) => send(h, "contributor", t.ticket, `p${n}`)));
      expect(h.chat().calls).toHaveLength(1);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(409);
        expect(errorCode(r)).toBe("chat_busy");
      }
    });

    it("a reserva é solta quando o provedor falha e depois de gravar; outra pessoa não é barrada", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      h.chat().fail = true;
      expect((await send(h, "contributor", t.ticket, "falha")).status).toBe(503);
      h.chat().fail = false;
      expect((await send(h, "contributor", t.ticket, "de novo")).status).toBe(201);
      expect((await send(h, "contributor", t.ticket, "e outra")).status).toBe(201);
    });

    it("a reserva esquecida (processo caiu) vence sozinha", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      await send(h, "contributor", t.ticket, "um");
      await h.pool.query("update ticket_chats set turn_started_at = now() - interval '10 minutes'");
      expect((await send(h, "contributor", t.ticket, "dois")).status).toBe(201);
      await h.pool.query("update ticket_chats set turn_started_at = now()");
      expect(errorCode(await send(h, "contributor", t.ticket, "três"))).toBe("chat_busy");
    });

    it.each([["byte NUL", "oi\u0000tchau"], ["controle", "oi\u0001"], ["delete", "oi\u007f"], ["substituto solto", "oi\ud800"]])("corpo com %s: 400 antes de qualquer provedor, em todos os caminhos", async (_n, body) => {
      const t = await seedChatTickets(h.pool, h.world());
      const started = await send(h, "contributor", t.ticket, "raiz", [people().reader]);
      expect((await send(h, "contributor", t.ticket, body)).status).toBe(400);
      expect((await send(h, "contributor", t.ticket, body, [people().reader])).status).toBe(400);
      expect((await reply(h, "reader", started.body.thread.id, body)).status).toBe(400);
      expect(h.chat().calls).toHaveLength(0);
    });

    it("tabulação, quebra de linha e acentos continuam valendo", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      expect((await send(h, "contributor", t.ticket, "linha 1\n\tlinha 2 ação 😀")).status).toBe(201);
    });

    it("nenhum caminho de erro põe o corpo da mensagem em log", async () => {
      const t = await seedChatTickets(h.pool, h.world());
      const secret = "CORPO-SECRETO-NAO-LOGAR-9921";
      const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => vi.spyOn(Logger.prototype, m));
      const out = vi.spyOn(process.stdout, "write");
      const err = vi.spyOn(process.stderr, "write");
      h.chat().fail = true;
      await send(h, "contributor", t.ticket, secret); // 503
      h.chat().fail = false;
      await send(h, "contributor", t.ticket, `${secret}\u0000`); // 400
      await send(h, "contributor", t.ticket, secret, [randomUUID()]); // 422
      await send(h, "plain", t.ticket, secret); // 404
      await send(h, "contributor", t.ticket, secret); // 201
      const logged = [...spies.flatMap((s) => s.mock.calls), ...out.mock.calls, ...err.mock.calls].map((c) => JSON.stringify(c)).join("\n");
      for (const s of [...spies, out, err]) s.mockRestore();
      expect(logged).not.toContain(secret);
    });
  });
});

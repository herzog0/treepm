import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG, openApiTransactions } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const priv = () => h.world().projects.priv;

const open = (who: Who | "outsider", message = "Quero corrigir o login", projectId = priv()) =>
  h.call("POST", `/api/projects/${projectId}/ticket-conversations`, as(who), { message });
const send = (who: Who | "outsider", id: string, message = "Mais um detalhe") =>
  h.call("POST", `/api/ticket-conversations/${id}/messages`, as(who), { message });
const get = (who: Who | "outsider", id: string) => h.call("GET", `/api/ticket-conversations/${id}`, as(who));
const patch = (who: Who | "outsider", id: string, body: unknown = { title: "Meu título", description: "Minha descrição" }) =>
  h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as(who), body);
const del = (who: Who | "outsider", id: string) => h.call("DELETE", `/api/ticket-conversations/${id}`, as(who));
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

afterEach(() => vi.restoreAllMocks());

describe("POST /projects/:id/ticket-conversations", () => {
  it("abre a conversa, devolve o primeiro turno e guarda mensagens e rascunho", async () => {
    const res = await open("contributor");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      projectId: priv(),
      status: "open",
      createdTicketId: null,
      draft: { title: "Rascunho 1", description: "Quero corrigir o login" },
      ready: false,
      messages: [
        { author: "person", body: "Quero corrigir o login", model: null },
        { author: "assistant", body: expect.stringContaining("Entendi"), model: "claude-opus-5-5" },
      ],
    });
    expect(h.conversation().calls).toEqual([
      { history: [{ author: "person", body: "Quero corrigir o login" }], draft: null, groups: [] },
    ]);
    const stored = await rows("select status, author_person_id, draft_title from ticket_conversations");
    expect(stored).toEqual([{ status: "open", author_person_id: h.world().people.contributor, draft_title: "Rascunho 1" }]);
    expect((await rows("select position, author from ticket_conversation_messages order by position")).map((m) => m.author)).toEqual(["person", "assistant"]);
  });

  it("administrador da organização e gestor também abrem", async () => {
    expect((await open("admin")).status).toBe(201);
    expect((await open("manager")).status).toBe(201);
  });

  it("não há transação aberta enquanto o provedor responde", async () => {
    let during = -1;
    h.conversation().onCall = async () => {
      during = await openApiTransactions(h.pool);
    };
    expect((await open("contributor")).status).toBe(201);
    expect(during).toBe(0);
  });

  it.each([
    ["vazia", ""],
    ["só espaços", "   "],
    ["com 4001 caracteres", "x".repeat(4001)],
  ])("mensagem %s: 400 e o provedor não é chamado", async (_n, message) => {
    const res = await open("contributor", message);
    expect(res.status).toBe(400);
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("aceita exatamente 4000 caracteres e rejeita campos desconhecidos", async () => {
    expect((await open("contributor", "x".repeat(4000))).status).toBe(201);
    const extra = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "a", projectId: "x" });
    expect(extra.status).toBe(400);
  });

  it("provedor indisponível: 503 assistant_unavailable e nada é gravado", async () => {
    h.conversation().fail = true;
    const res = await open("contributor");
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_unavailable");
    expect(await count("ticket_conversations")).toBe(0);
  });

  it("leitor do projeto não abre conversa (403) e o provedor não é chamado", async () => {
    const res = await open("reader");
    expect(res.status).toBe(403);
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("projeto que a pessoa não vê, de outra organização ou inexistente: 404", async () => {
    expect((await open("plain")).status).toBe(404);
    expect((await open("outsider", "oi", priv())).status).toBe(404);
    expect((await open("admin", "oi", h.world().other.project)).status).toBe(404);
    expect((await open("admin", "oi", UNKNOWN_ID)).status).toBe(404);
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("projeto arquivado: 409 project_archived antes de chamar o provedor", async () => {
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    const res = await open("contributor");
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("project_archived");
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("a escrita confere de novo: projeto arquivado durante a chamada ao provedor", async () => {
    h.conversation().onCall = async () => void (await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]));
    const res = await open("contributor");
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("project_archived");
    expect(await count("ticket_conversations")).toBe(0);
  });

  it("a escrita confere de novo: papel rebaixado a leitor durante a chamada (403)", async () => {
    h.conversation().onCall = async () =>
      void (await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]));
    expect((await open("contributor")).status).toBe(403);
    expect(await count("ticket_conversations")).toBe(0);
  });

  it("a escrita confere de novo: perdeu a visão do projeto durante a chamada (404)", async () => {
    h.conversation().onCall = async () =>
      void (await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]));
    expect((await open("contributor")).status).toBe(404);
    expect(await count("ticket_conversations")).toBe(0);
  });
});

describe("POST /ticket-conversations/:id/messages", () => {
  const start = async (who: Who = "contributor") => (await open(who)).body.id as string;

  it("acrescenta a mensagem e a resposta, com o histórico inteiro e o rascunho atual para a IA", async () => {
    const id = await start();
    const res = await send("contributor", id, "Segunda mensagem");
    expect(res.status).toBe(201);
    expect(res.body.messages.map((m: { author: string }) => m.author)).toEqual(["person", "assistant", "person", "assistant"]);
    expect(res.body.draft.title).toBe("Rascunho 2");
    expect(res.body.ready).toBe(true);
    const call = h.conversation().calls[1];
    expect(call?.history.map((m) => m.body)).toEqual(["Quero corrigir o login", expect.stringContaining("Entendi"), "Segunda mensagem"]);
    expect(call?.draft).toEqual({ title: "Rascunho 1", description: "Quero corrigir o login" });
    expect((await rows("select position from ticket_conversation_messages order by position")).map((r) => r.position)).toEqual([1, 2, 3, 4]);
  });

  it("quando a IA devolve rascunho nulo, o rascunho anterior (inclusive o editado à mão) permanece", async () => {
    const id = await start();
    await patch("contributor", id, { title: "Editado", description: "à mão" });
    h.conversation().reply = () => ({ message: "Mais uma pergunta", draft: null, ready: false, model: "claude-opus-5-5" });
    const res = await send("contributor", id);
    expect(res.body.draft).toEqual({ title: "Editado", description: "à mão" });
  });

  it("503 assistant_unavailable não grava a mensagem nova", async () => {
    const id = await start();
    h.conversation().fail = true;
    const res = await send("contributor", id);
    expect(res.status).toBe(503);
    expect(await count("ticket_conversation_messages")).toBe(2);
  });

  it.each([["vazia", ""], ["com 4001 caracteres", "x".repeat(4001)]])("mensagem %s: 400", async (_n, message) => {
    const id = await start();
    expect((await send("contributor", id, message)).status).toBe(400);
  });

  it("conversa fechada: 409 conversation_closed e o provedor não é chamado", async () => {
    const id = await start();
    await h.pool.query("update ticket_conversations set status = 'ticket_created' where id = $1", [id]);
    h.conversation().calls.length = 0;
    const res = await send("contributor", id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("conversation_closed");
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("a escrita confere de novo: conversa fechada durante a chamada (409)", async () => {
    const id = await start();
    h.conversation().onCall = async () => void (await h.pool.query("update ticket_conversations set status = 'ticket_created' where id = $1", [id]));
    const res = await send("contributor", id);
    expect(errorOf(res)).toBe("conversation_closed");
    expect(await count("ticket_conversation_messages")).toBe(2);
  });

  it("a escrita confere de novo: conversa apagada durante a chamada (404)", async () => {
    const id = await start();
    h.conversation().onCall = async () => void (await h.pool.query("delete from ticket_conversations where id = $1", [id]));
    expect((await send("contributor", id)).status).toBe(404);
  });

  it("a escrita confere de novo: outra mensagem entrou durante a chamada (409 conversation_changed)", async () => {
    const id = await start();
    h.conversation().onCall = async () =>
      void (await h.pool.query(
        "insert into ticket_conversation_messages (org_id, conversation_id, position, author, body) values ('org_A', $1, 3, 'person', 'concorrente')",
        [id],
      ));
    const res = await send("contributor", id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("conversation_changed");
  });

  it("a escrita confere de novo: projeto arquivado durante a chamada (409)", async () => {
    const id = await start();
    h.conversation().onCall = async () => void (await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]));
    expect(errorOf(await send("contributor", id))).toBe("project_archived");
  });

  it("projeto arquivado antes da mensagem: 409 project_archived sem chamar o provedor", async () => {
    const id = await start();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    h.conversation().calls.length = 0;
    expect(errorOf(await send("contributor", id))).toBe("project_archived");
    expect(h.conversation().calls).toHaveLength(0);
  });

  it("papel rebaixado a leitor: 403 sem chamar o provedor", async () => {
    const id = await start();
    await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]);
    h.conversation().calls.length = 0;
    expect((await send("contributor", id)).status).toBe(403);
    expect(h.conversation().calls).toHaveLength(0);
  });
});

describe("privacidade: só a autora lê, continua e apaga", () => {
  const start = async () => (await open("contributor")).body.id as string;

  it.each(["admin", "manager", "teamAdmin", "reader", "plain"] as const)("%s não lê, não continua, não edita e não apaga a conversa alheia (404)", async (who) => {
    const id = await start();
    h.conversation().calls.length = 0;
    expect((await get(who, id)).status).toBe(404);
    expect((await send(who, id)).status).toBe(404);
    expect((await patch(who, id)).status).toBe(404);
    expect((await del(who, id)).status).toBe(404);
    expect(h.conversation().calls).toHaveLength(0);
    expect(await count("ticket_conversations")).toBe(1);
  });

  it("outra organização não enxerga nada", async () => {
    const id = await start();
    const other = as("outsider", "org_B");
    expect((await h.call("GET", `/api/ticket-conversations/${id}`, other)).status).toBe(404);
    expect((await h.call("POST", `/api/ticket-conversations/${id}/messages`, other, { message: "oi" })).status).toBe(404);
    expect((await h.call("DELETE", `/api/ticket-conversations/${id}`, other)).status).toBe(404);
    expect((await h.call("GET", `/api/ticket-conversations?projectId=${priv()}`, other)).status).toBe(404);
  });

  it("a lista traz só as conversas da própria pessoa, a mais recente primeiro", async () => {
    const first = await start();
    await open("manager");
    const second = (await open("contributor", "Outra")).body.id as string;
    const mine = await h.call("GET", `/api/ticket-conversations?projectId=${priv()}`, as("contributor"));
    expect(mine.status).toBe(200);
    expect(mine.body.map((c: { id: string }) => c.id)).toEqual([second, first]);
    expect(mine.body[0]).toMatchObject({ projectId: priv(), status: "open", draft: { title: expect.any(String) } });
    expect(mine.body[0]).not.toHaveProperty("messages");
    const admin = await h.call("GET", `/api/ticket-conversations?projectId=${priv()}`, as("admin"));
    expect(admin.body).toEqual([]);
  });

  it("a lista exige projectId válido e projeto visível", async () => {
    expect((await h.call("GET", "/api/ticket-conversations", as("contributor"))).status).toBe(400);
    expect((await h.call("GET", "/api/ticket-conversations?projectId=abc", as("contributor"))).status).toBe(400);
    expect((await h.call("GET", `/api/ticket-conversations?projectId=${UNKNOWN_ID}`, as("contributor"))).status).toBe(404);
  });

  it("depois de deixar de ver o projeto, tudo responde 404 (e a lista também)", async () => {
    const id = await start();
    await h.pool.query("delete from project_memberships where person_id = $1", [h.world().people.contributor]);
    h.conversation().calls.length = 0;
    expect((await get("contributor", id)).status).toBe(404);
    expect((await send("contributor", id)).status).toBe(404);
    expect((await patch("contributor", id)).status).toBe(404);
    expect((await del("contributor", id)).status).toBe(404);
    expect((await h.call("GET", `/api/ticket-conversations?projectId=${priv()}`, as("contributor"))).status).toBe(404);
    expect(h.conversation().calls).toHaveLength(0);
    expect(await count("ticket_conversations")).toBe(1);
  });

  it("a autora rebaixada a leitora ainda lê a conversa, mas não continua nem edita (403)", async () => {
    const id = await start();
    await h.pool.query("update project_memberships set role = 'reader' where person_id = $1", [h.world().people.contributor]);
    expect((await get("contributor", id)).status).toBe(200);
    expect((await send("contributor", id)).status).toBe(403);
    expect((await patch("contributor", id)).status).toBe(403);
    expect((await del("contributor", id)).status).toBe(204);
  });

  it("projeto arquivado: lê e apaga, mas não edita o rascunho (409)", async () => {
    const id = await start();
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await get("contributor", id)).status).toBe(200);
    expect(errorOf(await patch("contributor", id))).toBe("project_archived");
    expect((await del("contributor", id)).status).toBe(204);
  });
});

describe("PATCH /ticket-conversations/:id/draft", () => {
  const start = async () => (await open("contributor")).body.id as string;

  it("a pessoa ajusta o rascunho sem chamar a IA", async () => {
    const id = await start();
    h.conversation().calls.length = 0;
    const res = await patch("contributor", id, { title: "  Título novo  ", description: "Descrição nova" });
    expect(res.status).toBe(200);
    expect(res.body.draft).toEqual({ title: "Título novo", description: "Descrição nova" });
    expect(h.conversation().calls).toHaveLength(0);
    expect((await rows("select draft_title from ticket_conversations"))[0].draft_title).toBe("Título novo");
  });

  it.each([
    ["título vazio", { title: " ", description: "" }],
    ["título com 201 caracteres", { title: "x".repeat(201), description: "" }],
    ["descrição com 20001 caracteres", { title: "t", description: "x".repeat(20_001) }],
    ["campo desconhecido", { title: "t", description: "", status: "done" }],
    ["sem título", { description: "d" }],
  ])("%s: 400", async (_n, body) => {
    expect((await patch("contributor", await start(), body)).status).toBe(400);
  });

  it("aceita os limites exatos e descrição omitida vira vazia", async () => {
    const id = await start();
    expect((await patch("contributor", id, { title: "x".repeat(200), description: "y".repeat(20_000) })).status).toBe(200);
    expect((await patch("contributor", id, { title: "t" })).body.draft).toEqual({ title: "t", description: "" });
  });

  it("conversa fechada: 409 conversation_closed", async () => {
    const id = await start();
    await h.pool.query("update ticket_conversations set status = 'ticket_created' where id = $1", [id]);
    expect(errorOf(await patch("contributor", id))).toBe("conversation_closed");
  });
});

describe("GET e DELETE", () => {
  it("o detalhe traz as mensagens em ordem e o apagamento leva as mensagens, mas não o ticket criado", async () => {
    const id = (await open("contributor")).body.id as string;
    await send("contributor", id);
    const detail = await get("contributor", id);
    expect(detail.body.messages).toHaveLength(4);
    expect(detail.body.messages.map((m: { author: string }) => m.author)).toEqual(["person", "assistant", "person", "assistant"]);
    const ticket = await h.pool.query(
      "insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A', $1, 1, 'T', $2) returning id",
      [priv(), h.world().people.contributor],
    );
    await h.pool.query("update ticket_conversations set created_ticket_id = $2, status = 'ticket_created' where id = $1", [id, ticket.rows[0].id]);
    expect((await del("contributor", id)).status).toBe(204);
    expect(await count("ticket_conversations")).toBe(0);
    expect(await count("ticket_conversation_messages")).toBe(0);
    expect(await count("tickets")).toBe(1);
    expect((await get("contributor", id)).status).toBe(404);
  });

  it("id inválido: 400; inexistente: 404", async () => {
    expect((await get("contributor", "abc")).status).toBe(400);
    expect((await get("contributor", UNKNOWN_ID)).status).toBe(404);
  });
});

describe("registro", () => {
  it("nenhum registro da API contém o texto da pessoa nem o da IA", async () => {
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) => vi.spyOn(Logger.prototype, m));
    h.conversation().fail = false;
    const id = (await open("contributor", "SEGREDO-DA-PESSOA-123")).body.id as string;
    await send("contributor", id, "OUTRO-SEGREDO-456");
    h.conversation().fail = true;
    await send("contributor", id, "TERCEIRO-SEGREDO-789");
    const logged = spies.flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call)).join("\n");
    expect(logged).not.toMatch(/SEGREDO/);
    expect(logged).not.toContain("Entendi");
  });
});

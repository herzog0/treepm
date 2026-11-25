/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona corpos brutos de requisição e resposta */
import { describe, expect, it } from "vitest";
import { ClaudeChatProvider } from "../src/assistant/claude-chat-provider.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { CREATION_OPENED_PREFIX, CREATION_OPENED_REPLY } from "../src/assistant/prompts.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { actAs, createTestPerson, snapshot } from "./act-as-support.js";
import { seedTree } from "./assistant-tree.js";
import { errorCode, openGeneral, openTicket, post, seedChatTickets, view } from "./chat-support.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0056, fatia 3 (TREEPM-399): criação de ticket como subthread. O assistente nunca cria sozinho; a conversa de novo ticket vive dentro da thread.
describe("thread de criação de ticket", () => {
  const h = useHarness(AI_CONFIG);
  const w = () => h.world();
  const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
  const direct = (who: Who, conversation: string, body: string, extra: Record<string, unknown> = {}) =>
    h.call("POST", `/api/conversations/${conversation}/messages`, as(who), { body, creation: true, ...extra });
  const tree = async (who: Who) => (await h.call("GET", "/api/conversations", as(who))).body.items as any[];
  const threadsOf = (items: any[]): any[] => items.flatMap((n) => [n, ...threadsOf(n.children)]).filter((n) => n.kind === "thread");
  const tcCall = (method: string, path: string, who: Who, body?: unknown) => h.call(method, `/api/ticket-conversations/${path}`, as(who), body);

  it("pelo assistente, no Meu chat, do rascunho ao ticket: a thread sai da árvore, o cartão diz criado e a conversa do ticket recebe a cópia uma vez só", async () => {
    const t = await seedTree(h.pool, w());
    const general = await openGeneral(h, "contributor");
    h.chat().draft_ = () => "Migrar o login para SSO";
    const res = await post(h, "contributor", general, "Cria um ticket para migrar o login");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "creation", reply: { authorKind: "assistant", body: CREATION_OPENED_REPLY, marker: "creation_opened" }, message: { body: "Cria um ticket para migrar o login" } });
    // O provedor viu o pedido do modelo; a conversa guarda o que a pessoa escreveu (a citação é dela).
    expect(h.conversation().calls[0]!.history).toEqual([{ author: "person", body: "Migrar o login para SSO" }]);
    const tcId = res.body.ticketConversationId as string;
    expect((await rows("select author, body from ticket_conversation_messages where conversation_id = $1 order by position", [tcId]))[0]).toMatchObject({ author: "person", body: "Cria um ticket para migrar o login" });
    expect(res.body.thread).toMatchObject({ purpose: "creation", title: "Rascunho 1", creation: { ticketConversationId: tcId, projectId: w().projects.priv, projectKey: "PRIV", state: "draft", openedBy: "assistant", ticket: null } });
    const open = threadsOf(await tree("contributor"));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ purpose: "creation", title: "Rascunho 1", creation: { state: "draft" } });
    // Dentro da thread só há a abertura: o conteúdo é a conversa de novo ticket.
    const inside = await view(h, "contributor", res.body.thread.id);
    expect(inside.body.messages.items.map((m: any) => m.body)).toEqual(["Cria um ticket para migrar o login"]);
    // O pedido que o assistente passou à ferramenta fica na resposta fixa, depois do marcador com a thread.
    expect((await rows("select body from conversation_messages where conversation_id = $1 and author_person_id is null", [general]))[0].body).toBe(`${CREATION_OPENED_PREFIX}${res.body.thread.id}]\nMigrar o login para SSO`);
    expect(inside.body.conversation).toMatchObject({ purpose: "creation", canAddParticipants: false, canOpenThread: false, creation: { state: "draft" } });

    // As rotas da conversa de novo ticket seguem sozinhas: a segunda mensagem deixa o rascunho pronto, e a thread passa a esperar a pessoa.
    expect((await tcCall("POST", `${tcId}/messages`, "contributor", { message: "Mais detalhes" })).status).toBe(201);
    expect(threadsOf(await tree("contributor"))[0].creation.state).toBe("waiting");
    h.judge().verdict = (input) => ({ belongs: input.current ? 0.95 : 0.1, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, i === 0 ? 0.2 : 0.8])) });
    const asked = await tcCall("POST", `${tcId}/placement`, "contributor", {});
    expect(asked.body.question).toMatchObject({ kind: "root" });
    const created = await tcCall("POST", `${tcId}/ticket`, "contributor", { parentId: t.billing, placedBy: "option" });
    expect(created.status).toBe(201);

    expect(threadsOf(await tree("contributor"))).toHaveLength(0);
    const card = (await view(h, "contributor", general)).body.messages.items.find((m: any) => m.thread)?.thread;
    expect(card.creation).toMatchObject({ state: "created", ticket: { id: created.body.ticket.id, key: "PRIV-8", title: "Rascunho 2" } });
    const copy = async () => rows("select author_person_id, body, model, created_at from conversation_messages where conversation_id = (select id from conversations where kind = 'ticket' and ticket_id = $1 and owner_person_id = $2) order by seq", [created.body.ticket.id, w().people.contributor]);
    const original = await rows("select author, body, created_at from ticket_conversation_messages where conversation_id = $1 order by position", [tcId]);
    const first = await copy();
    expect(first.map((r) => [r.author_person_id === null ? "assistant" : "person", r.body, r.created_at.getTime()])).toEqual(original.map((r) => [r.author, r.body, r.created_at.getTime()]));
    expect((await tcCall("POST", `${tcId}/ticket`, "contributor", { parentId: t.billing, placedBy: "option" })).status).toBe(201);
    expect(await copy()).toHaveLength(original.length);
    // Criada, a conversa não se descarta.
    const gone = await tcCall("DELETE", tcId, "contributor");
    expect([gone.status, errorCode(gone)]).toEqual([409, "creation_created"]);
  });

  it("pelo pedido direto: o provedor do chat não é chamado, não há resposta fixa, e o título é o do rascunho", async () => {
    const general = await openGeneral(h, "contributor");
    const res = await direct("contributor", general, "Preciso de um ticket sobre cobrança");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "creation", reply: null, thread: { creation: { openedBy: "person" } } });
    expect((await view(h, "contributor", res.body.thread.id)).body.messages.items).toHaveLength(1);
    expect(h.chat().calls).toHaveLength(0);
    expect(h.conversation().calls[0]!.history).toEqual([{ author: "person", body: "Preciso de um ticket sobre cobrança" }]);
    expect((await rows("select title from conversations where id = $1", [res.body.thread.id]))[0].title).toBe("Rascunho 1");
  });

  it("do chat de um ticket: o projeto é o dele, a procura começa por ele, e o projeto de outro lugar é recusado", async () => {
    const t = await seedChatTickets(h.pool, w());
    const main = await openTicket(h, "manager", t.ticket);
    const bad = await direct("manager", main, "Novo", { projectId: w().projects.org });
    expect([bad.status, errorCode(bad)]).toEqual([422, "project_mismatch"]);
    const res = await direct("manager", main, "Um ticket irmão deste");
    expect(res.status).toBe(201);
    expect(res.body.thread.creation.projectKey).toBe("PRIV");
    expect((await rows("select ticket_id from conversations where id = $1", [res.body.thread.id]))[0].ticket_id).toBe(t.ticket);
    const tcId = res.body.ticketConversationId as string;
    h.judge().calls.length = 0;
    expect((await tcCall("POST", `${tcId}/placement`, "manager", {})).status).toBe(201);
    expect(h.judge().calls[0]?.scope).toBeTruthy(); // começa pelo ticket de origem
    h.judge().calls.length = 0;
    await tcCall("POST", `${tcId}/placement`, "manager", { scopeId: null });
    expect(h.judge().calls[0]?.scope).toBeUndefined(); // `scopeId: null` continua sendo o projeto inteiro
  });

  it("de uma thread de assunto: a thread de criação nasce sob a principal", async () => {
    const general = await openGeneral(h, "manager");
    const topic = (await h.call("POST", `/api/conversations/${general}/messages`, as("manager"), { body: "Assunto", topic: true })).body.thread.id as string;
    h.chat().draft_ = () => "Pedido";
    const res = await post(h, "manager", topic, "Cria um ticket", undefined);
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("creation");
    expect((await rows("select parent_id from conversations where id = $1", [res.body.thread.id]))[0].parent_id).toBe(general);
    expect((await rows("select body from conversation_messages where conversation_id = $1 and author_person_id is null order by seq", [topic])).map((r) => r.body)).toContain(`${CREATION_OPENED_PREFIX}${res.body.thread.id}]\nPedido`);
  });

  it("projeto: um só possível, vários (project_required), explícito inválido (project_unavailable)", async () => {
    const generalAdmin = await openGeneral(h, "admin");
    const needs = await direct("admin", generalAdmin, "Um ticket");
    expect([needs.status, errorCode(needs)]).toEqual([422, "project_required"]);
    const first = await direct("admin", generalAdmin, "Um ticket", { projectId: w().projects.org });
    expect(first.status).toBe(201);
    expect((await tcCall("DELETE", first.body.ticketConversationId, "admin")).status).toBe(204);
    const generalReader = await openGeneral(h, "reader");
    for (const projectId of [w().projects.priv, w().projects.org, undefined]) {
      const res = await direct("reader", generalReader, "Um ticket", projectId ? { projectId } : {});
      expect([res.status, errorCode(res)]).toEqual([422, "project_unavailable"]);
    }
    const generalPlain = await openGeneral(h, "plain");
    const hidden = await direct("plain", generalPlain, "Um ticket", { projectId: w().projects.priv });
    expect([hidden.status, errorCode(hidden)]).toEqual([422, "project_unavailable"]);
    // No caminho do assistente: vários projetos e nenhum dito → a ferramenta vem bloqueada e nada abre; projeto explícito inválido é 422 antes do provedor.
    h.chat().draft_ = () => "Pedido";
    h.chat().calls.length = 0;
    const blocked = await post(h, "admin", generalAdmin, "Cria um ticket");
    expect(blocked.body.kind).toBe("assistant");
    expect(blocked.body.reply.body).toContain("mais de um projeto");
    expect(h.chat().calls[0]!.draftTool).toEqual({ kind: "blocked", reason: "project_required" });
    // Mensagem comum com `projectId` que não serve (a tela manda sempre o projeto aberto): é respondida, só sem a ferramenta.
    const bad = await h.call("POST", `/api/conversations/${generalReader}/messages`, as("reader"), { body: "Oi", projectId: w().projects.priv });
    expect(bad.status).toBe(201);
    expect(bad.body.kind).toBe("assistant");
    expect(h.chat().calls).toHaveLength(2);
    expect(h.chat().calls[1]!.draftTool).toBeNull();
    const nowhere = await h.call("POST", `/api/conversations/${generalAdmin}/messages`, as("admin"), { body: "Oi", projectId: "00000000-0000-4000-8000-000000000000" });
    expect([nowhere.status, nowhere.body.kind]).toEqual([201, "assistant"]);
    expect(h.chat().calls[2]!.draftTool).toBeNull();
    const chosen = await h.call("POST", `/api/conversations/${generalAdmin}/messages`, as("admin"), { body: "Cria um ticket", projectId: w().projects.priv });
    expect(chosen.body.kind).toBe("creation");
  });

  it("no máximo um rascunho aberto por vez pelo assistente: o segundo pedido volta ao modelo como motivo, sem abrir nada", async () => {
    const general = await openGeneral(h, "contributor");
    h.chat().draft_ = () => "Primeiro";
    expect((await post(h, "contributor", general, "Cria um")).body.kind).toBe("creation");
    const second = await post(h, "contributor", general, "Cria outro");
    expect(second.body.kind).toBe("assistant");
    expect(second.body.reply.body).toContain("rascunho");
    expect(h.chat().calls.at(-1)!.draftTool).toEqual({ kind: "blocked", reason: "draft_open" });
    expect(threadsOf(await tree("contributor"))).toHaveLength(1);
  });

  it("rascunho fechado pela pessoa: escrever nele pelas rotas do rascunho reabre a thread (e só a dela)", async () => {
    const general = await openGeneral(h, "contributor");
    const made = await direct("contributor", general, "Um ticket");
    const thread = made.body.thread.id as string;
    const tc = made.body.ticketConversationId as string;
    const closed = async () => (await h.call("GET", "/api/conversations/closed", as("contributor"))).body.items.map((n: any) => n.id);
    const closeIt = async () => expect((await h.call("POST", `/api/conversations/${thread}/close`, as("contributor"))).status).toBe(200);
    // Ver (GET) não reabre.
    await closeIt();
    expect((await tcCall("GET", tc, "contributor")).status).toBe(200);
    expect(await closed()).toContain(thread);
    // Escrever no rascunho reabre.
    expect((await tcCall("PATCH", `${tc}/draft`, "contributor", { title: "Outro título", description: "d" })).status).toBe(200);
    expect(await closed()).not.toContain(thread);
    expect(threadsOf(await tree("contributor")).map((n) => n.id)).toContain(thread);
    // Mensagem ao assistente do rascunho também reabre.
    await closeIt();
    expect((await tcCall("POST", `${tc}/messages`, "contributor", { message: "Mais detalhes" })).status).toBe(201);
    expect(await closed()).not.toContain(thread);
  });

  it("rascunho fechado: abrir só para olhar (POST elaboration) não o reabre", async () => {
    const general = await openGeneral(h, "contributor");
    const made = await direct("contributor", general, "Um ticket");
    const thread = made.body.thread.id as string;
    const tc = made.body.ticketConversationId as string;
    const closedMark = async () => (await rows("select closed_seq from conversation_participants where conversation_id = $1 and person_id = $2", [thread, w().people.contributor]))[0].closed_seq;
    expect((await h.call("POST", `/api/conversations/${thread}/close`, as("contributor"))).status).toBe(200);
    expect(await closedMark()).not.toBeNull();
    expect((await tcCall("POST", `${tc}/elaboration`, "contributor")).status).toBe(201);
    expect(await closedMark()).not.toBeNull();
  });

  it("ticket já criado: repetir o pedido (idempotente) não limpa a marca de fechada da thread concluída", async () => {
    const t = await seedTree(h.pool, w());
    const general = await openGeneral(h, "contributor");
    const made = await direct("contributor", general, "Um ticket");
    const thread = made.body.thread.id as string;
    const tc = made.body.ticketConversationId as string;
    expect((await tcCall("POST", `${tc}/messages`, "contributor", { message: "Mais detalhes" })).status).toBe(201);
    expect((await tcCall("POST", `${tc}/ticket`, "contributor", { parentId: t.billing, placedBy: "option" })).status).toBe(201);
    const closedMark = async () => (await rows("select closed_seq from conversation_participants where conversation_id = $1 and person_id = $2", [thread, w().people.contributor]))[0].closed_seq;
    // Fecha a thread concluída direto (é o estado que a pessoa deixou), e a repetição não a reabre.
    await rows("update conversation_participants set closed_seq = 1 where conversation_id = $1 and person_id = $2", [thread, w().people.contributor]);
    expect((await tcCall("POST", `${tc}/ticket`, "contributor", { parentId: t.billing, placedBy: "option" })).status).toBe(201);
    expect(await closedMark()).not.toBeNull();
  });

  it("rascunho fechado: mensagem comum ao assistente NÃO o reabre; só a ferramenta bloqueada por ele reabre", async () => {
    const general = await openGeneral(h, "contributor");
    h.chat().draft_ = () => "Primeiro";
    const first = await post(h, "contributor", general, "Cria um");
    const thread = first.body.thread.id as string;
    expect((await h.call("POST", `/api/conversations/${thread}/close`, as("contributor"))).status).toBe(200);
    const visible = async () => threadsOf(await tree("contributor")).map((n) => n.id);
    expect(await visible()).not.toContain(thread);
    // (a) O modelo não chama a ferramenta: a vez prepara a ferramenta bloqueada, mas nada reabre.
    h.chat().draft_ = null;
    const plain = await post(h, "contributor", general, "Só uma conversa");
    expect(plain.body.kind).toBe("assistant");
    expect(h.chat().calls.at(-1)!.draftTool).toEqual({ kind: "blocked", reason: "draft_open" });
    expect(await visible()).not.toContain(thread);
    // (b) O modelo chama a ferramenta e ela sai bloqueada: o rascunho volta à barra.
    h.chat().draft_ = () => "Outro";
    const second = await post(h, "contributor", general, "Cria outro");
    expect(second.body.kind).toBe("assistant");
    expect(second.body.reply.body).toContain("rascunho");
    expect(await visible()).toContain(thread);
  });

  it("thread com pessoas: criação recusada, e dentro da thread de criação nenhuma mensagem comum entra (creation_thread)", async () => {
    const general = await openGeneral(h, "manager");
    const people = await post(h, "manager", general, "Alice, veja", [w().people.reader]);
    for (const who of ["manager", "reader"] as const) {
      const res = await direct(who, people.body.thread.id, "Um ticket");
      expect([res.status, errorCode(res)]).toEqual([422, "creation_in_thread"]);
    }
    expect(h.conversation().calls).toHaveLength(0);
    // Numa thread com pessoas o assistente não fala: a mensagem é entre pessoas, nada chega ao provedor (nem a lista de ferramentas), e `projectId` é recusado.
    h.chat().calls.length = 0;
    for (const who of ["manager", "reader"] as const) {
      const plain = await post(h, who, people.body.thread.id, "Cria um ticket para isto");
      expect([plain.status, plain.body.kind]).toEqual([201, "message"]);
      const withProject = await h.call("POST", `/api/conversations/${people.body.thread.id}/messages`, as(who), { body: "Oi", projectId: w().projects.priv });
      expect([withProject.status, errorCode(withProject)]).toEqual([422, "project_not_applicable"]);
    }
    expect(h.chat().calls).toHaveLength(0);
    const made = await direct("manager", general, "Um ticket");
    const thread = made.body.thread.id as string;
    for (const extra of [{}, { mentions: [w().people.reader] }, { topic: true }, { creation: true }]) {
      const res = await h.call("POST", `/api/conversations/${thread}/messages`, as("manager"), { body: "Oi", ...extra });
      expect([res.status, errorCode(res)]).toEqual([422, "creation_thread"]);
    }
    const add = await h.call("POST", `/api/conversations/${thread}/participants`, as("manager"), { personIds: [w().people.reader] });
    expect([add.status, errorCode(add)]).toEqual([422, "private_thread"]);
  });

  it("descartar: a thread sai da árvore e o cartão diz descartado, sem elo nem ticket", async () => {
    const general = await openGeneral(h, "contributor");
    const res = await direct("contributor", general, "Um ticket");
    expect((await tcCall("DELETE", res.body.ticketConversationId, "contributor")).status).toBe(204);
    expect(threadsOf(await tree("contributor"))).toHaveLength(0);
    const card = (await view(h, "contributor", general)).body.messages.items.find((m: any) => m.thread)?.thread;
    expect(card.creation).toEqual({ ticketConversationId: null, projectId: null, projectKey: null, state: "discarded", openedBy: "person", ticket: null });
  });

  it("privacidade: ninguém além da dona lê a thread de criação, nem título, nem estado, nem pela árvore; o convidado de outra thread não vê o cartão", async () => {
    const SECRET = "SENTINELA-CRIACAO-5d1";
    const general = await openGeneral(h, "manager");
    const made = await direct("manager", general, SECRET);
    const thread = made.body.thread.id as string;
    const people = await post(h, "manager", general, "Convite", [w().people.reader]);
    for (const who of ["reader", "contributor", "admin"] as const) {
      expect((await view(h, who, thread)).status).toBe(404);
      expect(JSON.stringify((await h.call("GET", "/api/conversations", as(who))).body)).not.toMatch(/Rascunho|SENTINELA|"creation":\{/);
    }
    const guest = await view(h, "reader", people.body.thread.id);
    expect(JSON.stringify(guest.body)).not.toMatch(/Rascunho|SENTINELA|"state"/);
    expect((await h.call("GET", `/api/ticket-conversations/${made.body.ticketConversationId}`, as("reader"))).status).toBe(404);
  });

  it("enumeração: threads de criação de três donas, abertas e descartada; cada pessoa lê SÓ as dela, por rota nenhuma vê título, estado ou cartão das outras", async () => {
    const t = await seedChatTickets(h.pool, w());
    const mainManager = await openTicket(h, "manager", t.ticket);
    const owners = [
      { who: "manager" as const, conversation: mainManager, text: "SENTINELA-A-91c" },
      { who: "contributor" as const, conversation: await openGeneral(h, "contributor"), text: "SENTINELA-B-4e2" },
      { who: "admin" as const, conversation: await openGeneral(h, "admin"), text: "SENTINELA-C-77d" },
    ];
    const made = new Map<Who, { thread: string; tc: string }>();
    for (const o of owners) {
      const res = await direct(o.who, o.conversation, o.text, o.who === "admin" ? { projectId: w().projects.priv } : {});
      expect(res.status, o.who).toBe(201);
      made.set(o.who, { thread: res.body.thread.id, tc: res.body.ticketConversationId });
    }
    // A de admin é descartada: o cartão dela continua na conversa de cima, só dela.
    expect((await tcCall("DELETE", made.get("admin")!.tc, "admin")).status).toBe(204);
    for (const who of ["manager", "contributor", "admin", "reader", "plain", "target"] as const) {
      const seen = JSON.stringify([(await h.call("GET", "/api/conversations", as(who))).body, (await h.call("GET", `/api/tickets/${t.ticket}/conversation`, as(who))).body]);
      for (const o of owners) {
        const mine = o.who === who;
        if (!mine) expect(seen.includes(o.text), `${who} lê o texto de ${o.who}`).toBe(false);
        const thread = made.get(o.who)!;
        expect((await view(h, who, thread.thread)).status, `${who} → thread de ${o.who}`).toBe(mine ? 200 : 404);
        expect((await h.call("GET", `/api/ticket-conversations/${thread.tc}`, as(who))).status, `${who} → conversa de ${o.who}`).toBe(mine && o.who !== "admin" ? 200 : 404);
      }
      if (!["manager", "contributor", "admin"].includes(who)) expect(seen).not.toMatch(/SENTINELA|Rascunho|"state"/);
    }
    const adminCard = (await view(h, "admin", owners[2]!.conversation)).body.messages.items.find((m: any) => m.thread)?.thread;
    expect(adminCard.creation.state).toBe("discarded");
    expect(JSON.stringify((await h.call("GET", "/api/conversations", as("admin"))).body)).not.toContain(made.get("admin")!.thread);
  });

  it("perda de acesso ao projeto (rascunho, esperando, criado): a thread responde 404 e o cartão fica só com o estado, sem chave, título nem projeto", async () => {
    const t = await seedTree(h.pool, w());
    const general = await openGeneral(h, "contributor");
    const make = async (second: boolean) => {
      const res = await direct("contributor", general, "Um ticket de teste");
      if (second) await tcCall("POST", `${res.body.ticketConversationId}/messages`, "contributor", { message: "Mais" });
      return res.body as { thread: { id: string }; ticketConversationId: string };
    };
    const draft = await make(false);
    expect((await tcCall("DELETE", draft.ticketConversationId, "contributor")).status).toBe(204);
    const waiting = await make(true);
    expect((await tcCall("DELETE", waiting.ticketConversationId, "contributor")).status).toBe(204);
    const kept = await make(false);
    const created = await make(true);
    expect((await tcCall("POST", `${created.ticketConversationId}/ticket`, "contributor", { parentId: t.billing, placedBy: "option" })).status).toBe(201);
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [w().people.contributor, w().projects.priv]);
    for (const thread of [kept.thread.id, created.thread.id]) expect((await view(h, "contributor", thread)).status).toBe(404);
    const seen = (await view(h, "contributor", general)).body.messages.items.flatMap((m: any) => (m.thread ? [m.thread] : []));
    for (const id of [kept.thread.id, created.thread.id]) {
      const card = seen.find((c: any) => c.id === id);
      expect(card.title).toBeNull();
      expect(card.creation).toMatchObject({ projectId: null, projectKey: null, ticket: null });
      expect(JSON.stringify(card)).not.toMatch(/PRIV|Rascunho/);
    }
    expect(seen.find((c: any) => c.id === created.thread.id).creation.state).toBe("created");
    expect(JSON.stringify((await h.call("GET", "/api/conversations", as("contributor"))).body)).not.toMatch(/PRIV-|Rascunho/);
  });

  it("perda de acesso ao projeto: fechar e reabrir a thread de criação respondem o mesmo 404, e a thread fechada antes continua fechada (ADR 0059)", async () => {
    await seedTree(h.pool, w());
    const general = await openGeneral(h, "contributor");
    const res = await direct("contributor", general, "Um ticket de teste");
    const thread = res.body.thread.id as string;
    const closeOf = (id: string) => h.call("POST", `/api/conversations/${id}/close`, as("contributor"));
    const reopenOf = (id: string) => h.call("POST", `/api/conversations/${id}/reopen`, as("contributor"));
    expect((await closeOf(thread)).status).toBe(200);
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [w().people.contributor, w().projects.priv]);
    const closed = await closeOf(thread);
    const reopened = await reopenOf(thread);
    expect([reopened.status, errorCode(reopened)]).toEqual([closed.status, errorCode(closed)]);
    expect(reopened.status).toBe(404);
    expect(JSON.stringify(reopened.body)).not.toMatch(/PRIV|Rascunho|Um ticket de teste/);
    const still = await rows("select closed_seq from conversation_participants where conversation_id = $1 and person_id = $2", [thread, w().people.contributor]);
    expect(still[0].closed_seq).not.toBeNull();
  });

  it("revisão 1 (9): na vez seguinte o histórico enviado ao provedor não leva a resposta fixa nem o marcador", async () => {
    const general = await openGeneral(h, "contributor");
    h.chat().draft_ = () => "Primeiro";
    const made = await post(h, "contributor", general, "Cria um");
    expect(made.body.kind).toBe("creation");
    expect((await tcCall("DELETE", made.body.ticketConversationId, "contributor")).status).toBe(204);
    h.chat().calls.length = 0;
    h.chat().draft_ = null;
    expect((await post(h, "contributor", general, "Oi de novo")).body.kind).toBe("assistant");
    expect(JSON.stringify(h.chat().calls[0]!.history)).not.toMatch(/Abri o rascunho|creation_opened/);
    expect(h.chat().calls[0]!.history.map((m: any) => m.body)).toEqual(["Oi de novo"]);
    // E a leitura da conversa traz o marcador, com o texto de reserva.
    const seen = (await view(h, "contributor", general)).body.messages.items.find((m: any) => m.marker);
    expect(seen).toMatchObject({ marker: "creation_opened", body: CREATION_OPENED_REPLY, authorKind: "assistant" });
  });

  it("revisão 1 (10): a cópia ao criar não parte um emoji ao meio e não deixa nada como não lido para quem criou", async () => {
    const t = await seedTree(h.pool, w());
    const general = await openGeneral(h, "contributor");
    h.conversation().reply = () => ({ message: `${"b".repeat(7999)}😀 fim`, draft: { title: "Rascunho", description: "d" }, ready: true, model: "claude-opus-5-5" });
    const res = await direct("contributor", general, "Um ticket");
    const tcId = res.body.ticketConversationId as string;
    h.judge().verdict = (input) => ({ belongs: input.current ? 0.95 : 0.1, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, i === 0 ? 0.2 : 0.8])) });
    await tcCall("POST", `${tcId}/placement`, "contributor", {});
    const created = await tcCall("POST", `${tcId}/ticket`, "contributor", { parentId: t.billing, placedBy: "option" });
    expect(created.status).toBe(201);
    const copied = await rows("select author_person_id, body, seq from conversation_messages where conversation_id = (select id from conversations where kind = 'ticket' and ticket_id = $1 and owner_person_id = $2) order by seq", [created.body.ticket.id, w().people.contributor]);
    const cut = copied.find((r) => r.author_person_id === null && r.body.startsWith("bbb"));
    expect(cut.body).toBe("b".repeat(7999)); // o par substituto inteiro não cabe: sai inteiro, nunca meio emoji
    expect(copied.every((r) => !/[\ud800-\udbff]$/.test(r.body) && !/^[\udc00-\udfff]/.test(r.body))).toBe(true);
    const unread = await rows("select count(*)::int as n from conversation_messages m join conversation_participants p on p.conversation_id = m.conversation_id where p.person_id = $1 and m.conversation_id = (select id from conversations where kind = 'ticket' and ticket_id = $2 and owner_person_id = $1) and m.seq > p.last_read_seq and m.author_person_id is distinct from p.person_id", [w().people.contributor, created.body.ticket.id]);
    expect(unread[0].n).toBe(0);
  });

  it("revisão 1 (12): a lista antiga de conversas de novo ticket não traz as que nasceram em thread", async () => {
    const general = await openGeneral(h, "contributor");
    const inThread = await direct("contributor", general, "Um ticket numa thread");
    const alone = await h.call("POST", `/api/projects/${w().projects.priv}/ticket-conversations`, as("contributor"), { message: "Um ticket pela rota antiga" });
    expect(alone.status).toBe(201);
    const list = await h.call("GET", `/api/ticket-conversations?projectId=${w().projects.priv}`, as("contributor"));
    expect(list.body.map((c: any) => c.id)).toEqual([alone.body.id]);
    expect(list.body.map((c: any) => c.id)).not.toContain(inThread.body.ticketConversationId);
  });

  it("revisão 1 (2): rascunho aberto em projeto que a pessoa deixou de ver não trava o limite do assistente", async () => {
    const general = await openGeneral(h, "contributor");
    h.chat().draft_ = () => "Primeiro";
    expect((await post(h, "contributor", general, "Cria um")).body.kind).toBe("creation");
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [w().people.contributor, w().projects.priv]);
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ('org_A',$1,$2,'contributor')", [w().projects.org, w().people.contributor]);
    h.chat().calls.length = 0;
    const next = await post(h, "contributor", general, "Cria outro");
    expect(next.body.kind).toBe("creation");
    expect(h.chat().calls[0]!.draftTool).toEqual({ kind: "ready" });
  });

  it("revisão 1 (3): origem que é ideia ou ticket cancelado não derruba a procura do lugar (projeto inteiro)", async () => {
    const t = await seedChatTickets(h.pool, w());
    for (const status of ["cancelled", "idea"]) {
      const main = await openTicket(h, "manager", t.child2);
      const res = await direct("manager", main, `Um ticket (${status})`);
      expect(res.status).toBe(201);
      if (status === "cancelled") await h.pool.query("update tickets set status = 'cancelled' where id = $1", [t.child2]);
      else await h.pool.query("update tickets set status = 'todo', idea_stage = 'new' where id = $1", [t.child2]);
      h.judge().calls.length = 0;
      const placed = await tcCall("POST", `${res.body.ticketConversationId}/placement`, "manager", {});
      expect([status, placed.status]).toEqual([status, 201]);
      expect(h.judge().calls[0]?.scope).toBeUndefined();
      expect((await tcCall("DELETE", res.body.ticketConversationId, "manager")).status).toBe(204);
      await h.pool.query("update tickets set status = 'todo', idea_stage = null where id = $1", [t.child2]);
    }
  });

  it("revisão 1 (5): duas aberturas simultâneas pelo assistente (Meu chat e chat de ticket) abrem um só rascunho", async () => {
    const t = await seedChatTickets(h.pool, w());
    const general = await openGeneral(h, "manager");
    const main = await openTicket(h, "manager", t.ticket);
    h.chat().draft_ = () => "Pedido";
    const both = await Promise.all([h.call("POST", `/api/conversations/${general}/messages`, as("manager"), { body: "Cria um ticket", projectId: w().projects.priv }), post(h, "manager", main, "Cria um ticket")]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(threadsOf(await tree("manager"))).toHaveLength(1);
  });

  it("agindo como pessoa de teste a criação fica no nome dela; com alvo inválido, 403 e nenhum efeito", async () => {
    const bia = (await createTestPerson(h, "Bia")).id;
    const general = (await h.call("POST", "/api/conversations/general", as("admin"), undefined, actAs(bia))).body.id as string;
    const res = await h.call("POST", `/api/conversations/${general}/messages`, as("admin"), { body: "Um ticket", creation: true, projectId: w().projects.org }, actAs(bia));
    // Bia (pessoa de teste, sem papel em projeto) não cria ticket: a recusa é dela, não do administrador.
    expect([res.status, errorCode(res)]).toEqual([422, "project_unavailable"]);
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ('org_A',$1,$2,'contributor')", [w().projects.priv, bia]);
    const ok = await h.call("POST", `/api/conversations/${general}/messages`, as("admin"), { body: "Um ticket", creation: true }, actAs(bia));
    expect(ok.status).toBe(201);
    expect((await rows("select owner_person_id from conversations where id = $1", [ok.body.thread.id]))[0].owner_person_id).toBe(bia);
    expect((await rows("select author_person_id from ticket_conversations where id = $1", [ok.body.ticketConversationId]))[0].author_person_id).toBe(bia);
    const before = await snapshot(h.pool);
    const refused = await h.call("POST", `/api/conversations/${general}/messages`, as("admin"), { body: "Outro", creation: true }, actAs("00000000-0000-4000-8000-000000000000"));
    expect(refused.status).toBe(403);
    expect(await snapshot(h.pool)).toEqual(before);
  });
});

describe("ferramenta open_ticket_draft no provedor real", () => {
  const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
  const toolTurn = (...uses: unknown[]) => ({ stop_reason: "tool_use", parsed_output: null, model: "claude-opus-5-5", content: uses });
  const final = { stop_reason: "end_turn", parsed_output: { message: "ok" }, model: "claude-opus-5-5", content: [{ type: "text", text: "{}" }] };
  const base = { ticket: null, history: [{ author: "person" as const, body: "oi" }], projects: ["PRIV"], wantTitle: false };

  it("só é oferecida quando a conversa permite (`draftTool` não nulo), e o primeiro pedido encerra a vez sem outra chamada ao provedor", async () => {
    const requests: any[] = [];
    const stream = (async (params: any) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      const offered = params.tools.some((t: any) => t.name === "open_ticket_draft");
      return offered && requests.length === 1 ? toolTurn(use("a", "open_ticket_draft", { request: "Primeiro" }), use("b", "open_ticket_draft", { request: "Segundo" })) : final;
    }) as unknown as ClaudeStreamer;
    const executed: unknown[] = [];
    const tools = { execute: async (name: string, input: any) => (executed.push([name, input]), name === "open_ticket_draft" ? { content: "ok", isError: false, openDraft: input.request as string } : { content: "x", isError: true }) };
    const provider = new ClaudeChatProvider(stream);
    const none = await provider.reply({ ...base, tools, draftTool: null });
    expect(none.openDraft).toBeUndefined();
    expect(requests[0].tools.map((t: any) => t.name)).not.toContain("open_ticket_draft");
    requests.length = 0;
    executed.length = 0;
    const out = await provider.reply({ ...base, tools, draftTool: { kind: "ready" } });
    expect(requests[0].tools.map((t: any) => t.name)).toContain("open_ticket_draft");
    expect(requests[0].tools.find((t: any) => t.name === "open_ticket_draft").input_schema.properties).toEqual({ request: expect.any(Object) });
    expect(out).toMatchObject({ message: "", openDraft: "Primeiro" });
    expect(requests).toHaveLength(1);
    expect(executed).toEqual([["open_ticket_draft", { request: "Primeiro" }]]);
  });
});

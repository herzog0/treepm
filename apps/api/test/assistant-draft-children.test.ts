import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";
import type { ConversationTurn } from "../src/assistant/ports.js";

const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

const REQUEST =
  "quero que a gente tenha uma interface tipo chat do slack no painel lateral esquerdo. quando uma pessoa tme um ticket um chat fica disponível pra ela trabalhar nele. quebre a tarefa que eu vou pedir o design dela.";
const children = (n: number) => Array.from({ length: n }, (_v, i) => ({ title: `Parte ${i + 1}`, description: `Texto da parte ${i + 1}` }));
const turn = (draft: ConversationTurn["draft"], ready = true): ConversationTurn => ({ message: "Proponho assim.", draft, ready, model: "claude-opus-5-5" });
const proposeFamily = (kids = children(3), description = "Organizado pela IA.") => {
  h.conversation().reply = () => turn({ title: "Chat no painel", description, children: kids });
};
const open = async (message = REQUEST, who: Who = "contributor") => {
  const res = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; draft: { title: string; description: string; children: { title: string; description: string }[] } };
};
const create = (id: string, parentId: string | null = null, who: Who = "contributor") =>
  h.call("POST", `/api/ticket-conversations/${id}/ticket`, as(who), { parentId });
const patch = (id: string, body: unknown) => h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), body);

afterEach(() => vi.restoreAllMocks());

describe("o rascunho com filhos", () => {
  it("a resposta da IA com filhos é guardada e devolvida na conversa", async () => {
    proposeFamily();
    const conv = await open();
    expect(conv.draft).toEqual({ title: "Chat no painel", description: "Organizado pela IA.", children: children(3) });
    const got = await h.call("GET", `/api/ticket-conversations/${conv.id}`, as("contributor"));
    expect(got.body.draft.children).toEqual(children(3));
    const list = await h.call("GET", `/api/ticket-conversations?projectId=${priv()}`, as("contributor"));
    expect(list.body[0].draft.children).toHaveLength(3);
  });

  it("rascunho de um ticket só: children é lista vazia e nada muda", async () => {
    const conv = await open("Quero corrigir o login");
    expect(conv.draft).toEqual({ title: "Rascunho 1", description: "Quero corrigir o login", children: [] });
  });

  it("o rascunho atual com filhos volta ao provedor no turno seguinte; sem filhos, o formato é o de antes", async () => {
    proposeFamily();
    const conv = await open();
    h.conversation().reply = null;
    await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "junte as duas últimas" });
    expect(h.conversation().calls.at(-1)?.draft).toEqual({ title: "Chat no painel", description: "Organizado pela IA.", children: children(3) });
    const plain = await open("Quero corrigir o login");
    await h.call("POST", `/api/ticket-conversations/${plain.id}/messages`, as("contributor"), { message: "mais" });
    expect(h.conversation().calls.at(-1)?.draft).toEqual({ title: "Rascunho 1", description: "Quero corrigir o login" });
  });

  it("um turno da IA com draft null mantém título, descrição e filhos", async () => {
    proposeFamily();
    const conv = await open();
    h.conversation().reply = () => turn(null, false);
    const res = await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "e o prazo?" });
    expect(res.body.draft.children).toEqual(children(3));
  });

  it("um turno da IA com children vazio tira os filhos", async () => {
    proposeFamily();
    const conv = await open();
    h.conversation().reply = () => turn({ title: "Um só", description: "x", children: [] });
    const res = await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "um ticket só" });
    expect(res.body.draft).toEqual({ title: "Um só", description: "x", children: [] });
  });

  it("PATCH edita pai e filhos, tira um e reordena", async () => {
    proposeFamily();
    const conv = await open();
    const res = await patch(conv.id, {
      title: "Novo pai",
      description: "Nova",
      children: [
        { title: "C", description: "terceira" },
        { title: "A", description: "primeira" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.draft).toEqual({
      title: "Novo pai",
      description: "Nova",
      children: [
        { title: "C", description: "terceira" },
        { title: "A", description: "primeira" },
      ],
    });
  });

  it("PATCH sem children mantém os filhos; com [] tira todos", async () => {
    proposeFamily();
    const conv = await open();
    expect((await patch(conv.id, { title: "T", description: "D" })).body.draft.children).toEqual(children(3));
    expect((await patch(conv.id, { title: "T", description: "D", children: [] })).body.draft.children).toEqual([]);
  });

  it("aceita 20 filhos e recusa 21; recusa filho com filhos (um nível só), filho sem título ou campo desconhecido", async () => {
    proposeFamily();
    const conv = await open();
    expect((await patch(conv.id, { title: "T", children: children(20) })).status).toBe(200);
    expect((await patch(conv.id, { title: "T", children: children(21) })).status).toBe(400);
    expect((await patch(conv.id, { title: "T", children: [{ title: "a", description: "", children: [] }] })).status).toBe(400);
    expect((await patch(conv.id, { title: "T", children: [{ title: "  ", description: "" }] })).status).toBe(400);
    expect((await patch(conv.id, { title: "T", children: [{ title: "a", extra: 1 }] })).status).toBe(400);
    expect((await patch(conv.id, { title: "T", children: [{ title: "a" }] })).body.draft.children).toEqual([{ title: "a", description: "" }]);
  });

  it("o provedor com mais de 20 filhos é tratado como falha: nada é gravado", async () => {
    // O limite é conferido no adaptador do Claude (ver claude-conversation-provider.test.ts); aqui, no banco.
    proposeFamily();
    const conv = await open();
    await expect(h.pool.query("update ticket_conversations set draft_children = $2::jsonb where id = $1", [conv.id, JSON.stringify(children(21))])).rejects.toThrow();
  });
});

describe("a prévia", () => {
  it("devolve a descrição já com a citação, os filhos e a citação à parte", async () => {
    proposeFamily();
    const conv = await open();
    const res = await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("contributor"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: "Chat no painel",
      description: `Pedido original:\n\n> ${REQUEST}\n\nOrganizado pela IA.`,
      quote: `Pedido original:\n\n> ${REQUEST}`,
      children: children(3),
      unknownKeys: [],
      descriptionTooLong: false,
    });
  });

  it("sem rascunho: 409 draft_required; de outra pessoa: 404", async () => {
    h.conversation().reply = () => turn(null, false);
    const conv = await open();
    expect(errorOf(await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("contributor")))).toBe("draft_required");
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("manager"))).status).toBe(404);
  });

  it("aponta as chaves inexistentes e o excesso de tamanho que a criação recusaria", async () => {
    proposeFamily(children(1), "Veja PRIV-77.");
    const conv = await open();
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("contributor"))).body.unknownKeys).toEqual(["PRIV-77"]);
    await patch(conv.id, { title: "T", description: "y".repeat(20_000) });
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("contributor"))).body.descriptionTooLong).toBe(true);
  });
});

describe("criar pai e filhos numa operação só", () => {
  it("cria o pai com a citação byte a byte e a descrição da IA depois, e os filhos dentro dele, na ordem", async () => {
    proposeFamily();
    const conv = await open();
    const res = await create(conv.id);
    expect(res.status).toBe(201);
    expect(res.body.ticket.description).toBe(`Pedido original:\n\n> ${REQUEST}\n\nOrganizado pela IA.`);
    expect(res.body.ticket.title).toBe("Chat no painel");
    expect(res.body.children.map((c: { title: string }) => c.title)).toEqual(["Parte 1", "Parte 2", "Parte 3"]);
    expect(res.body.children.every((c: { parentId: string }) => c.parentId === res.body.ticket.id)).toBe(true);
    expect(res.body.children.map((c: { description: string }) => c.description)).toEqual(children(3).map((c) => c.description));
    expect(res.body.children.map((c: { number: number }) => c.number)).toEqual([res.body.ticket.number + 1, res.body.ticket.number + 2, res.body.ticket.number + 3]);
    expect(res.body.conversation).toMatchObject({ status: "ticket_created", createdTicketId: res.body.ticket.id });
    expect(await count("tickets")).toBe(4);
  });

  it("os filhos não levam a citação", async () => {
    proposeFamily();
    const res = await create((await open()).id);
    for (const child of res.body.children) expect(child.description).not.toContain("Pedido original");
  });

  it("rascunho de um ticket só: tudo como hoje, mais a citação; children vem vazio", async () => {
    const res = await create((await open("Quero corrigir o login")).id);
    expect(res.status).toBe(201);
    expect(res.body.ticket.description).toBe("Pedido original:\n\n> Quero corrigir o login\n\nQuero corrigir o login");
    expect(res.body.children).toEqual([]);
    expect(await count("tickets")).toBe(1);
  });

  it("a citação junta as mensagens da pessoa daquela conversa, em ordem, e não as do assistente", async () => {
    const conv = await open("primeira mensagem");
    await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "segunda\ncom duas linhas" });
    const res = await create(conv.id);
    expect(res.body.ticket.description.startsWith("Pedido original:\n\n> primeira mensagem\n\n> segunda\n> com duas linhas\n\n")).toBe(true);
    expect(res.body.ticket.description).not.toContain("Entendi");
  });

  it("uma falha no terceiro filho desfaz tudo: nenhum ticket, a conversa continua aberta", async () => {
    proposeFamily();
    const conv = await open();
    // Um gatilho no banco recusa o ticket de título "Parte 3".
    await h.pool.query(`create or replace function pg_temp.noop() returns void language sql as 'select 1'`);
    await h.pool.query(`create function refuse_part_3() returns trigger language plpgsql as $$ begin if new.title = 'Parte 3' then raise exception 'recusado de propósito'; end if; return new; end $$`);
    await h.pool.query(`create trigger refuse_part_3 before insert on tickets for each row execute function refuse_part_3()`);
    try {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const res = await create(conv.id);
      expect(res.status).toBe(500);
      expect(await count("tickets")).toBe(0);
      expect(await count("activity_events")).toBe(0);
      expect((await rows("select status, created_ticket_id from ticket_conversations where id = $1", [conv.id]))[0]).toEqual({ status: "open", created_ticket_id: null });
    } finally {
      await h.pool.query("drop trigger refuse_part_3 on tickets");
      await h.pool.query("drop function refuse_part_3()");
    }
  });

  it("grava um ticket.created por ticket, com a origem assistente e a conversa", async () => {
    proposeFamily();
    const conv = await open();
    const res = await create(conv.id);
    const events = await rows("select subject_id, payload from activity_events where kind = 'ticket.created' order by occurred_at, id");
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.subject_id).sort()).toEqual([res.body.ticket.id, ...res.body.children.map((c: { id: string }) => c.id)].sort());
    for (const e of events) expect(e.payload).toMatchObject({ origin: "assistant", conversationId: conv.id });
  });

  it("cria dentro do pai escolhido e reabre o pai de destino concluído, uma vez", async () => {
    const tree = await seedTree(h.pool, h.world());
    await h.pool.query("update tickets set status = 'done' where id in ($1, $2)", [tree.login, tree.auth]);
    proposeFamily();
    const conv = await open();
    const res = await create(conv.id, tree.login);
    expect(res.status).toBe(201);
    expect(res.body.ticket.parentId).toBe(tree.login);
    expect((await rows("select status from tickets where id = $1", [tree.login]))[0].status).not.toBe("done");
    expect((await rows("select status from tickets where id = $1", [tree.auth]))[0].status).not.toBe("done");
    expect((await rows("select count(*)::int as n from activity_events where kind = 'ticket.updated' and subject_id = $1", [tree.login]))[0].n).toBe(1);
  });

  it("dentro de uma ideia, pai e filhos fazem parte dela e ficam a fazer", async () => {
    const idea = (
      await rows(
        "insert into tickets (org_id, project_id, number, title, idea_stage, created_by_person_id) values ('org_A',$1,90,'Ideia','new',$2) returning id",
        [priv(), h.world().people.manager],
      )
    )[0].id as string;
    await h.pool.query("update projects set next_ticket_number = 91 where id = $1", [priv()]);
    proposeFamily();
    const res = await create((await open()).id, idea);
    expect(res.status).toBe(201);
    expect(res.body.ticket.parentId).toBe(idea);
    expect([res.body.ticket, ...res.body.children].map((t: { status: string }) => t.status)).toEqual(["todo", "todo", "todo", "todo"]);
  });

  it("as menções da descrição do pai e dos filhos viram ligações", async () => {
    const tree = await seedTree(h.pool, h.world());
    proposeFamily([{ title: "Filha", description: "Relacionada com PRIV-2." }], "Parte do PRIV-1.");
    const res = await create((await open()).id, tree.auth);
    const rel = await rows("select f.title as from_title, t.number as to_number from ticket_relations r join tickets f on f.id = r.from_ticket_id join tickets t on t.id = r.to_ticket_id where r.kind = 'mentions' order by t.number");
    expect(rel).toEqual([
      { from_title: "Chat no painel", to_number: 1 },
      { from_title: "Filha", to_number: 2 },
    ]);
    expect(res.status).toBe(201);
  });

  it("repetir devolve o pai e os mesmos filhos, sem criar de novo", async () => {
    proposeFamily();
    const conv = await open();
    const first = await create(conv.id);
    const again = await create(conv.id);
    expect(again.body.ticket.id).toBe(first.body.ticket.id);
    expect(again.body.children.map((c: { id: string }) => c.id)).toEqual(first.body.children.map((c: { id: string }) => c.id));
    expect(await count("tickets")).toBe(4);
  });

  it("não chama nenhum provedor", async () => {
    proposeFamily();
    const conv = await open();
    const before = h.conversation().calls.length;
    await create(conv.id);
    expect(h.conversation().calls).toHaveLength(before);
    expect(h.judge().calls).toHaveLength(0);
  });

  it("com agrupador novo (group), o pai e os filhos nascem dentro dele", async () => {
    const tree = await seedTree(h.pool, h.world());
    proposeFamily();
    const conv = await open();
    const res = await h.call("POST", `/api/ticket-conversations/${conv.id}/ticket`, as("contributor"), {
      parentId: tree.auth,
      group: { title: "Chats", description: "", ticketIds: [tree.login] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const group = (await rows("select parent_id from tickets where id = $1", [res.body.ticket.id]))[0].parent_id as string;
    expect((await rows("select title from tickets where id = $1", [group]))[0].title).toBe("Chats");
    expect(res.body.children.every((c: { parentId: string }) => c.parentId === res.body.ticket.id)).toBe(true);
  });
});

describe("chaves de ticket inexistentes na parte da IA", () => {
  it("a descrição do pai cita chave inexistente: 409 unknown_ticket_keys com a lista, e nada é criado", async () => {
    await seedTree(h.pool, h.world());
    proposeFamily(children(1), "Veja PRIV-77 e PRIV-1 e PRIV-78.");
    const res = await create((await open()).id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("unknown_ticket_keys");
    expect(res.body.error.details).toEqual({ keys: ["PRIV-77", "PRIV-78"] });
    expect(await count("tickets")).toBe(7);
  });

  it("a descrição de um filho também é conferida", async () => {
    proposeFamily([{ title: "F", description: "Depende de PRIV-500." }]);
    const res = await create((await open()).id);
    expect(errorOf(res)).toBe("unknown_ticket_keys");
    expect(res.body.error.details).toEqual({ keys: ["PRIV-500"] });
    expect(await count("tickets")).toBe(0);
  });

  it("a conversa continua aberta e, corrigida a descrição, a criação passa", async () => {
    proposeFamily(children(1), "Veja PRIV-77.");
    const conv = await open();
    expect(errorOf(await create(conv.id))).toBe("unknown_ticket_keys");
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}`, as("contributor"))).body.status).toBe("open");
    await patch(conv.id, { title: "T", description: "Sem chave." });
    expect((await create(conv.id)).status).toBe(201);
  });

  it("chave que a própria pessoa escreveu (na citação) não é recusada, nem repetida pela IA", async () => {
    proposeFamily(children(1), "A pessoa falou de PRIV-999.");
    const res = await create((await open("Isso é parecido com PRIV-999, veja.")).id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ticket.description).toContain("> Isso é parecido com PRIV-999, veja.");
  });

  it("chave dentro de código em linha ou de outro projeto não conta; chave existente passa", async () => {
    await seedTree(h.pool, h.world());
    proposeFamily(children(1), "Ver `PRIV-77`, OUTRO-5 e PRIV-2.");
    expect((await create((await open()).id)).status).toBe(201);
  });
});

describe("o limite de tamanho da descrição", () => {
  it("citação mais descrição acima do máximo: recusa com description_too_long e nada é criado ou cortado", async () => {
    proposeFamily(children(1), "z".repeat(19_990));
    const res = await create((await open()).id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("description_too_long");
    expect(res.body.error.message).toMatch(/encurt/i);
    expect(res.body.error.details).toMatchObject({ max: 20_000 });
    expect(await count("tickets")).toBe(0);
  });

  it("no limite exato, cria e a citação segue inteira", async () => {
    const quote = `Pedido original:\n\n> ${REQUEST}`;
    proposeFamily(children(1), "z".repeat(20_000 - quote.length - 2));
    const res = await create((await open()).id);
    expect(res.status).toBe(201);
    expect(res.body.ticket.description).toHaveLength(20_000);
    expect(res.body.ticket.description.startsWith(quote)).toBe(true);
  });

  it("só a citação já passa do limite: recusa com request_too_long, mesmo com descrição vazia", async () => {
    h.conversation().reply = () => turn({ title: "T", description: "", children: [] });
    const conv = await open("a");
    for (let i = 0; i < 5; i += 1) expect((await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "m".repeat(4000) })).status).toBe(201);
    await patch(conv.id, { title: "T", description: "" });
    const res = await create(conv.id);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("request_too_long");
    expect(await count("tickets")).toBe(0);
  });
});

describe("a procura do lugar com filhos", () => {
  it("roda uma vez, para o pai; o texto leva a descrição da IA e os títulos dos filhos, sem a citação", async () => {
    await seedTree(h.pool, h.world());
    proposeFamily();
    const conv = await open();
    const res = await h.call("POST", `/api/ticket-conversations/${conv.id}/placement`, as("contributor"), {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const drafts = h.judge().calls.map((c) => c.draft);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.title).toBe("Chat no painel");
      expect(draft.description).toBe("Organizado pela IA.\n\nPartes:\n- Parte 1\n- Parte 2\n- Parte 3");
      expect(draft.description).not.toContain("Pedido original");
    }
  });

  it("rascunho de um ticket só: o texto da procura é o de sempre", async () => {
    await seedTree(h.pool, h.world());
    const conv = await open("Quero corrigir o login");
    await h.call("POST", `/api/ticket-conversations/${conv.id}/placement`, as("contributor"), {});
    for (const call of h.judge().calls) expect(call.draft).toEqual({ title: "Rascunho 1", description: "Quero corrigir o login" });
  });
});

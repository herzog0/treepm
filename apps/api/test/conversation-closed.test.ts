import { describe, expect, it } from "vitest";
import { personLink } from "@treepm/domain";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { actAs, createTestPerson } from "./act-as-support.js";
import { errorCode, openGeneral, openTicket, post, seedChatTickets, ticketView, topic, view } from "./chat-support.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0059 (TREEPM-417): fechar conversa e thread só quando alguém marcado é de fora.
type Node = { id: string | null; kind: string; closed: boolean; unread: number; children: Node[] };
const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

describe("fechar conversa (ADR 0059)", () => {
  const h = useHarness(AI_CONFIG);
  const p = () => h.world().people;
  const tree = async (who: Who | "target" = "manager") => (await h.call("GET", "/api/conversations", as(who))).body.items as Node[];
  const shown = async (who: Who | "target" = "manager") => flat(await tree(who)).flatMap((n) => (n.id ? [n.id] : []));
  const closedList = async (who: Who | "target" = "manager") => (await h.call("GET", "/api/conversations/closed", as(who))).body.items as Node[];
  const close = (who: Who | "target", id: string) => h.call("POST", `/api/conversations/${id}/close`, as(who));
  const reopen = (who: Who | "target", id: string) => h.call("POST", `/api/conversations/${id}/reopen`, as(who));

  /** principal do gestor → d1 (gestor, Alice) → d2 (gestor, Alice, Bob); d3, irmã de d1 (gestor, Carol). */
  async function world() {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const d1 = (await post(h, "manager", main, "para Alice", [p().reader])).body.thread.id as string;
    const d2 = (await post(h, "reader", d1, "e o Bob?", [p().contributor])).body.thread.id as string;
    const d3 = (await post(h, "manager", main, "para Carol", [p().target])).body.thread.id as string;
    return { t, main, d1, d2, d3 };
  }
  const parentOf = async (who: Who | "target", id: string): Promise<string | null> => {
    const find = (nodes: Node[], parent: string | null): string | null | undefined => {
      for (const n of nodes) {
        if (n.id === id) return parent;
        const inner = find(n.children, n.id);
        if (inner !== undefined) return inner;
      }
      return undefined;
    };
    return find(await tree(who), null) ?? null;
  };

  it("fechar tira a conversa e as de dentro da árvore de quem fechou, e só dela; reabrir devolve só aquela", async () => {
    const w = await world();
    expect(await shown()).toEqual(expect.arrayContaining([w.main, w.d1, w.d2, w.d3]));
    const res = await close("manager", w.d1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closed: true, closedIds: [w.d1, w.d2] });
    const after = await shown();
    expect(after).toEqual(expect.arrayContaining([w.main, w.d3]));
    expect(after).not.toContain(w.d1);
    expect(after).not.toContain(w.d2);
    // Os outros não percebem.
    expect(await shown("reader")).toEqual(expect.arrayContaining([w.d1, w.d2]));
    expect(await shown("contributor")).toContain(w.d2);
    // A lista das fechadas: plana, com o mesmo formato de nó.
    const list = await closedList();
    expect(list.map((n) => n.id).sort()).toEqual([w.d1, w.d2].sort());
    expect(list.every((n) => n.closed && n.children.length === 0)).toBe(true);
    // Reabrir só uma.
    expect((await reopen("manager", w.d1)).body).toEqual({ closed: false });
    expect(await shown()).toContain(w.d1);
    expect(await shown()).not.toContain(w.d2);
    expect((await closedList()).map((n) => n.id)).toEqual([w.d2]);
    // Os da árvore nunca trazem `closed: true`.
    expect(flat(await tree()).every((n) => n.closed === false)).toBe(true);
  });

  it("desfazer não reabre o que já estava fechado: closedIds só traz o que ESTE pedido fechou", async () => {
    const w = await world();
    // d2 já estava fechada (fechada antes); fechar d1 leva só d1.
    expect((await close("manager", w.d2)).body).toEqual({ closed: true, closedIds: [w.d2] });
    const res = await close("manager", w.d1);
    expect(res.body).toEqual({ closed: true, closedIds: [w.d1] });
    // Desfazer o último fechamento (reabrir o que ele devolveu) deixa d2 fechada.
    for (const id of res.body.closedIds as string[]) await reopen("manager", id);
    expect(await shown()).toContain(w.d1);
    expect(await shown()).not.toContain(w.d2);
    // Fechar de novo o que já está fechado não devolve nada.
    expect((await close("manager", w.d2)).body).toEqual({ closed: true, closedIds: [] });
  });

  it("a de dentro aberta sobe para a mais próxima que aparece, atravessando a fechada do meio (não para a principal)", async () => {
    const w = await world();
    const d4 = (await post(h, "contributor", w.d2, "mais fundo", [p().plain === "" ? p().target : p().admin])).body.thread.id as string;
    // main > d1 > d2 > d4: fecha d2 (leva d4), reabre d4: d4 pende de d1 para o gestor.
    await close("manager", w.d2);
    await reopen("manager", d4);
    expect(await shown()).not.toContain(w.d2);
    expect(await parentOf("manager", d4)).toBe(w.d1);
    // Quem não lê as de cima continua sem ver nada delas: o Bob lê d2 e d4, e d4 pende de d2.
    expect(await parentOf("contributor", d4)).toBe(w.d2);
  });

  it("a lista das fechadas vem da mais recente para a mais antiga", async () => {
    const w = await world();
    await post(h, "manager", w.d3, "mais recente que d1");
    await close("manager", w.d1);
    await close("manager", w.d3);
    const ids = (await closedList()).map((n) => n.id);
    expect(ids[0]).toBe(w.d3);
    expect([...ids].sort()).toEqual([w.d1, w.d2, w.d3].sort());
  });

  it("o chat geral não fecha (422), reabrir é inofensivo, e quem não participa recebe o 404 de sempre", async () => {
    const w = await world();
    const general = await openGeneral(h, "manager");
    const refused = await close("manager", general);
    expect(refused.status).toBe(422);
    expect(errorCode(refused)).toBe("cannot_close_general");
    expect((await reopen("manager", general)).status).toBe(200);
    for (const who of ["contributor", "target", "plain", "admin"] as const) {
      expect((await close(who, w.d1)).status, `${who} fecha`).toBe(404);
      expect((await reopen(who, w.d1)).status, `${who} reabre`).toBe(404);
    }
    expect((await closedList("plain")).length).toBe(0);
    expect(await shown("manager")).toContain(w.d1);
  });

  it("fechar não muda leitura: quem fechou continua lendo pelo id e quem não lia continua sem ler", async () => {
    const w = await world();
    await close("manager", w.d1);
    const seen = await view(h, "manager", w.d1);
    expect(seen.status).toBe(200);
    expect(seen.body.conversation.closed).toBe(true);
    expect(seen.body.messages.items.map((m: { body: string }) => m.body)).toEqual(["e o Bob?", "para Alice"]);
    // Ler não reabre.
    expect(await shown()).not.toContain(w.d1);
    expect((await view(h, "contributor", w.d1)).status).toBe(404);
    expect((await view(h, "contributor", w.d2)).status).toBe(200);
    // O cartão da thread na conversa de cima diz que está fechada.
    const card = (await view(h, "manager", w.main)).body.threads.find((c: { id: string }) => c.id === w.d1);
    expect(card.closed).toBe(true);
    expect((await view(h, "reader", w.main)).status).toBe(404);
    // Quem não lê a de cima, ao fechar a sua, não faz aparecer nada do que não lê.
    await close("contributor", w.d2);
    expect(await shown("contributor")).not.toContain(w.d2);
    expect((await view(h, "contributor", w.d1)).status).toBe(404);
    expect(await shown("contributor")).not.toContain(w.d1);
    expect(await shown("contributor")).not.toContain(w.main);
  });

  it("volta sozinha: mensagem de outra pessoa traz de volta para quem fechou e para mais ninguém", async () => {
    const w = await world();
    await close("manager", w.d1);
    await close("reader", w.d1);
    expect(await shown("manager")).not.toContain(w.d1);
    // Bob responde em d2 (fechada para o gestor e para a Alice): d2 volta para os dois, d1 não.
    await post(h, "contributor", w.d2, "cheguei");
    expect(await shown("manager")).toContain(w.d2);
    expect(await shown("manager")).not.toContain(w.d1);
    expect(await shown("reader")).toContain(w.d2);
    expect(await shown("reader")).not.toContain(w.d1);
    // Pendurada no lugar certo: d1 está fechada, então d2 sobe para a principal (que o gestor lê); para a Alice, que não lê a principal, é ponta.
    expect(await parentOf("manager", w.d2)).toBe(w.main);
    expect(await parentOf("reader", w.d2)).toBeNull();
    expect((await closedList("manager")).map((n) => n.id)).toEqual([w.d1]);
    // Mensagem de outra pessoa direto em d1 traz d1 para quem fechou.
    await post(h, "reader", w.d1, "voltei");
    expect(await shown("manager")).toContain(w.d1);
    expect(await parentOf("manager", w.d2)).toBe(w.d1);
    // Quem escreveu em d1 a reabre para si.
    expect(await shown("reader")).toContain(w.d1);
    expect(await shown("contributor")).toContain(w.d2);
  });

  it("voltou sozinha e foi fechada de novo: entra em closedIds de novo e o ponto de fechamento avança", async () => {
    const w = await world();
    const mark = async () => (await h.pool.query("select closed_seq from conversation_participants where conversation_id = $1 and person_id = $2", [w.d1, p().manager])).rows[0].closed_seq as string;
    expect((await close("manager", w.d1)).body.closedIds).toContain(w.d1);
    const first = BigInt(await mark());
    await post(h, "reader", w.d1, "voltei");
    expect(await shown("manager")).toContain(w.d1);
    const again = await close("manager", w.d1);
    expect(again.body.closedIds).toContain(w.d1);
    expect(BigInt(await mark())).toBeGreaterThan(first);
    expect(await shown("manager")).not.toContain(w.d1);
    // Sem nada novo, fechar de novo não conta como fechada por este pedido.
    expect((await close("manager", w.d1)).body.closedIds).toEqual([]);
  });

  it("volta sozinha também com a resposta do assistente, e a própria pessoa escrevendo reabre", async () => {
    const w = await world();
    await close("manager", w.main);
    expect(await shown("manager")).not.toContain(w.main);
    expect((await post(h, "manager", w.main, "voltei a falar")).body.kind).toBe("assistant");
    expect(await shown("manager")).toContain(w.main);
    // O envio da própria pessoa numa thread reabre aquela thread, e só ela.
    await close("manager", w.d1);
    expect((await post(h, "manager", w.d1, "eu mesmo")).status).toBe(201);
    expect(await shown("manager")).toContain(w.d1);
    expect(await shown("manager")).not.toContain(w.d2);
    // Abrir uma thread reabre a conversa de cima.
    await close("manager", w.main);
    await post(h, "manager", w.main, "nova thread", [await outsider()]);
    expect(await shown("manager")).toContain(w.main);
  });

  async function outsider(): Promise<string> {
    const { newOutsider } = await import("./chat-support.js");
    return newOutsider(h.pool);
  }

  it("a conversa do ticket fechada some da barra mesmo com a pessoa responsável, e o cartão da conversa traz closed", async () => {
    const w = await world();
    const ticketRow = async () => flat(await tree()).filter((n) => n.kind === "ticket");
    expect((await ticketRow()).length).toBe(1);
    // Fechar a conversa do ticket fecha as de dentro; reabrir uma delas a deixa sob a linha do ticket, sem conversa dela.
    await close("manager", w.main);
    expect(await ticketRow()).toEqual([]);
    await reopen("manager", w.d3);
    const rows = await ticketRow();
    expect(rows).toHaveLength(1);
    expect(rows.every((n) => n.id === null)).toBe(true);
    expect(await shown()).not.toContain(w.main);
    expect(await shown()).toContain(w.d3);
    const byTicket = await ticketView(h, "manager", w.t.ticket);
    expect(byTicket.body.conversation.closed).toBe(true);
    await close("manager", w.d3);
    // Sem nada aberto dentro, a linha do ticket some.
    expect(await ticketRow()).toEqual([]);
    await reopen("manager", w.main);
    expect((await ticketRow()).map((n) => n.id)).toEqual([w.main]);
    expect((await ticketView(h, "manager", w.t.ticket)).body.conversation.closed).toBe(false);
  });

  it("marcar quem já está na conversa é mensagem comum: sem thread, sem participante novo, sem assistente, com o texto como veio", async () => {
    const w = await world();
    const threads = async () => (await h.pool.query("select count(*)::int as n from conversations where kind = 'thread'")).rows[0].n as number;
    const members = async () => (await h.pool.query("select count(*)::int as n from conversation_participants")).rows[0].n as number;
    const before = { threads: await threads(), members: await members() };
    const text = `Oi ${personLink(p().manager, "Gestor")}, olha`;
    const res = await post(h, "reader", w.d1, text, [p().manager]);
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("message");
    expect(res.body.message.body).toBe(text);
    expect(res.body.message.thread).toBeNull();
    // A própria pessoa na lista não conta; só ela marcada também é mensagem comum.
    expect((await post(h, "reader", w.d1, "eu", [p().reader])).body.kind).toBe("message");
    expect((await post(h, "reader", w.d1, "os dois", [p().reader, p().manager])).body.kind).toBe("message");
    expect({ threads: await threads(), members: await members() }).toEqual(before);
    expect(h.chat().calls).toHaveLength(0);
    // Dentro de d2 (gestor, Alice, Bob), marcar os dois que já estão.
    expect((await post(h, "contributor", w.d2, "gente", [p().manager, p().reader])).body.kind).toBe("message");
    expect(await threads()).toBe(before.threads);
  });

  it("marcar alguém de fora abre a thread com todos; principal e assunto continuam abrindo thread; só a própria pessoa na principal fala com o assistente", async () => {
    const w = await world();
    const res = await post(h, "reader", w.d1, "para a Carol também", [p().manager, p().target]);
    expect(res.body.kind).toBe("thread");
    expect(res.body.thread.participants.map((x: { id: string }) => x.id).sort()).toEqual([p().manager, p().reader, p().target].sort());
    // Na principal (só de uma pessoa) qualquer outra é de fora.
    expect((await post(h, "manager", w.main, "alô", [p().reader])).body.kind).toBe("thread");
    expect(errorCode(await post(h, "manager", w.main, "só eu", [p().manager]))).toBe("assistant_mention_self");
    // Thread de assunto (só da pessoa): marcar alguém abre thread.
    const topic = await h.call("POST", `/api/conversations/${await openGeneral(h, "manager")}/messages`, as("manager"), { body: "um assunto", topic: true });
    expect(topic.body.kind).toBe("topic");
    const inTopic = await post(h, "manager", topic.body.thread.id, "chama a Alice", [p().reader]);
    expect(inTopic.body.kind).toBe("thread");
  });

  it("mention_mismatch continua antes de tudo, nos dois caminhos; quem não pode ser marcado continua recusado só se é de fora", async () => {
    const w = await world();
    const link = personLink(p().target, "Carol");
    // Caminho da mensagem comum (todas já estão) e caminho da thread.
    expect(errorCode(await post(h, "reader", w.d1, `Oi ${link}`, [p().manager]))).toBe("mention_mismatch");
    expect(errorCode(await post(h, "reader", w.d1, `Oi ${link}`, [p().manager, p().plain]))).toBe("mention_mismatch");
    // De fora e sem acesso ao ticket: recusado; de dentro: nada a conferir.
    expect(errorCode(await post(h, "reader", w.d1, "oi", [p().manager, p().plain]))).toBe("mention_not_allowed");
    expect((await post(h, "reader", w.d1, "oi", [p().manager])).body.kind).toBe("message");
  });

  it("agindo como pessoa de teste: fechar vale para ela, não para o administrador", async () => {
    const { id } = await createTestPerson(h, "Bia");
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ($1,$2,$3,'contributor')", ["org_A", h.world().projects.priv, id]);
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const thread = (await post(h, "manager", main, "Bia e admin", [id, p().admin])).body.thread.id as string;
    const close = await h.call("POST", `/api/conversations/${thread}/close`, as("admin"), undefined, actAs(id));
    expect(close.status).toBe(200);
    const hers = await h.call("GET", "/api/conversations", as("admin"), undefined, actAs(id));
    expect(flat(hers.body.items).map((n) => n.id)).not.toContain(thread);
    const his = await h.call("GET", "/api/conversations", as("admin"));
    expect(flat(his.body.items).map((n) => n.id)).toContain(thread);
    const list = await h.call("GET", "/api/conversations/closed", as("admin"), undefined, actAs(id));
    expect(list.body.items.map((n: { id: string }) => n.id)).toEqual([thread]);
    expect((await h.call("GET", "/api/conversations/closed", as("admin"))).body.items).toEqual([]);
  });

  it("as não lidas da árvore não contam conversas fechadas", async () => {
    const w = await world();
    await post(h, "reader", w.d1, "uma", []);
    await post(h, "reader", w.d1, "duas", []);
    const unread = async () => flat(await tree()).reduce((sum, n) => sum + n.unread, 0);
    const before = await unread();
    expect(before).toBeGreaterThan(0);
    await close("manager", w.d1);
    expect(await unread()).toBeLessThan(before);
  });
  // ---- acertos da revisão independente (C2, parte A) ------------------------------------------------------

  const loseProject = (who: Who) => h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [p()[who], h.world().projects.priv]);
  const closedSeqOf = async (id: string, who: Who) => (await h.pool.query("select closed_seq from conversation_participants where conversation_id = $1 and person_id = $2", [id, p()[who]])).rows[0].closed_seq as string | null;

  /** principal do Bob (contributor) → d1 (Bob, gestor) → d2 (Bob, gestor, Carol). */
  async function bobWorld() {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "contributor", t.ticket);
    const d1 = (await post(h, "contributor", main, "para o gestor", [p().manager])).body.thread.id as string;
    const d2 = (await post(h, "manager", d1, "e a Carol?", [p().target])).body.thread.id as string;
    return { t, main, d1, d2 };
  }

  it("fechar depois de perder o projeto: só entra em closedIds (e só fecha) o que a pessoa ainda lê", async () => {
    const w = await bobWorld();
    await loseProject("contributor");
    expect(await shown("contributor")).toEqual([]);
    const res = await close("contributor", w.main);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closed: true, closedIds: [w.main] });
    // As de dentro não foram tocadas: ao recuperar o projeto, continuam abertas.
    expect(await closedSeqOf(w.d1, "contributor")).toBeNull();
    expect(await closedSeqOf(w.d2, "contributor")).toBeNull();
    await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ('org_A',$1,$2,'contributor')", [h.world().projects.priv, p().contributor]);
    expect(await shown("contributor")).toEqual(expect.arrayContaining([w.d1, w.d2]));
    expect((await closedList("contributor")).map((n) => n.id)).toEqual([w.main]);
  });

  it("perder o projeto depois de fechar: a lista das fechadas não traz o que não lê, e reabrir recebe o 404 de fechar", async () => {
    const w = await bobWorld();
    expect((await close("contributor", w.d1)).body.closedIds).toEqual([w.d1, w.d2]);
    await loseProject("contributor");
    expect(await closedList("contributor")).toEqual([]);
    expect((await close("contributor", w.d2)).status).toBe(404);
    expect((await reopen("contributor", w.d2)).status).toBe(404);
    expect((await reopen("contributor", w.d1)).status).toBe(404);
    expect(await closedSeqOf(w.d1, "contributor")).not.toBeNull();
  });

  it("convidado que fecha a própria thread: nada do que está acima aparece na árvore, nas fechadas nem nas respostas", async () => {
    const w = await world();
    // Carol (target) entrou em d3 e não lê a principal do gestor.
    const mine = await shown("target");
    expect(mine).toContain(w.d3);
    expect(mine).not.toContain(w.main);
    const res = await close("target", w.d3);
    expect(res.body).toEqual({ closed: true, closedIds: [w.d3] });
    expect(JSON.stringify(res.body)).not.toContain(w.main);
    const list = await closedList("target");
    expect(list.map((n) => n.id)).toEqual([w.d3]);
    expect(JSON.stringify(list)).not.toContain(w.main);
    expect(await shown("target")).not.toContain(w.d3);
    expect(JSON.stringify(await tree("target"))).not.toContain(w.main);
    const view3 = await view(h, "target", w.d3);
    expect(view3.body.conversation.closed).toBe(true);
    expect(JSON.stringify(view3.body.conversation.trail)).not.toContain(w.main);
    expect((await reopen("target", w.d3)).body).toEqual({ closed: false });
    expect(await shown("target")).toContain(w.d3);
  });

  it("a mensagem que só marca a própria pessoa não vai ao assistente: 422 próprio, sem chamar o provedor e sem gravar", async () => {
    const w = await world();
    const mine = personLink(p().manager, "Gestor");
    const before = (await h.pool.query("select count(*)::int as n from conversation_messages")).rows[0].n as number;
    for (const mentions of [[p().manager], [p().manager, p().manager]]) {
      const res = await post(h, "manager", w.main, `Eu mesmo ${mine}`, mentions);
      expect(res.status).toBe(422);
      expect(errorCode(res)).toBe("assistant_mention_self");
    }
    // Também sem o elo no texto (a lista é que conta) e na thread de assunto.
    expect(errorCode(await post(h, "manager", w.main, "sem elo", [p().manager]))).toBe("assistant_mention_self");
    const topicThread = (await topic(h, "manager", w.main, "um assunto")).body.thread.id as string;
    const callsBefore = h.chat().calls.length;
    expect(errorCode(await post(h, "manager", topicThread, `de novo ${mine}`, [p().manager]))).toBe("assistant_mention_self");
    expect(h.chat().calls).toHaveLength(callsBefore);
    expect((await h.pool.query("select count(*)::int as n from conversation_messages")).rows[0].n).toBe(before + 2);
    // Em thread com pessoas continua mensagem comum (sem provedor).
    expect((await post(h, "reader", w.d1, "eu", [p().reader])).body.kind).toBe("message");
  });

  it("segunda barreira: o que vai ao provedor (mensagem e histórico) nunca leva elo de pessoa", async () => {
    const w = await world();
    const link = personLink(p().reader, "Alice");
    // Um elo que já estava gravado no histórico da conversa (a primeira barreira nunca o deixaria entrar).
    await h.pool.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('org_A',$1,$2,$3)", [w.main, p().manager, `antigo ${link}`]);
    const callsBefore = h.chat().calls.length;
    expect((await post(h, "manager", w.main, "pergunta normal")).body.kind).toBe("assistant");
    const call = h.chat().calls[callsBefore]!;
    expect(JSON.stringify(call)).not.toContain("person:");
    expect(call.history.some((m: { body: string }) => m.body.includes("antigo"))).toBe(true);
    // Abrir assunto: só a abertura vai ao provedor.
    const sent = await h.call("POST", `/api/conversations/${w.main}/messages`, as("manager"), { body: "assunto", topic: true });
    expect(sent.body.kind).toBe("topic");
    expect(JSON.stringify(h.chat().calls.at(-1))).not.toContain("person:");
  });

  it("duas conexões: fechar e escrever esperam a mensagem ainda não confirmada, e o ponto de fechamento não passa à frente dela", async () => {
    const w = await world();
    const holder = await h.pool.connect();
    try {
      // Uma escrita em andamento (a mensagem tem `seq`, mas ainda não foi confirmada) segurando a conversa.
      await holder.query("begin");
      await holder.query("select 1 from conversations where id = (select root_id from conversations where id = $1) for update", [w.d1]);
      const inFlight = (await holder.query("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ('org_A',$1,$2,'em andamento') returning seq", [w.d1, p().reader])).rows[0].seq as string;
      const settled = { close: false, post: false };
      const closing = close("manager", w.d1).then((r) => ((settled.close = true), r));
      const posting = post(h, "reader", w.d1, "outra").then((r) => ((settled.post = true), r));
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(settled).toEqual({ close: false, post: false });
      await holder.query("commit");
      const [closed, sent] = await Promise.all([closing, posting]);
      expect(closed.status).toBe(200);
      expect(sent.status).toBe(201);
      // O ponto de fechamento nunca ficou antes de uma mensagem que já estava confirmada quando o fechamento rodou: a mensagem em andamento está atrás dele.
      expect(BigInt((await closedSeqOf(w.d1, "manager")) as string)).toBeGreaterThanOrEqual(BigInt(inFlight));
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
  });
});

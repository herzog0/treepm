import { ForbiddenException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";
import { AuthorizationService } from "../src/access/authorization.service.js";
import type { ConversationTurn } from "../src/assistant/ports.js";

// ADR 0044, adendo: o rascunho da conversa pode ser registrado como ideia (TREEPM-242).
const h = useHarness(AI_CONFIG);
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

const REQUEST = "Ideia: um botão de play no ticket que inicia o trabalho, mostra quem está nele e avisa quando termina.";
const kids = (n: number) => Array.from({ length: n }, (_v, i) => ({ title: `Parte ${i + 1}`, description: `Texto ${i + 1}` }));
const turn = (draft: ConversationTurn["draft"], ready = true): ConversationTurn => ({ message: "Proponho assim.", draft, ready, model: "claude-opus-5-5" });
const propose = (idea: boolean | undefined, children = kids(3)) => {
  h.conversation().reply = () => turn({ title: "Botão play", description: "Organizado.", children, ...(idea === undefined ? {} : { idea }) });
};
type Conv = { id: string; draft: { title: string; description: string; children: unknown[]; idea: boolean } };
const open = async (message = REQUEST, who: Who = "contributor") => {
  const res = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as(who), { message });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Conv;
};
const create = (id: string, parentId: string | null = null, who: Who = "contributor") => h.call("POST", `/api/ticket-conversations/${id}/ticket`, as(who), { placedBy: "map", parentId });
const patch = (id: string, body: unknown) => h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), body);
const stageOf = async (id: string) => (await rows("select idea_stage, status, parent_id from tickets where id = $1", [id]))[0] as { idea_stage: string | null; status: string; parent_id: string | null };

afterEach(() => vi.restoreAllMocks());

describe("o rascunho com idea", () => {
  it("a IA liga idea: guardado e devolvido na conversa, no GET e na lista; sem idea, falso", async () => {
    propose(true);
    const conv = await open();
    expect(conv.draft.idea).toBe(true);
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}`, as("contributor"))).body.draft.idea).toBe(true);
    expect((await h.call("GET", `/api/ticket-conversations?projectId=${priv()}`, as("contributor"))).body[0].draft.idea).toBe(true);
    propose(undefined);
    expect((await open()).draft.idea).toBe(false);
    const plain = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Corrigir o login" });
    h.conversation().reply = null;
    expect(plain.body.draft.idea).toBe(false);
  });

  it("um turno com draft null mantém idea; um turno com idea falso desliga", async () => {
    propose(true);
    const conv = await open();
    h.conversation().reply = () => turn(null, false);
    expect((await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "e o prazo?" })).body.draft.idea).toBe(true);
    propose(false);
    expect((await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "não é mais só ideia" })).body.draft.idea).toBe(false);
  });

  it("o rascunho atual volta ao provedor sempre com idea, inclusive o que a pessoa desligou ou ligou à mão", async () => {
    propose(true);
    const conv = await open();
    const next = async () => {
      h.conversation().reply = null;
      await h.call("POST", `/api/ticket-conversations/${conv.id}/messages`, as("contributor"), { message: "mais" });
      return h.conversation().calls.at(-1)?.draft;
    };
    expect(await next()).toMatchObject({ idea: true });
    await patch(conv.id, { title: "T", description: "D", idea: false });
    expect(await next()).toMatchObject({ idea: false });
    await patch(conv.id, { title: "T", description: "D", idea: true });
    expect(await next()).toMatchObject({ idea: true });
  });

  it("PATCH liga e desliga idea; sem idea no corpo, mantém; recusa o que não é booleano", async () => {
    propose(false);
    const conv = await open();
    expect((await patch(conv.id, { title: "T", description: "D", idea: true })).body.draft.idea).toBe(true);
    expect((await patch(conv.id, { title: "T2", description: "D" })).body.draft.idea).toBe(true);
    expect((await patch(conv.id, { title: "T2", description: "D", idea: false })).body.draft.idea).toBe(false);
    expect((await patch(conv.id, { title: "T2", idea: "sim" })).status).toBe(400);
  });

  it("a prévia devolve idea", async () => {
    propose(true);
    const conv = await open();
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("contributor"))).body.idea).toBe(true);
    await patch(conv.id, { title: "T", idea: false });
    expect((await h.call("GET", `/api/ticket-conversations/${conv.id}/preview`, as("contributor"))).body.idea).toBe(false);
  });
});

describe("criar a partir de um rascunho com idea", () => {
  it("o pai nasce como ideia no estágio Nova e os filhos dentro dele, na mesma transação", async () => {
    propose(true, kids(3));
    const conv = await open();
    const res = await create(conv.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ticket.idea).toEqual({ root: true, stage: "new" });
    expect(res.body.children).toHaveLength(3);
    for (const child of res.body.children) {
      expect(child.idea).toMatchObject({ root: false, rootId: res.body.ticket.id });
      expect(child.parentId).toBe(res.body.ticket.id);
    }
    expect((await stageOf(res.body.ticket.id)).idea_stage).toBe("new");
    const inside = await rows("select idea_stage, status from tickets where parent_id = $1 order by number", [res.body.ticket.id]);
    expect(inside.map((r) => [r.idea_stage, r.status])).toEqual([[null, "todo"], [null, "todo"], [null, "todo"]]);
    // A descrição guarda a citação, com a palavra "ideia" do pedido.
    expect(res.body.ticket.description).toContain(`> ${REQUEST}`);
  });

  it("idea sem filhos também nasce como ideia", async () => {
    propose(true, []);
    const res = await create((await open()).id);
    expect(res.status).toBe(201);
    expect(res.body.ticket.idea).toEqual({ root: true, stage: "new" });
    expect(res.body.children).toEqual([]);
  });

  it("sem idea, nada muda: ticket comum", async () => {
    propose(false);
    const res = await create((await open()).id);
    expect(res.body.ticket.idea).toBeNull();
    expect((await stageOf(res.body.ticket.id)).idea_stage).toBeNull();
  });

  it("o lugar escolhido já está dentro de uma ideia: nasce como parte dela, sem estágio próprio", async () => {
    const root = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "Ideia mãe", idea: true });
    propose(true, kids(2));
    const res = await create((await open()).id, root.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ticket.idea).toMatchObject({ root: false, rootId: root.body.id });
    expect((await stageOf(res.body.ticket.id)).idea_stage).toBeNull();
    expect((await rows("select count(*)::int as n from tickets where idea_stage is not null"))[0].n).toBe(1);
    expect(res.body.children).toHaveLength(2);
  });

  it("dentro de um ticket comum, a ideia nasce filha dele, como na tela", async () => {
    const plain = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "Comum" });
    propose(true, kids(1));
    const res = await create((await open()).id, plain.body.id);
    expect(res.status).toBe(201);
    expect(res.body.ticket.idea).toEqual({ root: true, stage: "new" });
    expect(res.body.ticket.parentId).toBe(plain.body.id);
  });

  it("com um grupo novo no lugar: o grupo nasce comum e a ideia dentro dele, no estágio Nova, com as partes", async () => {
    const a = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "Solto A" });
    const b = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "Solto B" });
    propose(true, kids(2));
    const conv = await open();
    const res = await h.call("POST", `/api/ticket-conversations/${conv.id}/ticket`, as("contributor"), { placedBy: "map", parentId: null, group: { title: "Grupo", description: "", ticketIds: [a.body.id, b.body.id] } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.ticket.idea).toEqual({ root: true, stage: "new" });
    expect(res.body.children).toHaveLength(2);
    const group = await stageOf(res.body.ticket.parentId);
    expect(group.idea_stage).toBeNull();
    expect((await stageOf(a.body.id)).parent_id).toBe(res.body.ticket.parentId);
  });

  it("usa a mesma permissão da criação de ideia da tela; recusada, não cria nada", async () => {
    propose(true, kids(2));
    const conv = await open();
    const spy = vi.spyOn(h.app().get(AuthorizationService), "registerIdea").mockImplementation(() => {
      throw new ForbiddenException({ code: "forbidden", message: "Sem permissão." });
    });
    const before = await count("tickets");
    const res = await create(conv.id);
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe(await (async () => {
      // O mesmo código que a criação de ideia pela tela devolve.
      const screen = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "x", idea: true });
      return errorOf(screen);
    })());
    expect(spy).toHaveBeenCalled();
    expect(await count("tickets")).toBe(before);
    expect((await rows("select status from ticket_conversations where id = $1", [conv.id]))[0].status).toBe("open");
  });

  it("sem idea, a permissão de ideia não é consultada", async () => {
    propose(false);
    const spy = vi.spyOn(h.app().get(AuthorizationService), "registerIdea");
    expect((await create((await open()).id)).status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
  });

  it("falha num filho: nada é criado", async () => {
    propose(true, kids(2));
    const conv = await open();
    await rows("update ticket_conversations set draft_children = $2::jsonb where id = $1", [conv.id, JSON.stringify([{ title: "ok", description: "" }, { title: "x".repeat(300), description: "" }])]);
    const before = await count("tickets");
    expect((await create(conv.id)).status).toBeGreaterThanOrEqual(400);
    expect(await count("tickets")).toBe(before);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- corpos JSON */
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { MINUTE } from "./access-token-support.js";
import { AI_CONFIG } from "./helpers.js";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { asService } from "./service-door.js";
import { ORG, as } from "./world.js";
import type { Who } from "./world.js";
import { markProjectChanged } from "@treepm/db";
import { AgentWorkService } from "../src/tickets/agent-work.service.js";
import { TicketsService } from "../src/tickets/tickets.service.js";

// ADR 0046 (TREEPM-246): a lista de tickets do projeto é condicional pela versão do projeto. Estes testes são a guarda:
// (1) o contrato HTTP; (2) TODA escrita do inventário muda a versão; (3) leituras não mudam; (4) versão igual ⇒ lista igual,
// numa sequência aleatória de escritas com semente.
// Gancho para o teste de corrida: faz a lista esperar (depois de ler a versão) até a escrita confirmar.
const gate = vi.hoisted(() => ({ before: null as null | (() => Promise<void>) }));
vi.mock("../src/tickets/ticket-reads.js", async (original) => {
  const real = await original<Record<string, unknown> & { readSummaryRows: (...args: any[]) => Promise<unknown> }>();
  return { ...real, readSummaryRows: async (...args: any[]) => { await gate.before?.(); return real.readSummaryRows(...args); } };
});
const h = useMcpHarness(AI_CONFIG);
const P = () => h.world().projects.priv;
const listPath = () => `/api/projects/${P()}/tickets`;
type Res = request.Response;

const get = (path: string, who: Who | "outsider" = "admin", headers: Record<string, string> = {}, org = ORG): request.Test => {
  let req = request(h.app().getHttpServer()).get(path).set("x-test-session", as(who, org));
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return req;
};
const send = async (method: "post" | "put" | "patch" | "delete", path: string, who: Who, body?: unknown): Promise<Res> => {
  const req = request(h.app().getHttpServer())[method](path).set("x-test-session", as(who));
  return body === undefined ? req : req.send(body as object);
};
const ok = async (promise: Promise<Res>): Promise<any> => {
  const res = await promise;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
};
const etag = async (): Promise<string> => {
  const res = await get(listPath());
  expect(res.status).toBe(200);
  expect(res.headers["etag"], "o ETag é a versão do projeto, não um resumo do corpo").toMatch(/^W\/"v2\.\d+"$/);
  return res.headers["etag"] as string;
};
const idOf = async (n: number): Promise<string> => ((await h.pool.query("select id from tickets where project_id = $1 and number = $2", [P(), n])).rows[0]?.id as string);

async function mcpToken(): Promise<string> {
  await h.enableMcp();
  await h.pool.query("update organizations set mcp_write_enabled = true where org_id = $1", [ORG]);
  const res = await h.create("contributor", P(), { scope: "write" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
}
const mark = (id: string, input: { working: boolean; minutes?: number; note?: string }, who: Who = "contributor") =>
  asService(h.app(), who, ORG, (tx, principal) => h.app().get(AgentWorkService).set(tx, principal, id, input));

describe("contrato HTTP da lista condicional", () => {
  it("a resposta 200 traz ETag fraco e Cache-Control private, no-cache; o corpo é o de sempre", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const res = await get(listPath());
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^W\/"v2\.\d+"$/);
    expect(res.headers["cache-control"]).toBe("private, no-cache");
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);
  });

  it("If-None-Match igual: 304 sem corpo, com o mesmo ETag; diferente (ou lixo): 200 com a lista", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const tag = await etag();
    const same = await get(listPath(), "admin", { "If-None-Match": tag });
    expect(same.status).toBe(304);
    expect(same.text).toBe("");
    expect(same.headers["etag"]).toBe(tag);
    expect(same.headers["cache-control"]).toBe("private, no-cache");
    for (const stale of ['W/"v1.1"', "lixo", '"v1.1", W/"v1.2"']) {
      const res = await get(listPath(), "admin", { "If-None-Match": stale });
      expect(res.status, stale).toBe(200);
      expect(res.body).toHaveLength(4);
    }
    expect((await get(listPath(), "admin", { "If-None-Match": `W/"v1.1", ${tag}` })).status).toBe(304);
  });

  it("a conferência de permissão vem antes: quem não vê o projeto recebe 404 mesmo com o ETag certo", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const tag = await etag();
    const hidden = await get(listPath(), "plain", { "If-None-Match": tag });
    expect(hidden.status).toBe(404);
    expect(hidden.headers["etag"] ?? "").not.toMatch(/v2\./); // o 404 não revela a versão
    expect((await get(listPath(), "outsider", { "If-None-Match": tag }, "org_B")).status).toBe(404);
    expect((await get(`/api/projects/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000/tickets`, "admin", { "If-None-Match": tag })).status).toBe(404);
  });

  it("um 304 não monta a lista: com `tickets` e `ticket_assignees` travadas por inteiro, o 304 ainda responde", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const tag = await etag();
    const locker = await h.pool.connect();
    try {
      await locker.query("begin");
      await locker.query("lock table tickets, ticket_assignees in access exclusive mode");
      const timeout = new Promise<"preso">((resolve) => setTimeout(() => resolve("preso"), 4000));
      const answered = await Promise.race([get(listPath(), "admin", { "If-None-Match": tag }).then((res) => res.status), timeout]);
      expect(answered).toBe(304);
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  }, 15000);
});

describe("leituras não mudam a versão", () => {
  it("listar, detalhe, atividade, ideias, projeto e pessoas deixam o ETag igual", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const before = await etag();
    const id = await idOf(1);
    for (const path of [listPath(), `/api/tickets/${id}`, `/api/tickets/${id}/activity`, `/api/projects/${P()}/ideas`, `/api/projects/${P()}`, "/api/projects", "/api/people"]) {
      await get(path);
    }
    expect(await etag()).toBe(before);
    expect(await etag()).toBe(before);
  });

  it("escritas que não aparecem no resumo (comentário) não são obrigadas a mudar, mas a lista segue igual", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const id = await idOf(2);
    const before = (await get(listPath())).body;
    await ok(send("post", `/api/tickets/${id}/comments`, "contributor", { body: "oi" }));
    expect((await get(listPath())).body).toEqual(before);
  });
});

type Case = { name: string; prepare?: () => Promise<any>; act: (state: any) => Promise<unknown> };
const ticket = async (body: Record<string, unknown>, who: Who = "admin"): Promise<{ id: string; key: string }> => ok(send("post", listPath(), who, { title: "T", ...body }));

/** Uma etiqueta cinza "Bug" posta no ticket 3 (para renomear, trocar a cor, tirar e apagar mudarem a lista); devolve o id. */
const usedLabel = async (): Promise<string> => {
  const created = await ok(send("post", `/api/projects/${P()}/labels`, "admin", { name: "Bug", color: "gray" }));
  await ok(send("post", `/api/tickets/${await idOf(3)}/labels`, "admin", { add: [{ labelId: created.id }] }));
  return created.id as string;
};

/** O inventário (REPORT.local.md, tabela): cada escrita que muda algo do `ticketSummarySchema`. */
const CASES: Case[] = [
  { name: "criar ticket raiz", act: () => ok(send("post", listPath(), "admin", { title: "Novo" })) },
  { name: "criar ticket com responsável", act: () => ok(send("post", listPath(), "admin", { title: "Novo", assigneeIds: [h.world().people.contributor] })) },
  { name: "criar filho de um ticket concluído (reabre o pai)", act: async () => ok(send("post", listPath(), "admin", { title: "Filho", parentId: await idOf(2) })) },
  { name: "criar ideia", act: () => ok(send("post", listPath(), "admin", { title: "Ideia", idea: true })) },
  { name: "importar", act: () => ok(send("post", `${listPath()}/import`, "admin", { items: [{ title: "A", children: [{ title: "B" }] }] })) },
  { name: "importar dentro de um pai concluído", act: async () => ok(send("post", `${listPath()}/import`, "admin", { parentId: await idOf(2), items: [{ title: "A" }] })) },
  { name: "prioridade (ADR 0047)", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { priority: 2 })) },
  { name: "criar dependência (muda o lugar na fila do dependente)", act: async () => ok(send("post", `/api/tickets/${await idOf(3)}/dependencies`, "admin", { ticketId: await idOf(4) })) },
  {
    name: "remover dependência",
    prepare: async () => void (await ok(send("post", `/api/tickets/${await idOf(3)}/dependencies`, "admin", { ticketId: await idOf(4) }))),
    act: async () => ok(send("delete", `/api/tickets/${await idOf(3)}/dependencies/${await idOf(4)}`, "admin")),
  },
  {
    name: "concluir o ticket do qual outro depende",
    prepare: async () => void (await ok(send("post", `/api/tickets/${await idOf(3)}/dependencies`, "admin", { ticketId: await idOf(4) }))),
    act: async () => ok(send("patch", `/api/tickets/${await idOf(4)}`, "admin", { status: "done" })),
  },
  {
    name: "cancelar o ticket do qual outro depende",
    prepare: async () => void (await ok(send("post", `/api/tickets/${await idOf(3)}/dependencies`, "admin", { ticketId: await idOf(4) }))),
    act: async () => ok(send("patch", `/api/tickets/${await idOf(4)}`, "admin", { status: "cancelled" })),
  },
  {
    name: "remover o ticket do qual outro depende (a ligação some em cascata)",
    prepare: async () => void (await ok(send("post", `/api/tickets/${await idOf(3)}/dependencies`, "admin", { ticketId: await idOf(4) }))),
    act: async () => ok(send("delete", `/api/tickets/${await idOf(4)}`, "admin")),
  },
  { name: "título", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { title: "Outro título" })) },
  { name: "descrição (trecho)", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { description: "Outra descrição" })) },
  { name: "situação", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { status: "in_progress" })) },
  { name: "situação concluído (muda o progresso do pai)", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { status: "done" })) },
  { name: "situação que reabre o pai (propagação)", act: async () => ok(send("patch", `/api/tickets/${await idOf(2)}`, "admin", { status: "todo" })) },
  { name: "situação cancelado", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { status: "cancelled" })) },
  { name: "mudar de pai", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { parentId: await idOf(4) })) },
  { name: "tirar do pai", act: async () => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { parentId: null })) },
  { name: "atribuir pessoa", act: async () => ok(send("put", `/api/tickets/${await idOf(3)}/assignees/${h.world().people.reader}`, "admin")) },
  { name: "remover pessoa", act: async () => ok(send("delete", `/api/tickets/${await idOf(4)}/assignees/${h.world().people.contributor}`, "admin")) },
  { name: "remover ticket", act: async () => ok(send("delete", `/api/tickets/${await idOf(3)}`, "admin")) },
  {
    name: "estágio de ideia",
    prepare: async () => (await ticket({ idea: true })).id,
    act: (id) => ok(send("put", `/api/tickets/${id}/idea-stage`, "admin", { stage: "refining" })),
  },
  {
    name: "aceitar ideia",
    prepare: async () => (await ticket({ idea: true })).id,
    act: (id) => ok(send("post", `/api/tickets/${id}/idea/accept`, "admin")),
  },
  {
    name: "descartar ideia",
    prepare: async () => (await ticket({ idea: true })).id,
    act: (id) => ok(send("post", `/api/tickets/${id}/idea/discard`, "admin")),
  },
  {
    name: "reabrir ideia descartada",
    prepare: async () => {
      const t = await ticket({ idea: true });
      await ok(send("post", `/api/tickets/${t.id}/idea/discard`, "admin"));
      return t.id;
    },
    act: (id) => ok(send("put", `/api/tickets/${id}/idea-stage`, "admin", { stage: "refining" })),
  },
  { name: "transformar em ideia", act: async () => ok(send("post", `/api/tickets/${await idOf(3)}/idea`, "admin")) },
  {
    name: "mover para dentro de uma ideia",
    prepare: async () => (await ticket({ idea: true })).id,
    act: async (idea) => ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { parentId: idea })),
  },
  { name: "pôr etiqueta nova pelo nome (ADR 0065)", act: async () => ok(send("post", `/api/tickets/${await idOf(3)}/labels`, "admin", { add: [{ name: "Bug" }] })) },
  {
    name: "pôr etiqueta existente pelo id",
    prepare: async () => (await ok(send("post", `/api/projects/${P()}/labels`, "admin", { name: "Bug" }))).id as string,
    act: async (labelId) => ok(send("post", `/api/tickets/${await idOf(3)}/labels`, "admin", { add: [{ labelId }] })),
  },
  { name: "tirar etiqueta", prepare: usedLabel, act: async (labelId) => ok(send("post", `/api/tickets/${await idOf(3)}/labels`, "admin", { remove: [labelId] })) },
  { name: "renomear etiqueta usada", prepare: usedLabel, act: (labelId) => ok(send("patch", `/api/projects/${P()}/labels/${labelId}`, "admin", { name: "Defeito" })) },
  { name: "trocar a cor de etiqueta usada", prepare: usedLabel, act: (labelId) => ok(send("patch", `/api/projects/${P()}/labels/${labelId}`, "admin", { color: "rose" })) },
  { name: "apagar etiqueta usada", prepare: usedLabel, act: (labelId) => ok(send("delete", `/api/projects/${P()}/labels/${labelId}`, "admin")) },
  { name: "marcador de trabalho pela IA: ligar", act: async () => mark(await idOf(3), { working: true, note: "x" }) },
  {
    name: "marcador: renovar (muda o prazo)",
    prepare: async () => {
      const id = await idOf(3);
      await mark(id, { working: true, minutes: 30, note: "x" });
      h.clock.advance(5 * MINUTE);
      return id;
    },
    act: (id) => mark(id, { working: true, minutes: 30, note: "x" }),
  },
  {
    name: "marcador: trocar só a nota",
    prepare: async () => {
      const id = await idOf(3);
      await mark(id, { working: true, note: "um" });
      return id;
    },
    act: (id) => mark(id, { working: true, note: "dois" }),
  },
  {
    name: "marcador: outra pessoa toma",
    prepare: async () => {
      const id = await idOf(3);
      await mark(id, { working: true, note: "um" });
      return id;
    },
    act: (id) => {
      h.clock.advance(MINUTE); // o relógio de teste é fixo: sem isto o marcador novo sairia idêntico ao anterior
      return mark(id, { working: true, note: "um" }, "manager");
    },
  },
  {
    name: "marcador: desligar pela tela",
    prepare: async () => {
      const id = await idOf(3);
      await mark(id, { working: true, note: "x" });
      return id;
    },
    act: (id) => ok(send("delete", `/api/tickets/${id}/agent-work`, "admin")),
  },
  {
    name: "marcador: encerrado ao concluir o ticket",
    prepare: async () => {
      const id = await idOf(3);
      await mark(id, { working: true, note: "x" });
      return id;
    },
    act: (id) => ok(send("patch", `/api/tickets/${id}`, "admin", { status: "done" })),
  },
  {
    name: "marcador: encerrado ao arquivar o projeto",
    prepare: async () => {
      await mark(await idOf(3), { working: true, note: "x" });
    },
    act: () => ok(send("patch", `/api/projects/${P()}`, "admin", { archived: true })),
  },
  {
    name: "criação pela conversa (ticket único)",
    prepare: async () => (await ok(send("post", `/api/projects/${P()}/ticket-conversations`, "contributor", { message: "Quero corrigir o login" }))).id as string,
    act: (id) => ok(send("post", `/api/ticket-conversations/${id}/ticket`, "contributor", { placedBy: "map", parentId: null })),
  },
  {
    name: "criação pela conversa (dentro de um pai concluído)",
    prepare: async () => (await ok(send("post", `/api/projects/${P()}/ticket-conversations`, "contributor", { message: "Quero corrigir o login" }))).id as string,
    act: async (id) => ok(send("post", `/api/ticket-conversations/${id}/ticket`, "contributor", { placedBy: "map", parentId: await idOf(2) })),
  },
  {
    name: "MCP update_ticket_status",
    prepare: mcpToken,
    act: async (token: string) => {
      const res = await h.tool(token, "PRIV", "update_ticket_status", { key: "PRIV-3", status: "in_progress" });
      expect(res.isError, res.text).toBe(false);
    },
  },
  {
    name: "MCP create_ticket",
    prepare: mcpToken,
    act: async (token: string) => {
      const res = await h.tool(token, "PRIV", "create_ticket", { title: "Criado pelo MCP", parent: "PRIV-1" });
      expect(res.isError, res.text).toBe(false);
    },
  },
  {
    name: "MCP set_ticket_priority",
    prepare: mcpToken,
    act: async (token: string) => {
      const res = await h.tool(token, "PRIV", "set_ticket_priority", { key: "PRIV-3", priority: 5 });
      expect(res.isError, res.text).toBe(false);
    },
  },
  {
    name: "MCP set_agent_work (ligar)",
    prepare: mcpToken,
    act: async (token: string) => {
      const res = await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note: "mcp" });
      expect(res.isError, res.text).toBe(false);
    },
  },
  {
    name: "MCP set_agent_work (desligar)",
    prepare: async () => {
      const token = await mcpToken();
      const on = await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: true, note: "mcp" });
      expect(on.isError, on.text).toBe(false);
      return token;
    },
    act: async (token: string) => {
      const res = await h.tool(token, "PRIV", "set_agent_work", { key: "PRIV-3", working: false });
      expect(res.isError, res.text).toBe(false);
    },
  },
];

describe("toda escrita do inventário muda a versão", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const state = c.prepare ? await c.prepare() : undefined;
    const before = await etag();
    const bodyBefore = (await get(listPath())).body;
    await c.act(state);
    const after = await etag();
    const bodyAfter = (await get(listPath())).body;
    expect(bodyAfter, "o caso precisa mudar a lista de verdade").not.toEqual(bodyBefore);
    expect(after, "a versão tem de mudar").not.toBe(before);
    expect((await get(listPath(), "admin", { "If-None-Match": before })).status).toBe(200);
    expect((await get(listPath(), "admin", { "If-None-Match": after })).status).toBe(304);
  });

  it("escritas seguidas no mesmo milissegundo ainda dão versões diferentes", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const seen = new Set<string>([await etag()]);
    await Promise.all(Array.from({ length: 8 }, (_v, i) => ok(send("post", listPath(), "admin", { title: `N${i}` }))));
    seen.add(await etag());
    for (let i = 0; i < 5; i += 1) {
      await ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { title: `Título ${i}` }));
      const tag = await etag();
      expect(seen.has(tag), tag).toBe(false);
      seen.add(tag);
    }
  });
});

// Gerador com semente (mulberry32): a mesma semente repete a sequência.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("versão igual implica lista igual (sequência aleatória de escritas, com semente)", () => {
  it.each([1, 2, 3, 20261122])("semente %i", async (seed) => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const random = prng(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const byTag = new Map<string, string>();
    let writes = 0;
    const observe = async (): Promise<void> => {
      const res = await get(listPath());
      expect(res.status).toBe(200);
      const tag = res.headers["etag"] as string;
      const body = JSON.stringify(res.body);
      const known = byTag.get(tag);
      if (known === undefined) byTag.set(tag, body);
      else expect(body, `a versão ${tag} apareceu com duas listas diferentes`).toBe(known);
    };
    await observe();
    for (let step = 0; step < 70; step += 1) {
      const rows = (await get(listPath())).body as { id: string; key: string; status: string; parentId: string | null; idea: { stage: string } | null }[];
      const any = () => pick(rows).id;
      const kind = pick(["create", "child", "idea", "import", "title", "desc", "status", "move", "assign", "unassign", "delete", "stage", "accept", "discard", "transform", "mark", "unmark", "priority", "dep", "undep", "noop-get"]);
      const who: Who = "admin";
      let res: Res | undefined;
      switch (kind) {
        case "create": res = await send("post", listPath(), who, { title: `T${step}` }); break;
        case "child": res = await send("post", listPath(), who, { title: `C${step}`, parentId: any(), assigneeIds: random() < 0.3 ? [h.world().people.reader] : [] }); break;
        case "idea": res = await send("post", listPath(), who, { title: `I${step}`, idea: true, ...(random() < 0.4 ? { parentId: any() } : {}) }); break;
        case "import": res = await send("post", `${listPath()}/import`, who, { ...(random() < 0.5 ? { parentId: any() } : {}), items: [{ title: `M${step}`, children: [{ title: `N${step}` }] }] }); break;
        case "title": res = await send("patch", `/api/tickets/${any()}`, who, { title: `X${step}` }); break;
        case "desc": res = await send("patch", `/api/tickets/${any()}`, who, { description: `D${step} ${random()}` }); break;
        case "status": res = await send("patch", `/api/tickets/${any()}`, who, { status: pick(["todo", "in_progress", "in_review", "done", "cancelled"]) }); break;
        case "move": res = await send("patch", `/api/tickets/${any()}`, who, { parentId: random() < 0.2 ? null : any() }); break;
        case "assign": res = await send("put", `/api/tickets/${any()}/assignees/${pick([h.world().people.reader, h.world().people.contributor])}`, who); break;
        case "unassign": res = await send("delete", `/api/tickets/${any()}/assignees/${pick([h.world().people.reader, h.world().people.contributor])}`, who); break;
        case "delete": res = await send("delete", `/api/tickets/${any()}`, who); break;
        case "stage": res = await send("put", `/api/tickets/${any()}/idea-stage`, who, { stage: pick(["new", "refining", "ready"]) }); break;
        case "accept": res = await send("post", `/api/tickets/${any()}/idea/accept`, who); break;
        case "discard": res = await send("post", `/api/tickets/${any()}/idea/discard`, who); break;
        case "transform": res = await send("post", `/api/tickets/${any()}/idea`, who); break;
        case "mark": await mark(any(), { working: true, minutes: pick([15, 30, 60]), note: `n${step}` }, pick<Who>(["contributor", "manager"])).catch(() => undefined); writes += 1; break;
        case "priority": res = await send("patch", `/api/tickets/${any()}`, who, { priority: pick([0, 1, 2, 3]) }); break;
        case "dep": res = await send("post", `/api/tickets/${any()}/dependencies`, who, { ticketId: any() }); break;
        case "undep": res = await send("delete", `/api/tickets/${any()}/dependencies/${any()}`, who); break;
        case "unmark": res = await send("delete", `/api/tickets/${any()}/agent-work`, who); break;
        default: break;
      }
      if (res && res.status < 300) writes += 1;
      await observe();
      await observe(); // duas leituras seguidas, sem escrita no meio, são iguais
    }
    expect(writes).toBeGreaterThan(15);
    expect(byTag.size).toBeGreaterThan(10);
  });
});

const versionRow = async (): Promise<string> => String((await h.pool.query("select tickets_version::text v from projects where id = $1", [P()])).rows[0].v);
const inService = <T,>(fn: (tx: any, principal: any) => Promise<T>, who: Who = "admin") => asService(h.app(), who, ORG, fn);

describe("o toque na versão é adiado para o fim da transação (revisão 1)", () => {
  it("só depois do commit, e uma vez por transação, mesmo com três escritas no projeto", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    await h.pool.query("create table version_touch_log (at timestamptz default clock_timestamp())");
    await h.pool.query("create function version_touch_log() returns trigger language plpgsql security definer as $$ begin insert into version_touch_log default values; return new; end $$");
    await h.pool.query("create trigger version_touch_log after update on projects for each row execute function version_touch_log()");
    try {
      const before = await versionRow();
      let duringCommit = "";
      await inService(async (tx, principal) => {
        const tickets = h.app().get(TicketsService);
        for (const n of [2, 3, 4]) await tickets.updateTicket(tx, principal, await idOf(n), { title: `Novo ${n}` });
        duringCommit = await versionRow(); // outra conexão, antes de confirmar
      });
      expect(duringCommit).toBe(before);
      expect(await versionRow()).not.toBe(before);
      expect((await h.pool.query("select count(*)::int n from version_touch_log")).rows[0].n).toBe(1);
    } finally {
      await h.pool.query("drop table if exists version_touch_log cascade");
      await h.pool.query("drop function if exists version_touch_log() cascade");
    }
  });

  it("transação que falha não muda a versão", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const before = await versionRow();
    await expect(
      inService(async (tx, principal) => {
        await h.app().get(TicketsService).updateTicket(tx, principal, await idOf(3), { title: "Vai desfazer" });
        throw new Error("falha depois da escrita");
      }),
    ).rejects.toThrow("falha depois da escrita");
    expect(await versionRow()).toBe(before);
    expect((await h.pool.query("select title from tickets where project_id = $1 and number = 3", [P()])).rows[0].title).not.toBe("Vai desfazer");
  });

  it("uma transação longa que já escreveu num ticket NÃO bloqueia a situação de outro ticket do mesmo projeto", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => {};
    const writing = new Promise<void>((resolve) => (started = resolve));
    const long = inService(async (tx, principal) => {
      await h.app().get(TicketsService).updateTicket(tx, principal, await idOf(3), { title: "Escrita longa" });
      started();
      await held; // ainda não confirmou
    });
    await writing;
    const timeout = new Promise<"preso">((resolve) => setTimeout(() => resolve("preso"), 5000));
    const other = await Promise.race([send("patch", `/api/tickets/${await idOf(4)}`, "admin", { status: "in_progress" }).then((res) => res.status), timeout]);
    release();
    await long;
    expect(other).toBe(200);
  }, 20000);

  it("com uma escrita confirmando entre a leitura da versão e a da lista: a lista nunca é mais velha que o ETag, e a versão antiga recebe 200 depois", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const v0 = await etag();
    gate.before = async () => {
      gate.before = null;
      await ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { title: "Mudou no meio" }));
    };
    const during = await get(listPath());
    expect(during.headers["etag"]).toBe(v0); // lido antes da escrita
    expect(during.body.find((t: any) => t.number === 3).title).toBe("Mudou no meio"); // a lista é mais nova, nunca mais velha
    const again = await get(listPath(), "admin", { "If-None-Match": v0 });
    expect(again.status).toBe(200); // o cliente que guardou v0 pede de novo, e não recebe 304
    expect(again.headers["etag"]).not.toBe(v0);
    expect(again.body.find((t: any) => t.number === 3).title).toBe("Mudou no meio");
  });
});

describe("criação pela conversa com grupo e com filhos do rascunho (inventário, revisão 1)", () => {
  it("createParentAndMove: o agrupador novo muda a versão", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const id = (await ok(send("post", `/api/projects/${P()}/ticket-conversations`, "contributor", { message: "Quero corrigir o login" }))).id as string;
    const before = await etag();
    await ok(send("post", `/api/ticket-conversations/${id}/ticket`, "contributor", { placedBy: "map", parentId: null, group: { title: "Grupo", description: "d", ticketIds: [await idOf(4)] } }));
    expect(await etag()).not.toBe(before);
  });

  it("filhos do rascunho: criar o ticket e os filhos muda a versão", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const id = (await ok(send("post", `/api/projects/${P()}/ticket-conversations`, "contributor", { message: "Quero corrigir o login" }))).id as string;
    await ok(send("patch", `/api/ticket-conversations/${id}/draft`, "contributor", { title: "Corrigir login", description: "d", children: [{ title: "Parte 1", description: "a" }, { title: "Parte 2", description: "b" }] }));
    const before = await etag();
    await ok(send("post", `/api/ticket-conversations/${id}/ticket`, "contributor", { placedBy: "map", parentId: null }));
    expect(await etag()).not.toBe(before);
    expect(((await get(listPath())).body as unknown[]).length).toBe(7);
  });
});

describe("a versão é um contador próprio, sem relógio (revisão 2, item 3)", () => {
  it("renomear o projeto, mexer em updated_at e recuar o relógio não mudam o ETag; o contador só sobe com escrita de ticket", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const before = await etag();
    await ok(send("patch", `/api/projects/${P()}`, "admin", { name: "Outro nome" }));
    await h.pool.query("update projects set updated_at = updated_at - interval '1 hour' where id = $1", [P()]);
    expect(await etag()).toBe(before);
    await ok(send("patch", `/api/tickets/${await idOf(3)}`, "admin", { title: "Mudou" }));
    const after = await etag();
    expect(after).toBe(`W/"v2.${BigInt(before.match(/v2\.(\d+)/)![1]!) + 1n}"`);
  });
});

// Dois clientes em ordem forçada: B lê o ticket (sem trava), espera a trava de linha do ticket que o dono segura; o dono confirma
// uma escrita que muda o resultado; B então grava e TEM de marcar a versão (a decisão de marcar não pode usar a leitura de antes).
async function forcedOrder(setup: () => Promise<string>, request: (id: string) => Promise<Res>, ownerWrite: (id: string, owner: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>): Promise<{ tagAfterOwner: string; tagAfterB: string; res: Res }> {
  const id = await setup();
  const owner = await h.pool.connect();
  try {
    await owner.query("begin");
    await owner.query("select id from tickets where id = $1 for update", [id]);
    const pending = request(id);
    await new Promise((resolve) => setTimeout(resolve, 600)); // B leu o ticket e está esperando a linha
    await ownerWrite(id, owner);
    await owner.query("update projects set tickets_version = tickets_version + 1 where id = $1", [P()]);
    await owner.query("commit");
    const tagAfterOwner = await etag();
    const res = await pending;
    return { tagAfterOwner, tagAfterB: await etag(), res };
  } finally {
    await owner.query("rollback").catch(() => undefined);
    owner.release();
  }
}

describe("a decisão de marcar usa o que foi lido depois da trava (revisão 2, item 1)", () => {
  it("estágio de ideia: B pede `new` com a tela velha, A confirma `refining` no meio: B grava `new` e a versão muda", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const result = await forcedOrder(
      async () => (await ticket({ idea: true })).id,
      (id) => send("put", `/api/tickets/${id}/idea-stage`, "admin", { stage: "new" }),
      async (id, owner) => void (await owner.query("update tickets set idea_stage = 'refining' where id = $1", [id])),
    );
    expect(result.res.status, JSON.stringify(result.res.body)).toBe(200);
    expect(result.tagAfterB).not.toBe(result.tagAfterOwner);
  });

  it("marcador de IA: o desligar lê `sem marcador`, um `set` confirma no meio, a limpeza apaga e a versão muda", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const id = await idOf(3);
    const before = await etag();
    await asService(h.app(), "admin", ORG, async (tx, principal) => {
      // Depois da leitura sem trava do ticket (sem marcador), outra conexão liga o marcador e confirma.
      const racing = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== "ticket") return value;
          return new Proxy(value as object, {
            get(model, method) {
              const fn = Reflect.get(model, method) as (...args: unknown[]) => Promise<unknown>;
              if (method !== "findFirst") return fn;
              return async (...args: unknown[]) => {
                const found = await fn.apply(model, args);
                if (!raced) {
                  raced = true;
                  await h.pool.query("update tickets set agent_work_started_at = now(), agent_work_until = now() + interval '1 hour', agent_work_person_id = $2, agent_work_note = '' where id = $1", [id, h.world().people.contributor]);
                  await h.pool.query("update projects set tickets_version = tickets_version + 1 where id = $1", [P()]);
                }
                return found;
              };
            },
          });
        },
      });
      let raced = false;
      await h.app().get(AgentWorkService).endByPerson(racing as typeof tx, principal, id);
    });
    expect((await h.pool.query("select agent_work_until from tickets where id = $1", [id])).rows[0].agent_work_until).toBeNull();
    const afterSet = `W/"v2.${BigInt(before.match(/v2\.(\d+)/)![1]!) + 1n}"`;
    expect(await etag(), "a limpeza que apagou o marcador tem de marcar a versão").not.toBe(afterSet);
  });
});

describe("criar e importar travam as linhas de tickets ANTES da reserva de número (revisão 2, item 2)", () => {
  // A cria um ticket já concluído dentro de um pai (não reabre; o FK pega `for key share` no pai) / com menção a PRIV-4; B tem
  // `for update` no ticket e depois toca a versão. Antes da correção A segurava a linha do projeto e B esperava por ela: impasse.
  const holdAndFire = async (fire: () => Promise<Res>, lockedNumber: number): Promise<{ res: Res; ownerFailed: boolean }> => {
    const lockedId = await idOf(lockedNumber);
    const owner = await h.pool.connect();
    let ownerFailed = false;
    try {
      await owner.query("begin");
      await owner.query("select id from tickets where id = $1 for update", [lockedId]); // B já tem a linha do ticket
      const a = fire(); // A pega o que precisar do ticket e fica esperando por ele
      await new Promise((resolve) => setTimeout(resolve, 800));
      try {
        await owner.query("update projects set tickets_version = tickets_version + 1 where id = $1", [P()]); // o toque final de B
        await owner.query("commit");
      } catch {
        ownerFailed = true; // impasse: o PostgreSQL abortou B
      }
      return { res: await a, ownerFailed };
    } finally {
      await owner.query("rollback").catch(() => undefined);
      owner.release();
    }
  };

  it("criação concluída dentro de um pai (FK no pai) com B segurando o pai", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const { res, ownerFailed } = await holdAndFire(async () => send("post", listPath(), "admin", { title: "Filho concluído", parentId: await idOf(3), status: "done" }), 3);
    expect(ownerFailed).toBe(false);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });

  it("criação com menção a um ticket que B tem travado: as duas respondem 2xx", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const { res, ownerFailed } = await holdAndFire(() => send("post", listPath(), "admin", { title: "Cita", description: "Ver PRIV-3" }), 3);
    expect(ownerFailed).toBe(false);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });

  it("importação com menção ao ticket que B tem travado", async () => {
    await seedProject(h.pool, P(), h.world().people.manager, h.world().people.contributor);
    const { res, ownerFailed } = await holdAndFire(() => send("post", `${listPath()}/import`, "admin", { items: [{ title: "Cita", description: "Ver PRIV-3" }] }), 3);
    expect(ownerFailed).toBe(false);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  });
});

describe("duas versões marcadas na mesma transação (revisão 3)", () => {
  it("o toque final sobe os dois projetos, uma vez cada, sem cruzar com outra transação que marca os mesmos em outra ordem", async () => {
    const [a, b] = [h.world().projects.priv, h.world().projects.org];
    const read = async (id: string) => String((await h.pool.query("select tickets_version::text v from projects where id = $1", [id])).rows[0].v);
    const before = [await read(a), await read(b)];
    await Promise.all([
      inService(async () => { markProjectChanged(a); markProjectChanged(b); await new Promise((r) => setTimeout(r, 200)); }),
      inService(async () => { markProjectChanged(b); markProjectChanged(a); await new Promise((r) => setTimeout(r, 200)); }),
    ]);
    expect([await read(a), await read(b)]).toEqual([String(Number(before[0]) + 2), String(Number(before[1]) + 2)]);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto das requisições */
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ClaudeProjectAnswerer } from "../src/assistant/claude-project-answerer.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import type { ToolExecutor } from "../src/assistant/ports.js";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG);
const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const openTransactions = async () =>
  (await rows("select count(*)::int as n from pg_stat_activity where usename = 'treepm_app' and state like 'idle in transaction%'"))[0].n as number;

const ask = (projectId: string, body: unknown = { question: "Quantos tickets?", history: [] }, who: Who | "outsider" = "contributor", org = "org_A") =>
  h.call("POST", `/api/projects/${projectId}/assistant/ask`, as(who, org), body);
const priv = () => h.world().projects.priv;

/** Árvore do projeto PRIV (tickets 1 a 7) com descrições, ligações e responsáveis semeados. */
async function seed(): Promise<void> {
  await seedTree(h.pool, h.world());
  const w = h.world();
  await h.pool.query("update tickets set title = 'SSO (ver PRIV-4)' where project_id = $1 and number = 3", [priv()]);
  await h.pool.query("update tickets set description = 'Depende de PRIV-2 e menciona PRIV-3. Ver também OPEN-9. Fica em PRIV-4.' where project_id = $1 and number = 4", [priv()]);
  const id = async (n: number) => (await rows("select id from tickets where project_id = $1 and number = $2", [priv(), n]))[0].id as string;
  const rel = (from: number, to: number, kind: string) =>
    id(from).then(async (f) =>
      h.pool.query("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ('org_A',$1,$2,$3,$4)", [priv(), f, await id(to), kind]),
    );
  await rel(4, 2, "depends_on");
  await rel(4, 3, "mentions");
  await rel(5, 4, "mentions");
  for (const [n, person] of [[4, w.people.manager], [4, w.people.admin], [3, w.people.manager]] as const) {
    await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ('org_A',$1,$2)", [await id(n), person]);
  }
}

describe("POST /projects/:projectId/assistant/ask", () => {
  it("devolve só { text, model } e a chave real no lugar do rótulo (T que não existe fica como veio)", async () => {
    await seed();
    h.answerer().script = async () => "**T4** depende de T2 e T3, não de T999 nem de RT4.";
    const res = await ask(priv());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "**PRIV-4** depende de PRIV-2 e PRIV-3, não de T999 nem de RT4.", model: "fake-model" });
  });

  it("a pergunta e a conversa chegam ao respondedor em rótulos neutros; chaves de outro projeto ficam", async () => {
    await seed();
    const history = [
      { author: "person", body: "O que é PRIV-4? E OPEN-9?" },
      { author: "assistant", body: "PRIV-4 é SAML." },
    ];
    await ask(priv(), { question: "  E o PRIV-7?  ", history });
    expect(h.answerer().calls).toEqual([
      {
        question: "E o T7?",
        history: [
          { author: "person", body: "O que é T4? E OPEN-9?" },
          { author: "assistant", body: "T4 é SAML." },
        ],
      },
    ]);
  });

  it("corpo: pergunta de 1 a 2.000 (depois de aparar), conversa de 0 a 20 mensagens de até 8.000 caracteres", async () => {
    await seed();
    const msg = (n: number) => Array.from({ length: n }, (_, i) => ({ author: i % 2 ? "assistant" : "person", body: "m" }));
    for (const body of [
      { question: "x" },
      { question: "x".repeat(2000), history: [] },
      { question: "x", history: msg(20) },
      { question: "x", history: [{ author: "person", body: "y".repeat(8000) }] },
    ]) {
      expect((await ask(priv(), body)).status, JSON.stringify(body).slice(0, 50)).toBe(200);
    }
    for (const body of [
      {},
      { question: "" },
      { question: "   " },
      { question: "x".repeat(2001) },
      { question: "x", history: msg(21) },
      { question: "x", history: [{ author: "person", body: "y".repeat(8001) }] },
      { question: "x", history: [{ author: "system", body: "y" }] },
      { question: "x", history: [{ author: "person" }] },
      { question: "x", history: "oi" },
      { question: "x", extra: 1 },
      { question: 1 },
    ]) {
      expect((await ask(priv(), body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await ask("não-é-id")).status).toBe(400);
  });

  it("resposta vazia ou acima de 8.000 caracteres (já com as chaves reais): 503 assistant_unavailable", async () => {
    await seed();
    for (const text of [" ", "x".repeat(8001), "T4 ".repeat(2667)]) {
      h.answerer().script = async () => text;
      const res = await ask(priv());
      expect(res.status, text.slice(0, 10)).toBe(503);
      expect(errorOf(res)).toBe("assistant_unavailable");
    }
  });

  it("falha do provedor: 503 assistant_unavailable", async () => {
    await seed();
    h.answerer().fail = true;
    const res = await ask(priv());
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_unavailable");
  });

  it("não grava nada nem cria evento (compara antes e depois, com ferramentas executadas)", async () => {
    await seed();
    const snapshot = async () => ({
      tickets: await rows("select * from tickets order by id"),
      relations: await rows("select * from ticket_relations order by id"),
      assignees: await rows("select * from ticket_assignees order by ticket_id, person_id"),
      projects: await rows("select * from projects order by id"),
      events: (await rows("select count(*)::int as n from activity_events"))[0].n as number,
      summaries: (await rows("select count(*)::int as n from branch_summaries"))[0].n as number,
    });
    const before = await snapshot();
    h.answerer().script = async ({ tools }) => {
      for (const [name, input] of [["search_tickets", { query: "SAML" }], ["read_ticket", { ticket: "T4" }], ["list_tickets", {}], ["project_overview", {}]] as const) {
        await tools.execute(name, input);
      }
      return "ok";
    };
    expect((await ask(priv())).status).toBe(200);
    h.answerer().fail = true;
    await ask(priv());
    expect(await snapshot()).toEqual(before);
  });

  it("não há transação aberta enquanto a IA responde, nem entre uma ferramenta e outra", async () => {
    await seed();
    const during: number[] = [];
    h.answerer().onCall = async () => void during.push(await openTransactions());
    h.answerer().script = async ({ tools }) => {
      await tools.execute("project_overview", {});
      during.push(await openTransactions());
      await tools.execute("read_ticket", { ticket: "T1" });
      during.push(await openTransactions());
      return "ok";
    };
    await ask(priv());
    expect(during).toEqual([0, 0, 0]);
  });
});

describe("permissões", () => {
  it.each(["admin", "manager", "contributor", "reader"] as Who[])("%s pergunta (leitor também)", async (who) => {
    await seed();
    expect((await ask(priv(), undefined, who)).status).toBe(200);
  });

  it("quem não vê o projeto, outra organização e inexistente: o mesmo 404, sem chamar a IA", async () => {
    await seed();
    for (const who of ["plain", "teamAdmin"] as Who[]) expect((await ask(priv(), undefined, who)).status, who).toBe(404);
    expect((await ask(priv(), undefined, "outsider", "org_B")).status).toBe(404);
    expect((await ask(h.world().other.project, undefined, "contributor")).status).toBe(404);
    expect((await ask(UNKNOWN_ID)).status).toBe(404);
    expect(h.answerer().calls).toHaveLength(0);
  });

  it("projeto aberto à organização: qualquer pessoa da organização pergunta; arquivado também", async () => {
    await seed();
    expect((await ask(h.world().projects.org, undefined, "plain")).status).toBe(200);
    await h.pool.query("update projects set archived_at = now() where id = $1", [priv()]);
    expect((await ask(priv())).status).toBe(200);
  });

  it("as ferramentas só enxergam o projeto da pergunta (ticket de outro projeto não existe para elas)", async () => {
    await seed();
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,1,'SEGREDO-DO-ABERTO',$2)", [h.world().projects.org, h.world().people.admin]);
    const seen: string[] = [];
    h.answerer().script = async ({ tools }) => {
      seen.push((await tools.execute("search_tickets", { query: "SEGREDO" })).content);
      seen.push((await tools.execute("list_tickets", {})).content);
      return "ok";
    };
    await ask(priv());
    expect(seen.join("")).not.toContain("SEGREDO");
  });
});

describe("com a IA desligada a rota responde como as demais do assistente", () => {
  const off = useHarness(TEST_CONFIG);
  it("503 assistant_not_configured", async () => {
    const res = await off.call("POST", `/api/projects/${UNKNOWN_ID}/assistant/ask`, as("contributor"), { question: "x", history: [] });
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_not_configured");
  });
});

describe("as ferramentas", () => {
  const run = async (name: string, input: unknown) => {
    let out: { content: string; isError: boolean } | null = null;
    h.answerer().script = async ({ tools }) => {
      out = await tools.execute(name, input);
      return "ok";
    };
    expect((await ask(priv())).status).toBe(200);
    return out as unknown as { content: string; isError: boolean };
  };
  const json = async (name: string, input: unknown) => {
    const out = await run(name, input);
    expect(out.isError, out.content).toBe(false);
    return JSON.parse(out.content);
  };
  const FORBIDDEN_KEYS = ["id", "key", "number", "parentId", "projectKey", "descriptionExcerpt"];
  const keysDeep = (value: unknown): string[] =>
    Array.isArray(value) ? value.flatMap(keysDeep) : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];

  it("read_ticket: rótulo, descrição inteira, pai, caminho, filhos e ligações; sem id, chave, número nem parentId", async () => {
    await seed();
    const t = await json("read_ticket", { ticket: "T4" });
    expect(t).toMatchObject({
      label: "T4",
      title: "SAML",
      status: "todo",
      description: "Depende de T2 e menciona T3. Ver também OPEN-9. Fica em T4.",
      parent: "T3",
      path: [
        { label: "T1", title: "Auth", parent: null },
        { label: "T3", title: "SSO (ver T4)", parent: "T1" },
      ],
    });
    expect(t.children).toEqual({ tickets: [], truncated: false });
    expect(t.relations.depends_on.outgoing.tickets.map((x: any) => x.label)).toEqual(["T2"]);
    expect(t.relations.depends_on.outgoing.tickets[0].parent).toBe("T1");
    expect(t.relations.mentions.outgoing.tickets.map((x: any) => x.label)).toEqual(["T3"]);
    expect(t.relations.mentions.incoming.tickets.map((x: any) => x.label)).toEqual(["T5"]);
    expect(t.relations.depends_on.incoming).toEqual({ tickets: [], truncated: false });
    expect(keysDeep(t).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });

  it("read_ticket aceita rótulo com espaços em volta; search_tickets, list_tickets e project_overview devolvem resumos reduzidos", async () => {
    await seed();
    expect((await json("read_ticket", { ticket: " T1 " })).label).toBe("T1");
    const found = await json("search_tickets", { query: "SAML" });
    expect(found.tickets[0]).toMatchObject({ label: "T4", title: "SAML", status: "todo", parent: "T3" });
    expect(found.truncated).toBe(false);
    const list = await json("list_tickets", { status: ["todo"], under: "T1" });
    expect(list.tickets.map((x: any) => x.label)).toEqual(["T2", "T3", "T4"]);
    expect(list.tickets[0].parent).toBe("T1");
    const overview = await json("project_overview", {});
    expect(overview.total).toBe(7);
    expect(overview.by_status).toMatchObject({ todo: 7, done: 0 });
    expect(overview.top.tickets.map((x: any) => x.label)).toEqual(["T1", "T5", "T7"]);
    expect(overview.top.tickets[0]).toMatchObject({ title: "Auth", parent: null, progress: { done: 0, total: 3, excluded: 0 } });
    for (const out of [found, list, overview]) expect(keysDeep(out).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });

  it("list_tickets pagina por rótulo: truncated e after", async () => {
    await seed();
    const first = await json("list_tickets", { limit: 3 });
    expect(first.tickets.map((x: any) => x.label)).toEqual(["T1", "T2", "T3"]);
    expect(first).toMatchObject({ truncated: true, after: "T3" });
    const next = await json("list_tickets", { limit: 3, after: first.after });
    expect(next.tickets.map((x: any) => x.label)).toEqual(["T4", "T5", "T6"]);
    const last = await json("list_tickets", { after: "T6" });
    expect(last).toMatchObject({ truncated: false, after: null });
    expect(last.tickets.map((x: any) => x.label)).toEqual(["T7"]);
  });

  it.each([
    ["read_ticket", { ticket: "PRIV-4" }],
    ["read_ticket", { ticket: "4" }],
    ["read_ticket", { ticket: "T0" }],
    ["read_ticket", { ticket: "T999" }],
    ["read_ticket", {}],
    ["read_ticket", { ticket: "T4", extra: 1 }],
    ["list_tickets", { status: ["feito"] }],
    ["list_tickets", { status: "todo" }],
    ["list_tickets", { under: "T999" }],
    ["list_tickets", { under: "PRIV-1" }],
    ["list_tickets", { limit: 100000 }],
    ["list_tickets", { limit: 0 }],
    ["list_tickets", { after: "x" }],
    ["search_tickets", { query: "" }],
    ["search_tickets", { query: "x", limit: 51 }],
    ["search_tickets", {}],
    ["project_overview", { x: 1 }],
    ["apagar_tudo", {}],
  ])("entrada inválida do modelo (%s %j) volta como resultado com erro, sem derrubar a pergunta", async (name, input) => {
    await seed();
    const out = await run(name, input);
    expect(out.isError).toBe(true);
    expect(out.content.length).toBeGreaterThan(5);
    expect(out.content.length).toBeLessThan(300);
    expect(out.content).not.toMatch(/PRIV|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});

describe("o teto do que sai para a Anthropic", () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  const scripted = (turns: Record<string, unknown>[], captured: string[]): ClaudeStreamer =>
    (async (params: Record<string, unknown>) => {
      captured.push(JSON.stringify(params));
      return turns[captured.length - 1];
    }) as unknown as ClaudeStreamer;
  const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
  const turn = (content: unknown[], stop = "end_turn") => ({ stop_reason: stop, parsed_output: null, model: "claude-opus-5-5", content });

  it("conversa roteirizada com as quatro ferramentas: nada de id, chave do projeto, chave de ticket, nome nem e-mail em tudo o que é entregue ao provedor", async () => {
    await seed();
    const captured: string[] = [];
    h.answerer().delegate = new ClaudeProjectAnswerer(
      scripted(
        [
          turn([use("a", "search_tickets", { query: "SAML" }), use("b", "project_overview", {})], "tool_use"),
          turn([use("c", "read_ticket", { ticket: "T4" }), use("d", "list_tickets", { under: "T1", status: ["todo"] }), use("e", "read_ticket", { ticket: "T3" })], "tool_use"),
          turn([{ type: "text", text: "T4 depende de T2 e fica em T3. T999 não existe." }]),
        ],
        captured,
      ),
    );
    const res = await ask(priv(), {
      question: "O que PRIV-4 precisa? E quem cuida dele?",
      history: [
        { author: "person", body: "Quem é o responsável por PRIV-4?" },
        { author: "assistant", body: "Não tenho acesso a pessoas; veja PRIV-4." },
      ],
    });
    expect(res.body).toEqual({ text: "PRIV-4 depende de PRIV-2 e fica em PRIV-3. T999 não existe.", model: "claude-opus-5-5" });

    expect(captured).toHaveLength(3);
    const sent = captured.join("\n");
    // o que tem de estar lá, para o teste ter o que achar se vazar
    expect(sent).toContain("T4");
    expect(sent).toContain("Depende de T2 e menciona T3");
    expect(sent).toContain("OPEN-9");
    const leaks = [
      ["uuid", UUID],
      ["chave do projeto", /PRIV/],
      ["chave de ticket do projeto", /PRIV-\d/],
      ["nome de pessoa", /Nome (admin|manager|contributor|reader|plain|target|teamAdmin)/],
      ["e-mail", /@exemplo\.test|@/],
      ["usuário de login", /u_(admin|manager)/],
      ["papel de pessoa", /manager|contributor/],
      ["organização", /org_[AB]/],
    ] as const;
    for (const [what, pattern] of leaks) expect(pattern.test(sent), what).toBe(false);
    // as definições de ferramenta e o sistema também foram conferidos: estão em cada requisição
    expect(JSON.parse(captured[0]!).tools).toHaveLength(4);
  });

  it("o detector acha o que procura (controle negativo)", async () => {
    await seed();
    const raw = JSON.stringify(await rows("select t.id, 'PRIV-4' as k, p.display_name, p.email from tickets t, people p where p.clerk_user_id = 'u_manager' limit 1"));
    expect(UUID.test(raw) && /PRIV-\d/.test(raw) && /Nome manager/.test(raw) && /@exemplo\.test/.test(raw)).toBe(true);
  });

  it("nada da pergunta, da conversa, dos resultados nem da resposta vai ao log", async () => {
    await seed();
    const lines: string[] = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(String(message)));
    }
    h.answerer().delegate = new ClaudeProjectAnswerer(
      scripted([turn([use("a", "read_ticket", { ticket: "T4" })], "tool_use"), turn([{ type: "text", text: "RESPOSTA-SECRETA sobre T4 e SAML" }])], []),
    );
    await ask(priv(), { question: "PERGUNTA-SECRETA PRIV-4", history: [{ author: "person", body: "CONVERSA-SECRETA" }] });
    const logged = lines.join("\n");
    vi.restoreAllMocks();
    expect(logged).toMatch(/model=claude-opus-5-5/);
    for (const secret of ["PERGUNTA-SECRETA", "CONVERSA-SECRETA", "RESPOSTA-SECRETA", "SAML", "Depende de", "PRIV", "Auth"]) expect(logged).not.toContain(secret);
  });

  it("ToolExecutor é só a interface: o adaptador não importa o banco", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("../src/assistant/claude-project-answerer.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@treepm\/db|prisma|TenantClient|query\/project-query/i);
    const _typecheck: ToolExecutor | null = null;
    expect(_typecheck).toBeNull();
  });
});

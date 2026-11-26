import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeHistoryNode, historyIssues, useLinearHarness } from "./linear-support.js";
import type { FakeHistoryAsk, FakeHistoryEntry, FakeTeamData } from "./linear-support.js";
import type { LinearReply } from "./linear-fake-fetch.js";
import { CATEGORIZE_CONFIG, categorizeAll, importedProject, linearTeam, runImport, wireFakes } from "./linear-categorize-support.js";
import type { Row } from "./linear-categorize-support.js";
import { as } from "./world.js";

// Privacidade do histórico trazido do Linear (ADR 0061, fatia 4; TREEPM-482), etapa 7: nada do histórico (nomes de autor, nomes de
// coluna, títulos antigos, ids do Linear) vai a Anthropic, TypeSafe ou Voyage; nenhum e-mail do Linear em tabela, resposta, evento ou
// log, inclusive nos caminhos de erro. Sentinelas improváveis, procuradas em tudo.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;
const open = () => h.world().projects.org;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
type RunBody = Record<string, unknown> & { id?: string; done?: boolean; phase?: string; counts?: Record<string, number | boolean>; waitUntil?: string | null };

const AUTHOR = "Autora Sentinela Teodolinda";
const COLUMN = "Coluna Sentinela Brumadinho";
const OLD_TITLE = "Título Sentinela Xiquexique";
const NEW_TITLE = "Outro Sentinela Pindamonhangaba";
const ASSIGNEE = "Responsável Sentinela Quixeramobim";
const BOT = "Robô Sentinela Itaquaquecetuba";
const EMAILS = { author: "autora.sentinela@linear.test", from: "de.sentinela@linear.test", to: "para.sentinela@linear.test", named: "nome.sentinela@linear.test" };
const ADMIN = { id: "u-sentinela-admin", name: "Admin Sentinela", email: "admin@exemplo.test" };
const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 3, day, 10, minute)).toISOString();

/** a1: as sentinelas (autor de fora, responsáveis de/para com e-mail, robô, autor com nome em forma de e-mail, autor casado); a2: 25 (página extra). */
const HISTORY = (): Record<string, FakeHistoryEntry[]> => ({
  a1: [
    { id: "hsent-6", createdAt: at(6), actor: ADMIN, fromState: { id: "st-sentinela-1", name: COLUMN, type: "unstarted" }, toState: { id: "st-sentinela-2", name: `${COLUMN} 2`, type: "started" } },
    { id: "hsent-5", createdAt: at(5), actor: { id: "u-sentinela-autora", name: AUTHOR, email: EMAILS.author }, fromTitle: OLD_TITLE, toTitle: NEW_TITLE },
    { id: "hsent-4", createdAt: at(4), actor: { id: "u-sentinela-autora", name: AUTHOR, email: EMAILS.author }, fromAssignee: { id: "u-sentinela-de", name: ASSIGNEE, email: EMAILS.from }, toAssignee: { id: "u-sentinela-para", name: `${ASSIGNEE} 2`, email: EMAILS.to } },
    { id: "hsent-3", createdAt: at(3), bot: BOT, fromPriority: 1, toPriority: 3 },
    { id: "hsent-2", createdAt: at(2), actor: { id: "u-sentinela-nome", name: EMAILS.named, email: EMAILS.named }, toAssignee: { id: "u-sentinela-nome", name: EMAILS.named, email: EMAILS.named }, updatedDescription: true },
    { id: "hsent-1", createdAt: at(1), actor: null, fromParentId: "issue-sentinela-fora", toParentId: "a2" },
  ],
  a2: Array.from({ length: 25 }, (_, i) => ({ id: `hsent-a2-${25 - i}`, createdAt: at(1, 25 - i), actor: { id: "u-sentinela-autora", name: AUTHOR, email: EMAILS.author }, updatedDescription: true })),
});
const ALL_EMAILS = Object.values(EMAILS);

/** Tudo o que o banco guarda, como texto (cada tabela do esquema público). */
async function wholeDatabase(): Promise<string> {
  const tables = (await q("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).map((row) => row["table_name"] as string);
  const parts: string[] = [];
  for (const table of tables) parts.push(String((await q(`select coalesce(string_agg(t::text, ' '), '') as dump from "${table}" t`))[0]?.["dump"] ?? ""));
  return parts.join("\n");
}
const ticketOf = async (issue: string): Promise<string> => (await q("select ticket_id from ticket_external_refs where external_id = $1 and kind = 'issue'", [issue]))[0]!["ticket_id"] as string;

/**
 * O harness cria a aplicação com `logger: false`: espia o `Logger` do Nest (o que o filtro de erros e os serviços chamam, mesmo desligado),
 * `console` e, por garantia, a saída padrão e a de erro.
 */
const captureLogs = (): string[] => {
  const lines: string[] = [];
  const text = (args: unknown[]) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  for (const method of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(`${method}: ${text(args)}`));
  for (const method of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(`console.${method}: ${text(args)}`));
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => (lines.push(String(chunk)), true)) as never);
  return lines;
};

describe("histórico importado não vai a provedor de IA", () => {
  afterEach(() => vi.restoreAllMocks());
  it("importa, sincroniza, abre os tickets, categoriza: os provedores nunca veem autor, coluna, título antigo, id nem e-mail do histórico", async () => {
    wireFakes(s);
    const lines = captureLogs();
    const data = linearTeam();
    data.history = HISTORY();
    await importedProject(s, open(), { data });
    // Uma sincronização depois, com entrada nova (o autor de fora renomeia de novo).
    data.issues = data.issues.map((issue) => (issue.id === "a1" ? { ...issue, updatedAt: new Date().toISOString() } : issue));
    data.history.a1 = [{ id: "hsent-7", createdAt: at(7), actor: { id: "u-sentinela-autora", name: AUTHOR, email: EMAILS.author }, fromTitle: NEW_TITLE, toTitle: "Alfa um" }, ...(data.history.a1 ?? [])];
    h.linear().calls.length = 0;
    const responses: unknown[] = [await runImport(s, open())];
    expect(h.linear().calls.some((call) => call.query.includes("TeamHistory") && /actor \{ id name email \}/.test(call.query))).toBe(true);
    for (const issue of ["a1", "a2"]) {
      const ticket = await ticketOf(issue);
      responses.push((await h.call("GET", `/api/tickets/${ticket}/activity`, as("admin"))).body, (await h.call("GET", `/api/tickets/${ticket}`, as("admin"))).body);
    }
    const view = await categorizeAll(s, open());
    expect(view.finished).toBe(true);

    // A varredura vê o dado: o histórico está no banco e na linha do tempo; um autor casou pelo e-mail.
    const stored = JSON.stringify(await q("select * from external_history_entries"));
    for (const seen of [AUTHOR, COLUMN, OLD_TITLE, ASSIGNEE, BOT]) expect(stored, seen).toContain(seen);
    expect(JSON.stringify(responses)).toContain(OLD_TITLE);
    expect((await q("select actor_person_id from external_history_entries where external_id = 'hsent-6'"))[0]).toEqual({ actor_person_id: h.world().people.admin });
    expect(Number((await q("select count(*)::int n from external_history_entries"))[0]!["n"])).toBe(32);

    // O que foi aos provedores (juiz, relacionados, afinidade, nomeador, vetores, conversa).
    const embedded = h.embedder().calls.flatMap((call) => call.texts);
    const sent = JSON.stringify([h.judge().calls, h.related().calls, h.affinity().calls, h.namer().calls, h.conversation().calls, embedded]);
    expect(sent.length).toBeGreaterThan(500);
    for (const forbidden of ["Teodolinda", "Brumadinho", "Xiquexique", "Pindamonhangaba", "Quixeramobim", "Itaquaquecetuba", "hsent", "st-sentinela", "u-sentinela", "issue-sentinela", ...ALL_EMAILS]) expect(sent, forbidden).not.toContain(forbidden);
    expect(sent).not.toMatch(/sentinela/i);

    // E-mails: nem no banco, nem nas respostas, nem no log. O nome em forma de e-mail não foi guardado (o autor fica sem nome).
    const everywhere = [await wholeDatabase(), JSON.stringify(responses), lines.join("\n")].join("\n");
    for (const email of ALL_EMAILS) expect(everywhere, email).not.toContain(email);
    expect((await q("select actor_person_id, external_actor_name, changes from external_history_entries where external_id = 'hsent-2'"))[0]).toEqual({ actor_person_id: null, external_actor_name: null, changes: [{ field: "assignee", from: null, to: { name: null } }, { field: "description" }] });
  });
});

describe("e-mails do histórico fora de log, resposta, banco e evento nos caminhos de erro", () => {
  afterEach(() => vi.restoreAllMocks());
  const LEAK = `Usuário ${EMAILS.author} sem permissão para ver ${EMAILS.from} e ${EMAILS.to} (${AUTHOR})`;
  const runs = (path = "") => `/api/projects/${open()}/linear/runs${path}`;
  /** A página do time como o mundo a daria (com `errors` junto, quando dado). */
  const page = (team: FakeTeamData, ask: FakeHistoryAsk, errors?: unknown[]): LinearReply => {
    const live = historyIssues(team, ask.since);
    const begin = ask.after === null ? 0 : Number(ask.after);
    const end = begin + ask.first;
    const nodes = live.slice(begin, end).map((issue) => {
      const all = team.history?.[issue.id] ?? [];
      return { id: issue.id, history: { nodes: all.slice(0, 20).map((e) => fakeHistoryNode(e, ask.withEmail)), pageInfo: { hasNextPage: all.length > 20, endCursor: all.length > 20 ? "20" : null } } };
    });
    return { body: { data: { team: { issues: { nodes, pageInfo: { hasNextPage: end < live.length, endCursor: end < live.length ? String(end) : null } } } }, ...(errors ? { errors } : {}) } };
  };

  it("a captura enxerga o log mesmo com `logger: false` (sem isso a prova abaixo não prova nada)", () => {
    const lines = captureLogs();
    new Logger("Prova").error("MARCADOR-DE-LOG");
    console.error("MARCADOR-DO-CONSOLE");
    expect(lines.join("")).toContain("MARCADOR-DE-LOG");
    expect(lines.join("")).toContain("MARCADOR-DO-CONSOLE");
  });

  it("e-mail recusado, erro na página extra, limite de taxa, `errors` com `data` válido e 500: os caminhos rodam e nenhum e-mail sai", async () => {
    wireFakes(s);
    const data = linearTeam();
    await importedProject(s, open(), { data });
    data.history = HISTORY();
    const lines = captureLogs();
    type Variant = { name: string; reply: (ask: FakeHistoryAsk) => LinearReply | undefined; proof: (last: RunBody, seen: RunBody[]) => void };
    let once = false;
    const variants: Variant[] = [
      {
        name: "e-mail recusado",
        reply: (ask) => (ask.withEmail && ask.issueId === null ? { body: { data: null, errors: [{ message: LEAK, path: ["team", "issues", "nodes", 0, "history", "nodes", 0, "actor", "email"], extensions: { code: "FORBIDDEN", userPresentableMessage: LEAK } }] } } : undefined),
        proof: (last) => expect(last.counts).toMatchObject({ assigneeEmailUnavailable: true, historyCreated: 31 }),
      },
      {
        name: "erro na página extra",
        reply: (ask) => (ask.issueId !== null ? { body: { data: null, errors: [{ message: LEAK, path: ["issue", "history", "nodes", 0, "actor", "email"], extensions: { code: "INTERNAL_SERVER_ERROR", userPresentableMessage: LEAK } }] } } : undefined),
        // O erro com caminho em `email` na extra vira recusa de e-mail (a extra é repetida sem e-mail); a página inteira vale sem e-mail.
        proof: (last) => expect(last.counts).toMatchObject({ assigneeEmailUnavailable: true }),
      },
      {
        name: "erro sem caminho na página extra",
        reply: (ask) => (ask.issueId !== null ? { body: { data: null, errors: [{ message: LEAK, extensions: { code: "INTERNAL_SERVER_ERROR", userPresentableMessage: LEAK } }] } } : undefined),
        proof: (last) => expect(last.counts).toMatchObject({ historyIncomplete: true, historyTruncated: 1 }),
      },
      {
        name: "limite de taxa",
        reply: (ask) => {
          if (once || ask.issueId !== null) return undefined;
          once = true;
          return { status: 429, headers: { "Retry-After": "30" }, body: { errors: [{ message: LEAK, extensions: { code: "RATELIMITED" } }] } };
        },
        proof: (_last, seen) => expect(seen.some((body) => typeof body.waitUntil === "string")).toBe(true),
      },
      {
        name: "`errors` com `data` válido",
        reply: (ask) => (ask.issueId === null && ask.withHistory ? page(data, ask, [{ message: LEAK, path: ["team", "issues", "nodes", 0, "history"], extensions: { code: "INTERNAL_SERVER_ERROR", userPresentableMessage: LEAK } }]) : undefined),
        // A issue apontada pelo erro não é gravada (revisão H1, item 3) e segura a marca; as outras entram.
        proof: (last) => {
          expect(last.counts).toMatchObject({ historyIncomplete: true });
          expect(Number(last.counts?.["historyCreated"])).toBeGreaterThan(0);
          expect(Number(last.counts?.["historyCreated"])).toBeLessThan(31);
        },
      },
      {
        name: "500",
        reply: (ask) => (ask.issueId === null ? { status: 500, body: { errors: [{ message: LEAK }] } } : undefined),
        proof: (_last, seen) => expect(seen.some((body) => (body as { run?: { lastErrorCode?: string } }).run?.lastErrorCode === "linear_unavailable" || (body as { error?: { code?: string } }).error?.code === "linear_unavailable" || body["lastErrorCode"] === "linear_unavailable")).toBe(true),
      },
    ];
    const responses: unknown[] = [];
    for (const variant of variants) {
      await q("delete from external_history_entries");
      await q("update external_import_runs set history_since = null, history_complete = false");
      data.historyOverride = (_call, ask) => variant.reply(ask);
      const started = await h.call("POST", runs(), as("admin"), {});
      expect(started.status, variant.name).toBe(201);
      const id = (started.body as RunBody).id as string;
      const seen: RunBody[] = [started.body as RunBody];
      let last = started.body as RunBody;
      for (let i = 0; i < 60 && last.done !== true; i += 1) {
        const res = await h.call("POST", runs(`/${id}/step`), as("admin"));
        seen.push(res.body as RunBody);
        if (res.status === 200) last = res.body as RunBody;
        if (typeof last.waitUntil === "string") await q("update external_import_runs set wait_until = null where id = $1", [id]);
        if (res.status !== 200 && last.phase === "history") break;
      }
      seen.push((await h.call("GET", runs("/current"), as("admin"))).body as RunBody);
      for (const issue of ["a1", "a2"]) seen.push((await h.call("GET", `/api/tickets/${await ticketOf(issue)}/activity`, as("admin"))).body as RunBody);
      if (last.done !== true) await h.call("POST", runs(`/${id}/abandon`), as("admin"));
      variant.proof(last, seen);
      responses.push(...seen);
    }
    const everywhere = [await wholeDatabase(), JSON.stringify(responses), lines.join("\n")].join("\n");
    // O dado chegou ao banco (a prova não é vazia), e nada do texto do erro nem dos e-mails saiu.
    expect(everywhere).toContain(AUTHOR);
    for (const email of ALL_EMAILS) expect(everywhere, email).not.toContain(email);
    expect(everywhere).not.toContain("sem permissão para ver");
    expect(JSON.stringify(await q("select payload from activity_events"))).not.toMatch(/sentinela/i);
  });
});

describe("estrutura: só a importação e a linha do tempo leem o histórico importado", () => {
  const SRC = join(__dirname, "..", "src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));
  const files = () => walk(SRC).map((file) => file.slice(SRC.length + 1));
  // A tabela pelo nome, o modelo e as relações do Prisma (`Ticket.externalHistoryEntries`, `Person.externalHistoryEntries`,
  // `Project.externalHistoryEntries`), e a coluna do autor (que se lê sem citar a tabela).
  const READS = /externalHistoryEntr|ExternalHistoryEntr|external_history_entries|externalActorName|external_actor_name/;
  // O autor como a linha do tempo o entrega (`externalActor`): só o formato da resposta, a linha do tempo e o MCP com o alcance de pessoas.
  const ACTOR = /\bexternalActor\b/;
  // Quem usa a linha do tempo (que é onde o histórico sai): a tela (controlador) e o MCP com o alcance de pessoas.
  const TIMELINE = /TicketActivityService|ticket-activity\.service/;

  it("o padrão pega a tabela, o modelo e a relação, e não pega nomes parecidos", () => {
    for (const snippet of ["tx.externalHistoryEntry.findMany()", "include: { externalHistoryEntries: true }", "select * from external_history_entries", "Prisma.ExternalHistoryEntryWhereInput", "rows.map((row) => row.externalActorName)", "select external_actor_name from x"]) expect(READS.test(snippet), snippet).toBe(true);
    expect(ACTOR.test("entry.externalActor?.name")).toBe(true);
    expect(ACTOR.test("externalActorName")).toBe(false);
    for (const snippet of ["historyCreated: 0", "history_imported", "const history = []", "listTeamHistory"]) expect(READS.test(snippet), snippet).toBe(false);
  });
  it("só a importação e a linha do tempo leem a tabela", () => {
    expect(files().filter((file) => READS.test(readFileSync(join(SRC, file), "utf8")))).toEqual(["linear/linear-import.service.ts", "tickets/ticket-activity.service.ts"].sort());
  });
  it("o autor entregue pela linha do tempo (`externalActor`) só aparece no formato da resposta, na linha do tempo e no MCP com o alcance de pessoas", () => {
    expect(files().filter((file) => ACTOR.test(readFileSync(join(SRC, file), "utf8"))).sort()).toEqual(["mcp/mcp-people-read.ts", "tickets/ticket-activity.schema.ts", "tickets/ticket-activity.service.ts"]);
  });
  it("a linha do tempo só é usada pela página do ticket e pelo MCP (nenhum assistente, procura, vetores, resumo ou categorização)", () => {
    const users = files().filter((file) => file !== "tickets/ticket-activity.service.ts" && TIMELINE.test(readFileSync(join(SRC, file), "utf8")));
    expect(users.sort()).toEqual(["mcp/mcp-gateway.ts", "mcp/mcp-people-read.ts", "tickets/tickets.controller.ts", "tickets/tickets.module.ts"]);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINEAR_CLIENT } from "../src/linear/ports.js";
import type { LinearClient } from "../src/linear/ports.js";
import { useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { CATEGORIZE_CONFIG, categorizeAll, importedProject, linearTeam, runImport, wireFakes } from "./linear-categorize-support.js";
import type { Row } from "./linear-categorize-support.js";
import { as } from "./world.js";

// Privacidade da sincronização (ADR 0061, seções 5 e 6): nenhum e-mail do Linear em banco, log, resposta, evento ou erro; nada novo vai a
// provedor de IA, à Voyage ou ao MCP. Sentinelas improváveis, procuradas em tudo.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;
const open = () => h.world().projects.org;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];

const EMAILS = ["criador.sentinela@linear.test", "lider.sentinela@linear.test", "responsavel.sentinela@linear.test"];
const NAME = "Quixote Sentinela Criador";
const OLD_KEY = "ZZSENT-777";
const OLD_ID = "u-sentinela-criador";
const YEAR = "2031-04-05"; // ano improvável nos dados de teste

function sentinelTeam(): FakeTeamData {
  const data = linearTeam();
  const first = data.issues[0] as FakeIssue;
  Object.assign(first, { creator: { id: OLD_ID, name: NAME, email: EMAILS[0] }, assignee: { id: "u-resp", email: EMAILS[2] }, previousIdentifiers: [OLD_KEY], createdAt: `${YEAR}T10:00:00.000Z`, startedAt: `${YEAR}T11:00:00.000Z` });
  data.projects[0] = { ...(data.projects[0] as NonNullable<FakeTeamData["projects"][number]>), description: "Resumo do projeto", content: "Texto do projeto. Falar com [@Ana](person:0190a1b2-0000-7000-8000-000000000001)", lead: { id: "u-lider", email: EMAILS[1] as string } };
  return data;
}

/** Tudo o que o banco guarda, como texto (cada tabela do esquema público). */
async function wholeDatabase(): Promise<string> {
  const tables = (await q("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")).map((row) => row["table_name"] as string);
  const parts: string[] = [];
  for (const table of tables) parts.push(String((await q(`select coalesce(string_agg(t::text, ' '), '') as dump from "${table}" t`))[0]?.["dump"] ?? ""));
  return parts.join("\n");
}

describe("sincronizar com dados contaminados", () => {
  it("nenhum e-mail do Linear em banco, resposta, evento, log ou erro; nada do que a sincronização traz vai a provedor de IA, Voyage ou conversa", async () => {
    wireFakes(s);
    const logs: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const spy = (chunk: unknown): boolean => {
      logs.push(String(chunk));
      return true;
    };
    process.stdout.write = spy as typeof process.stdout.write;
    process.stderr.write = spy as typeof process.stderr.write;
    const responses: unknown[] = [];
    try {
      const data = sentinelTeam();
      await importedProject(s, open(), { data });
      // Uma sincronização depois, com tudo mudado no Linear, e um passo recusado (sem permissão): as respostas e os erros também são lidos.
      (data.issues[0] as FakeIssue).creator = { id: OLD_ID, name: NAME, email: EMAILS[0] as string };
      responses.push(await runImport(s, open()));
      responses.push((await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin"))).body);
      responses.push((await h.call("POST", `/api/projects/${open()}/linear/runs`, as("reader"), {})).body);
      const ids = (await q("select ticket_id from ticket_external_refs where kind = 'issue' limit 3")).map((row) => row["ticket_id"]);
      for (const id of ids) responses.push((await h.call("GET", `/api/tickets/${String(id)}`, as("admin"))).body);
      const view = await categorizeAll(s, open());
      expect(view.finished).toBe(true);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }

    const everywhere = [await wholeDatabase(), JSON.stringify(responses), logs.join("")].join("\n");
    // A varredura enxerga o banco de fato: o nome do criador (o dado novo) está nele.
    expect(everywhere).toContain(NAME);
    for (const email of EMAILS) expect(everywhere, email).not.toContain(email);
    expect(everywhere).not.toMatch(/sentinela@linear\.test/);

    // O que foi aos provedores (juiz, relacionados, afinidade, nomeador, vetores, conversa): sem nome do criador, datas, chave antiga, ids do Linear, e-mails.
    const embedded = h.embedder().calls.flatMap((call) => call.texts);
    const sent = JSON.stringify([h.judge().calls, h.related().calls, h.affinity().calls, h.namer().calls, h.conversation().calls, embedded]);
    expect(sent.length).toBeGreaterThan(500);
    for (const forbidden of [NAME, "Quixote", OLD_KEY, OLD_ID, YEAR, "u-lider", "u-resp", "sentinela", "person:"]) expect(sent, forbidden).not.toContain(forbidden);
    expect(h.conversation().calls).toHaveLength(0);

    // A descrição do ticket do projeto passou pela neutralização de menção (nada vira link de pessoa).
    const description = String((await q("select t.description from tickets t join ticket_external_refs r on r.ticket_id = t.id where r.kind = 'project'"))[0]?.["description"] ?? "");
    expect(description).toContain("Texto do projeto");
    expect(description).not.toContain("person:");
    // O nome do criador é o único dado pessoal novo: só na origem, e só no ticket sem pessoa casada.
    const names = await q("select external_creator_name, creator_person_id from ticket_external_refs where external_creator_name is not null");
    expect(names).toEqual([{ external_creator_name: NAME, creator_person_id: null }]);
    const events = JSON.stringify(await q("select payload from activity_events"));
    for (const forbidden of [NAME, OLD_KEY, OLD_ID, YEAR]) expect(events, forbidden).not.toContain(forbidden);
  });
});

describe("o Linear cita o e-mail na mensagem de erro (caminhos de erro novos)", () => {
  afterEach(() => vi.restoreAllMocks());
  /**
   * O harness cria a aplicação com `logger: false`: nada chega ao terminal, então só olhar a saída padrão não provaria nada. Espia o
   * `Logger` do Nest (o que o filtro de erros e os serviços chamam, mesmo desligado) e, por garantia, a saída padrão e a de erro.
   */
  const captureLogs = (): string[] => {
    const lines: string[] = [];
    for (const method of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void lines.push(`${method}: ${args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`));
    }
    for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => (lines.push(String(chunk)), true)) as never);
    return lines;
  };
  const LEAK = `Usuário ${EMAILS[0]} sem permissão para ver ${EMAILS[1]} e ${EMAILS[2]}`;
  const runs = (path = "") => `/api/projects/${open()}/linear/runs${path}`;

  it("a captura enxerga o log mesmo com `logger: false` (sem isso a prova abaixo não prova nada)", () => {
    const lines = captureLogs();
    new Logger("Prova").error("MARCADOR-DE-LOG");
    expect(lines.join("")).toContain("MARCADOR-DE-LOG");
  });

  it("erro do Linear com e-mail na mensagem (projetos e issues): nada em log, resposta, banco, evento", async () => {
    wireFakes(s);
    const data = sentinelTeam();
    await importedProject(s, open(), { data });
    const lines = captureLogs();
    const replies = [
      { status: 200, body: { errors: [{ message: LEAK, extensions: { code: "FORBIDDEN" }, path: ["team", "projects", "nodes", 0, "lead", "email"] }] } },
      { status: 200, body: { errors: [{ message: LEAK, extensions: { code: "INTERNAL_SERVER_ERROR" } }] } },
      { status: 400, body: { errors: [{ message: LEAK, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] } },
      { status: 500, body: { errors: [{ message: LEAK }] } },
      { status: 200, body: { data: { team: { issues: { nodes: [{ id: "x", creator: { id: "u", name: LEAK, email: LEAK } }], pageInfo: { hasNextPage: true, endCursor: null } } } }, errors: [{ message: LEAK }] } },
    ];
    const responses: unknown[] = [];
    for (const phase of ["projects", "issues"] as const) {
      for (const reply of replies) {
        data.projectsOverride = () => (phase === "projects" ? reply : undefined);
        data.override = () => (phase === "issues" ? reply : undefined);
        const started = await h.call("POST", runs(), as("admin"), {});
        responses.push(started.body);
        const id = (started.body as { id?: string }).id;
        if (id === undefined) continue;
        for (let i = 0; i < 3; i += 1) responses.push((await h.call("POST", runs(`/${id}/step`), as("admin"))).body);
        responses.push((await h.call("GET", runs("/current"), as("admin"))).body);
        await h.call("POST", runs(`/${id}/abandon`), as("admin"));
      }
    }
    // Os caminhos de erro rodaram de verdade: houve respostas de erro com código, e nenhuma delas citou nada do Linear.
    const codes = new Set(responses.flatMap((body) => [(body as { error?: { code?: string } }).error?.code, (body as { run?: { lastErrorCode?: string } }).run?.lastErrorCode].filter((code): code is string => typeof code === "string")));
    expect(codes.size).toBeGreaterThanOrEqual(2);
    const everywhere = [await wholeDatabase(), JSON.stringify(responses), lines.join("\n")].join("\n");
    for (const email of EMAILS) expect(everywhere, email).not.toContain(email);
    expect(everywhere).not.toContain("sem permissão para ver");
  });
});

describe("a captura de log pega um vazamento de verdade", () => {
  afterEach(() => vi.restoreAllMocks());
  it("exceção inesperada do cliente citando o e-mail: o filtro de erros a loga (500) e a captura a vê", async () => {
    wireFakes(s);
    await importedProject(s, open(), { data: sentinelTeam() });
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" ")));
    const client = h.app().get<LinearClient>(LINEAR_CLIENT);
    vi.spyOn(client, "listTeamProjects").mockRejectedValue(new Error(`falha ${EMAILS[0]}`));
    const started = await h.call("POST", `/api/projects/${open()}/linear/runs`, as("admin"), {});
    const res = await h.call("POST", `/api/projects/${open()}/linear/runs/${(started.body as { id: string }).id}/step`, as("admin"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(EMAILS[0] as string);
    // Prova que a captura SERIA capaz de pegar um vazamento: o filtro registra a mensagem da exceção. Ela só carrega o e-mail se o PRÓPRIO código a montar com ele
    // (o cliente do Linear nunca cita nada do corpo da resposta nas exceções que cria).
    expect(lines.join("\n")).toContain(EMAILS[0] as string);
  });
});

describe("as leituras que alimentam a IA e o MCP não conhecem os atributos novos", () => {
  const SRC = join(__dirname, "..", "src");
  const NEW = /externalCreatedAt|externalStartedAt|externalCompletedAt|externalCanceledAt|externalPreviousKeys|externalCreatorId|externalCreatorName|creatorPersonId|external_previous_keys|external_creator|creator_person_id|externalKeys|readLinearKeys|withLinearKeys|listedTicketSchema/;
  /** Só a importação, o detalhe do ticket e a lista de tickets da tela (as chaves da busca, TREEPM-501) leem as colunas novas. */
  const ALLOWED = new Set(["linear/linear-import.service.ts", "tickets/tickets.service.ts", "tickets/external-keys.ts", "tickets/tickets.controller.ts"]);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));
  it("nenhum arquivo de assistente, consulta, MCP, vetores ou categorização lê as colunas novas", () => {
    const offenders = walk(SRC)
      .map((file) => file.slice(SRC.length + 1))
      .filter((file) => !ALLOWED.has(file) && NEW.test(readFileSync(join(SRC, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("o MCP lê da origem do ticket só a chave e o endereço (ADR 0062, seção 5), e de nenhum outro jeito", () => {
    const mcp = walk(join(SRC, "mcp"));
    const used = new Set(mcp.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bexternal[A-Z_]\w*/g)].map((m) => m[0])));
    // Exatamente as duas colunas: nem criador, nem datas, nem chaves antigas, nem id, workspace ou time do Linear.
    expect([...used].sort()).toEqual(["externalKey", "externalUrl"]);
    // E só por uma consulta com `select` explícito dessas duas (nunca a linha inteira da origem).
    const reads = mcp.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/ticketExternalRef\.\w+\(\{[^]*?\}\)/g)].map((m) => m[0]));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toMatch(/select: \{ externalKey: true, externalUrl: true \}/);
    for (const file of mcp) expect(readFileSync(file, "utf8"), file).not.toMatch(/external_ref|ticket_external_refs|\$queryRaw/);
  });

  it("as chaves do Linear da busca (TREEPM-501) só saem pela lista da tela: nada de assistente, consulta, MCP, vetores ou categorização as importa", () => {
    const importers = walk(SRC)
      .map((file) => file.slice(SRC.length + 1))
      .filter((file) => /from "(\.\.?\/)+(tickets\/)?external-keys\.js"/.test(readFileSync(join(SRC, file), "utf8")));
    expect(importers).toEqual(["tickets/tickets.controller.ts"]);
    // E o resumo que o MCP, o assistente e a Voyage leem (`TicketSummary`, `toSummary`, `readSummaryRows`) continua sem o campo.
    for (const file of ["tickets/tickets.schema.ts", "tickets/ticket-reads.ts"]) expect(readFileSync(join(SRC, file), "utf8"), file).not.toMatch(/externalKeys|external_key|external_previous_keys/);
    const summary = readFileSync(join(SRC, "tickets/tickets.service.ts"), "utf8").match(/export function toSummary[\s\S]*?\n}\n/)?.[0] ?? "";
    expect(summary.length).toBeGreaterThan(200);
    expect(summary).not.toMatch(/externalKeys|externalKey|previousKeys/);
  });
});

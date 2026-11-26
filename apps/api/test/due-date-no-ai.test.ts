/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto das requisições ao provedor */
import { createPrismaClient, withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeChatProvider } from "../src/assistant/claude-chat-provider.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { buildPairs } from "../scripts/placement-rebuild/pairs-core.js";
import type { GabaritoTicket } from "../scripts/placement-rebuild/core.js";
import { FakeBranchSummarizer } from "./assistant-fakes.js";
import { seedTree } from "./assistant-tree.js";
import { openGeneral, post, seedChatTickets, send } from "./chat-support.js";
import { useLinearHarness } from "./linear-support.js";
import { CATEGORIZE_CONFIG, categorizeAll, importedProject, wireFakes } from "./linear-categorize-support.js";
import { ORG, as } from "./world.js";

// ADR 0064: o prazo do ticket NUNCA vai a provedor de IA. Todos os tickets levam um prazo sentinela e cada caminho que fala com um
// provedor (conversa do ticket, Meu chat com ferramentas de consulta, procura do lugar, categorização do Linear, vetores e resumo de
// ramo) é acionado de verdade; todo pedido gravado pelos falsos é serializado e a data não pode aparecer em formato nenhum.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;

const DUE = "2031-07-19";
const FORMS = [DUE, "19/07/2031", "07/19/2031", "2031/07/19", "19.07.2031", `${DUE}T`];

/** Afirma que nenhum formato da data aparece no que foi mandado (ou montado para mandar) ao provedor. */
function noDate(label: string, sent: unknown): void {
  const wire = JSON.stringify(sent);
  for (const form of FORMS) expect(wire.includes(form), `${label} levou o prazo (${form})`).toBe(false);
}

/** Tudo o que os falsos de IA gravaram (Claude, Jev e Voyage), por porta. */
const fakeCalls = () => ({
  chat: h.chat().calls,
  conversation: h.conversation().calls,
  judge: h.judge().calls,
  summarizer: h.summarizer().calls,
  affinity: h.affinity().calls,
  related: h.related().calls,
  namer: h.namer().calls,
  writer: h.writer().calls,
  elaborator: [...h.elaborator().calls, ...h.elaborator().matchCalls],
  embedder: h.embedder().calls,
});

/** Todo ticket da organização ganha o prazo sentinela (o principal, os pais, os irmãos, os filhos e as dependências). */
const dueEverywhere = () => h.pool.query("update tickets set due_date = $1::date where org_id = $2", [DUE, ORG]);

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createPrismaClient(APP_URL);
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** O sentinela está mesmo gravado: lido pelo Prisma, como a API lê. */
async function expectStored(ticketId: string): Promise<void> {
  const row = await withTenant(prisma, { orgId: ORG, userId: `u_${ORG}` }, (tx) => tx.ticket.findUnique({ where: { orgId_id: { orgId: ORG, id: ticketId } }, select: { dueDate: true } }));
  expect(row?.dueDate?.toISOString().slice(0, 10)).toBe(DUE);
}

// ---- provedor de IA roteirizado para o chat (o ClaudeChatProvider de verdade executa as ferramentas pelo ask-executor) ----
type Request = Record<string, any>;
const requests: Request[] = [];
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const final = (message: string) => ({ stop_reason: "end_turn", parsed_output: { message }, model: "claude-opus-5-5", content: [text(JSON.stringify({ message }))] });
const toolTurn = (...uses: unknown[]) => ({ stop_reason: "tool_use", parsed_output: null, model: "claude-opus-5-5", content: uses });
const toolResults = (): { content: string }[] =>
  requests.flatMap((r) => (r["messages"] as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [])));

/** Na primeira chamada o "modelo" usa todas as ferramentas de consulta sobre o ticket com prazo; depois responde. */
function scriptQueries(): void {
  requests.length = 0;
  const stream = (async (params: Request) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    return requests.length === 1
      ? toolTurn(
          use("a", "read_ticket", { ticket: "PRIV-3" }),
          use("b", "read_ticket", { ticket: "PRIV-2" }),
          use("c", "search_tickets", { query: "Ticket" }),
          use("d", "list_tickets", { project: "PRIV" }),
          use("e", "project_overview", { project: "PRIV" }),
        )
      : final("Pronto.");
  }) as unknown as ClaudeStreamer;
  h.chat().delegate = new ClaudeChatProvider(stream);
}

/** As ferramentas rodaram de fato e devolveram o ticket com prazo (sem o prazo). */
function expectToolsRan(): void {
  expect(requests.length).toBeGreaterThanOrEqual(2);
  const results = toolResults();
  expect(results).toHaveLength(5);
  const all = JSON.stringify(results);
  for (const seen of ["PRIV-3", "Ticket do chat", "Pai do ticket", "Filho um"]) expect(all, seen).toContain(seen);
}

describe("o prazo não vai a provedor de IA (ADR 0064)", () => {
  it("conversa do ticket: o contexto do ticket e as ferramentas de consulta (ask-executor) não levam o prazo", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    expect((await h.call("PATCH", `/api/tickets/${t.ticket}`, as("admin"), { dueDate: DUE })).status).toBe(200);
    await dueEverywhere();
    for (const id of [t.ticket, t.parent, t.root, t.child1, t.child2, t.dependsOn, t.blocker]) await expectStored(id);
    scriptQueries();

    const res = await send(h, "manager", t.ticket, "Como anda este ticket?");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expect(h.chat().calls[0]!.ticket?.key).toBe("PRIV-3");
    expectToolsRan();
    noDate("chat do ticket (entrada do provedor)", h.chat().calls);
    noDate("chat do ticket (pedidos ao Claude, com os resultados das ferramentas)", requests);
    noDate("falsos", fakeCalls());
  });

  it("Meu chat: a pergunta solta e as ferramentas de consulta não levam o prazo", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await dueEverywhere();
    await expectStored(t.ticket);
    scriptQueries();

    const general = await openGeneral(h, "manager");
    const res = await post(h, "manager", general, "O que há no PRIV-3?");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expectToolsRan();
    noDate("Meu chat (entrada do provedor)", h.chat().calls);
    noDate("Meu chat (pedidos ao Claude)", requests);
    noDate("falsos", fakeCalls());
  });

  it("procura do lugar e vetores: conversa de criação, juiz, afinidade, relacionados, elaboração e Voyage não levam o prazo", async () => {
    const tree = await seedTree(h.pool, h.world());
    await dueEverywhere();
    for (const id of [tree.auth, tree.login, tree.sso, tree.saml]) await expectStored(id);
    const priv = h.world().projects.priv;

    const id = (await h.call("POST", `/api/projects/${priv}/ticket-conversations`, as("contributor"), { message: "Quero entrar por SAML" })).body.id as string;
    expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Login por SAML", description: "Entrar sem senha" })).status).toBe(200);
    expect((await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {})).status).toBe(201);
    await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));

    const calls = fakeCalls();
    expect(calls.conversation.length).toBeGreaterThanOrEqual(1);
    expect(calls.judge.length).toBeGreaterThanOrEqual(1);
    expect(calls.embedder.some((c) => c.kind === "document")).toBe(true);
    expect(calls.embedder.some((c) => c.kind === "query")).toBe(true);
    // Os candidatos do juiz levam o texto do ramo (o resumo montado), que também não pode levar o prazo.
    expect(calls.judge.some((c) => c.candidates.some((candidate) => typeof candidate.summary === "string" && candidate.summary.length > 0))).toBe(true);
    noDate("procura do lugar", calls);
  });

  it("categorização do Linear: juiz, relacionados, afinidade, nome de grupo e Voyage não levam o prazo", async () => {
    wireFakes(s);
    const project = h.world().projects.org;
    const { tree } = await importedProject(s, project);
    await dueEverywhere();
    await expectStored(tree["Auth"]!);
    const solta = (await h.pool.query<{ id: string }>("select id from tickets where project_id = $1 and title = 'Solta 1'", [project])).rows[0]!.id;
    await expectStored(solta);
    h.embedder().calls.length = 0;

    const view = await categorizeAll(s, project);
    expect(view.finished).toBe(true);
    const calls = fakeCalls();
    expect(calls.judge.length).toBeGreaterThanOrEqual(1);
    expect(calls.embedder.length).toBeGreaterThanOrEqual(1);
    noDate("categorização", calls);
  });

  it("resumo de ramo: o texto montado do agrupador e o pedido ao resumidor (ferramenta de medição) não levam o prazo", async () => {
    const tree = await seedTree(h.pool, h.world());
    await dueEverywhere();
    await expectStored(tree.auth);
    const priv = h.world().projects.priv;

    // O texto do ramo que vai aos candidatos do juiz: a leitura e o "regenerar".
    const read = await h.call("GET", `/api/tickets/${tree.auth}/summary`, as("manager"));
    const regenerated = await h.call("POST", `/api/tickets/${tree.auth}/summary/regenerate`, as("manager"));
    expect(read.status).toBe(200);
    expect(regenerated.status).toBe(200);
    expect(read.body.summary.text).toContain("Login");
    noDate("texto do ramo", [read.body, regenerated.body]);

    // O resumidor (Claude) da ferramenta de medição: o gabarito vem da lista da API, que traz o prazo; o pedido não pode levá-lo.
    const list = (await h.call("GET", `/api/projects/${priv}/tickets`, as("admin"))).body as Record<string, unknown>[];
    expect(list.every((ticket) => ticket["dueDate"] === DUE)).toBe(true);
    const gabarito = list.map((ticket) => ({ ...ticket, description: String(ticket["description"] ?? ""), assigneeIds: [], depth: 0, kind: "group" }) as unknown as GabaritoTicket);
    const summarizer = new FakeBranchSummarizer();
    for (const pair of buildPairs(gabarito).pairs) if (pair.candidate.text.kind === "summary") await summarizer.summarize(pair.candidate.text.input);
    expect(summarizer.calls.length).toBeGreaterThanOrEqual(1);
    noDate("resumidor de ramo", summarizer.calls);
    noDate("falsos", fakeCalls());
  });
});

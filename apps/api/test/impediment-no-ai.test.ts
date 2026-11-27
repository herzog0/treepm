/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto das requisições ao provedor */
import { describe, expect, it } from "vitest";
import { ClaudeChatProvider } from "../src/assistant/claude-chat-provider.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { seedTree } from "./assistant-tree.js";
import { openGeneral, post, seedChatTickets, send } from "./chat-support.js";
import { useLinearHarness } from "./linear-support.js";
import { CATEGORIZE_CONFIG } from "./linear-categorize-support.js";
import { ORG, as } from "./world.js";

// ADR 0068, seção 5: o motivo do impedimento é texto novo da pessoa e NÃO vai a provedor de IA (até o TREEPM-580). Todos os tickets
// levam um motivo sentinela e cada caminho que fala com um provedor (conversa do ticket, Meu chat com ferramentas de consulta, procura
// do lugar, vetores e resumo de ramo) é acionado de verdade; todo pedido gravado pelos falsos é serializado e o motivo não pode aparecer.
// O fato "bloqueado" (booleano) pode ir.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;

const REASON = "MOTIVO-SENTINELA-7731 esperando o fornecedor";
const FORMS = ["MOTIVO-SENTINELA-7731", "esperando o fornecedor"];

function noReason(label: string, sent: unknown): void {
  const wire = JSON.stringify(sent);
  for (const form of FORMS) expect(wire.includes(form), `${label} levou o motivo (${form})`).toBe(false);
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

/** Todo ticket aberto da organização ganha o impedimento sentinela. */
async function impededEverywhere(): Promise<void> {
  await h.pool.query(
    "update tickets set impediment_reason = $1, impediment_person_id = (select id from people where org_id = $2 order by id limit 1), impediment_at = now() where org_id = $2 and status not in ('done', 'cancelled')",
    [REASON, ORG],
  );
  const stored = await h.pool.query("select count(*)::int as n from tickets where org_id = $1 and impediment_reason = $2", [ORG, REASON]);
  expect(stored.rows[0].n).toBeGreaterThan(0);
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

describe("o motivo do impedimento não vai a provedor de IA (ADR 0068)", () => {
  it("conversa do ticket: o contexto do ticket e as ferramentas de consulta (ask-executor) não levam o motivo", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    expect((await h.call("PUT", `/api/tickets/${t.ticket}/impediment`, as("admin"), { reason: REASON })).status).toBe(200);
    await impededEverywhere();
    scriptQueries();

    const res = await send(h, "manager", t.ticket, "Como anda este ticket?");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expectToolsRan();
    noReason("chat do ticket (entrada do provedor)", h.chat().calls);
    noReason("chat do ticket (pedidos ao Claude, com os resultados das ferramentas)", requests);
    noReason("falsos", fakeCalls());
  });

  it("Meu chat: a pergunta solta e as ferramentas de consulta não levam o motivo", async () => {
    await seedChatTickets(h.pool, h.world());
    await impededEverywhere();
    scriptQueries();

    const general = await openGeneral(h, "manager");
    const res = await post(h, "manager", general, "O que há no PRIV-3?");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expectToolsRan();
    noReason("Meu chat (entrada do provedor)", h.chat().calls);
    noReason("Meu chat (pedidos ao Claude)", requests);
    noReason("falsos", fakeCalls());
  });

  it("procura do lugar, vetores e resumo de ramo não levam o motivo", async () => {
    const tree = await seedTree(h.pool, h.world());
    await impededEverywhere();
    const priv = h.world().projects.priv;

    const id = (await h.call("POST", `/api/projects/${priv}/ticket-conversations`, as("contributor"), { message: "Quero entrar por SAML" })).body.id as string;
    expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Login por SAML", description: "Entrar sem senha" })).status).toBe(200);
    expect((await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {})).status).toBe(201);
    await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
    const read = await h.call("GET", `/api/tickets/${tree.auth}/summary`, as("manager"));
    const regenerated = await h.call("POST", `/api/tickets/${tree.auth}/summary/regenerate`, as("manager"));
    expect(read.status).toBe(200);
    expect(regenerated.status).toBe(200);

    const calls = fakeCalls();
    expect(calls.conversation.length).toBeGreaterThanOrEqual(1);
    expect(calls.judge.length).toBeGreaterThanOrEqual(1);
    expect(calls.embedder.length).toBeGreaterThanOrEqual(1);
    noReason("procura do lugar", calls);
    noReason("texto do ramo", [read.body, regenerated.body]);
  });
});

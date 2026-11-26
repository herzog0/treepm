/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto das requisições ao provedor */
import { describe, expect, it } from "vitest";
import { ClaudeChatProvider } from "../src/assistant/claude-chat-provider.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { buildPairs } from "../scripts/placement-rebuild/pairs-core.js";
import type { GabaritoTicket } from "../scripts/placement-rebuild/core.js";
import { FakeBranchSummarizer } from "./assistant-fakes.js";
import { seedTree } from "./assistant-tree.js";
import { openGeneral, post, seedChatTickets, send } from "./chat-support.js";
import { useLinearHarness } from "./linear-support.js";
import { CATEGORIZE_CONFIG, categorizeAll, importedProject, linearTeam, wireFakes } from "./linear-categorize-support.js";
import { ORG, as } from "./world.js";

// ADR 0065, seção 4: o nome de etiqueta NUNCA vai a provedor de IA (Anthropic, TypeSafe, Voyage). Molde: due-date-no-ai.test.ts.
// Todo ticket da organização leva a etiqueta sentinela; o ticket principal de cada caso ainda passa pelas rotas reais (etiqueta posta,
// tirada, renomeada e apagada), para o nome estar também nos payloads dos eventos `ticket.labels_changed` e `project.label_deleted`.
// Cada caminho que fala com um provedor (conversa do ticket, Meu chat com ferramentas de consulta, procura do lugar, categorização do
// Linear, vetores e resumo de ramo) é acionado de verdade; todo pedido gravado pelos falsos é serializado e o nome não pode aparecer.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;

const NAME = "zzetiquetasentinela";

/** Afirma que o nome sentinela não aparece (em caixa nenhuma) no que foi mandado (ou montado para mandar) ao provedor. */
function noLabel(label: string, sent: unknown): void {
  const wire = JSON.stringify(sent).toLowerCase();
  expect(wire.includes(NAME), `${label} levou o nome da etiqueta`).toBe(false);
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

/**
 * Pelas rotas reais, no ticket dado (como administrador): põe e tira uma etiqueta; põe outra e a renomeia para o nome sentinela; põe uma
 * terceira e a apaga nas configurações. Confere que os eventos gravaram os nomes (é o que o teste quer ver fora dos pedidos).
 */
async function labelHistory(projectId: string, ticketId: string): Promise<void> {
  const change = async (body: unknown) => {
    const res = await h.call("POST", `/api/tickets/${ticketId}/labels`, as("admin"), body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.labels as { id: string; name: string }[];
  };
  const idOf = (labels: { id: string; name: string }[], name: string) => labels.find((l) => l.name === name)!.id;

  const removed = idOf(await change({ add: [{ name: `${NAME} tirada` }] }), `${NAME} tirada`);
  await change({ remove: [removed] });

  const renamed = idOf(await change({ add: [{ name: `${NAME} velha` }] }), `${NAME} velha`);
  const patch = await h.call("PATCH", `/api/projects/${projectId}/labels/${renamed}`, as("admin"), { name: NAME });
  expect(patch.status, JSON.stringify(patch.body)).toBe(200);

  const deleted = idOf(await change({ add: [{ name: `${NAME} apagada` }] }), `${NAME} apagada`);
  const del = await h.call("DELETE", `/api/projects/${projectId}/labels/${deleted}`, as("admin"));
  expect(del.status, JSON.stringify(del.body)).toBe(200);
  expect(del.body.ticketsAffected).toBe(1);

  const events = await h.pool.query<{ kind: string; payload: unknown }>(
    "select kind, payload from activity_events where org_id = $1 and ((subject_type = 'ticket' and subject_id = $2) or (subject_type = 'project' and subject_id = $3)) and kind in ('ticket.labels_changed','project.label_deleted')",
    [ORG, ticketId, projectId],
  );
  // Só os da pessoa: a importação do Linear (caso da categorização) já gravou um automático neste ticket.
  expect(events.rows.filter((e) => e.kind === "ticket.labels_changed" && (e.payload as { automatic?: boolean }).automatic !== true)).toHaveLength(4);
  expect(events.rows.filter((e) => e.kind === "project.label_deleted")).toHaveLength(1);
  expect(JSON.stringify(events.rows)).toContain(`${NAME} tirada`);
  expect(JSON.stringify(events.rows)).toContain(`${NAME} velha`);
  expect(JSON.stringify(events.rows)).toContain(`${NAME} apagada`);
}

/** Todo ticket da organização ganha a etiqueta sentinela (o principal, os pais, os irmãos, os filhos e as dependências). */
async function labelEverywhere(): Promise<void> {
  await h.pool.query(
    "insert into project_labels (org_id, project_id, name, name_key, color) select org_id, id, $2, $2, 'gray' from projects where org_id = $1 on conflict (org_id, project_id, name_key) do nothing",
    [ORG, NAME],
  );
  await h.pool.query(
    "insert into ticket_labels (org_id, project_id, ticket_id, label_id) select t.org_id, t.project_id, t.id, l.id from tickets t join project_labels l on l.org_id = t.org_id and l.project_id = t.project_id and l.name_key = $2 where t.org_id = $1 on conflict do nothing",
    [ORG, NAME],
  );
}

/** O sentinela está mesmo no ticket: lido pela rota do detalhe, como a tela lê. */
async function expectLabeled(ticketId: string): Promise<void> {
  const res = await h.call("GET", `/api/tickets/${ticketId}`, as("admin"));
  expect(res.status).toBe(200);
  expect((res.body.labels as { name: string }[]).map((l) => l.name)).toContain(NAME);
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

/** Na primeira chamada o "modelo" usa todas as ferramentas de consulta sobre o ticket etiquetado; depois responde. */
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

/** As ferramentas rodaram de fato e devolveram o ticket etiquetado (sem as etiquetas). */
function expectToolsRan(): void {
  expect(requests.length).toBeGreaterThanOrEqual(2);
  const results = toolResults();
  expect(results).toHaveLength(5);
  const all = JSON.stringify(results);
  for (const seen of ["PRIV-3", "Ticket do chat", "Pai do ticket", "Filho um"]) expect(all, seen).toContain(seen);
}

describe("o nome de etiqueta não vai a provedor de IA (ADR 0065)", () => {
  it("conversa do ticket: o contexto do ticket e as ferramentas de consulta (ask-executor) não levam as etiquetas", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const priv = h.world().projects.priv;
    await labelHistory(priv, t.ticket);
    await labelEverywhere();
    for (const id of [t.ticket, t.parent, t.root, t.child1, t.child2, t.dependsOn, t.blocker]) await expectLabeled(id);
    const activity = await h.call("GET", `/api/tickets/${t.ticket}/activity`, as("admin"));
    expect(JSON.stringify(activity.body)).toContain(`${NAME} velha`);
    scriptQueries();

    const res = await send(h, "manager", t.ticket, "Como anda este ticket?");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expect(h.chat().calls[0]!.ticket?.key).toBe("PRIV-3");
    expectToolsRan();
    noLabel("chat do ticket (entrada do provedor)", h.chat().calls);
    noLabel("chat do ticket (pedidos ao Claude, com os resultados das ferramentas)", requests);
    noLabel("falsos", fakeCalls());
  });

  it("Meu chat: a pergunta solta e as ferramentas de consulta não levam as etiquetas", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    await labelHistory(h.world().projects.priv, t.ticket);
    await labelEverywhere();
    await expectLabeled(t.ticket);
    scriptQueries();

    const general = await openGeneral(h, "manager");
    const res = await post(h, "manager", general, "O que há no PRIV-3?");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(h.chat().calls).toHaveLength(1);
    expectToolsRan();
    noLabel("Meu chat (entrada do provedor)", h.chat().calls);
    noLabel("Meu chat (pedidos ao Claude)", requests);
    noLabel("falsos", fakeCalls());
  });

  it("procura do lugar e vetores: conversa de criação, juiz, afinidade, relacionados, elaboração e Voyage não levam as etiquetas", async () => {
    const tree = await seedTree(h.pool, h.world());
    const priv = h.world().projects.priv;
    await labelHistory(priv, tree.login);
    await labelEverywhere();
    for (const id of [tree.auth, tree.login, tree.sso, tree.saml]) await expectLabeled(id);

    const id = (await h.call("POST", `/api/projects/${priv}/ticket-conversations`, as("contributor"), { message: "Quero entrar por SAML" })).body.id as string;
    expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Login por SAML", description: "Entrar sem senha" })).status).toBe(200);
    expect((await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {})).status).toBe(201);
    await h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));

    const calls = fakeCalls();
    expect(calls.conversation.length).toBeGreaterThanOrEqual(1);
    expect(calls.judge.length).toBeGreaterThanOrEqual(1);
    expect(calls.embedder.some((c) => c.kind === "document")).toBe(true);
    expect(calls.embedder.some((c) => c.kind === "query")).toBe(true);
    // Os candidatos do juiz levam o texto do ramo (o resumo montado), que também não pode levar as etiquetas.
    expect(calls.judge.some((c) => c.candidates.some((candidate) => typeof candidate.summary === "string" && candidate.summary.length > 0))).toBe(true);
    noLabel("procura do lugar", calls);
  });

  it("categorização do Linear: juiz, relacionados, afinidade, nome de grupo e Voyage não levam as etiquetas", async () => {
    wireFakes(s);
    const project = h.world().projects.org;
    // As issues do Linear falso trazem etiquetas (ADR 0065, seção 5) com o sentinela, com e sem grupo: elas entram pela importação.
    const data = linearTeam();
    data.issues = data.issues.map((item, index) => ({
      ...item,
      labels: [
        { id: `l-sent-${index % 3}`, name: `zzetiquetasentinela linear ${index % 3}`, color: "#4ea7fc" },
        { id: "l-sent-g", name: "zzetiquetasentinela do grupo", color: "#eb5757", parent: { id: "g-sent", name: "zzetiquetasentinela grupo" } },
      ],
    }));
    const { tree } = await importedProject(s, project, { data });
    const fromLinear = await h.pool.query<{ n: number }>("select count(*)::int n from ticket_labels tl join project_labels pl on pl.id = tl.label_id where pl.project_id = $1 and pl.name like 'zzetiquetasentinela linear%'", [project]);
    expect(fromLinear.rows[0]!.n).toBeGreaterThanOrEqual(data.issues.length);
    const solta = (await h.pool.query<{ id: string }>("select id from tickets where project_id = $1 and title = 'Solta 1'", [project])).rows[0]!.id;
    await labelHistory(project, solta);
    await labelEverywhere();
    await expectLabeled(tree["Auth"]!);
    await expectLabeled(solta);
    h.embedder().calls.length = 0;

    const view = await categorizeAll(s, project);
    expect(view.finished).toBe(true);
    const calls = fakeCalls();
    expect(calls.judge.length).toBeGreaterThanOrEqual(1);
    expect(calls.embedder.length).toBeGreaterThanOrEqual(1);
    noLabel("categorização", calls);
  });

  it("resumo de ramo: o texto montado do agrupador e o pedido ao resumidor (ferramenta de medição) não levam as etiquetas", async () => {
    const tree = await seedTree(h.pool, h.world());
    const priv = h.world().projects.priv;
    await labelHistory(priv, tree.login);
    await labelEverywhere();
    await expectLabeled(tree.auth);

    // O texto do ramo que vai aos candidatos do juiz: a leitura e o "regenerar".
    const read = await h.call("GET", `/api/tickets/${tree.auth}/summary`, as("manager"));
    const regenerated = await h.call("POST", `/api/tickets/${tree.auth}/summary/regenerate`, as("manager"));
    expect(read.status).toBe(200);
    expect(regenerated.status).toBe(200);
    expect(read.body.summary.text).toContain("Login");
    noLabel("texto do ramo", [read.body, regenerated.body]);

    // O resumidor (Claude) da ferramenta de medição: o gabarito vem da lista da API, que traz as etiquetas; o pedido não pode levá-las.
    const list = (await h.call("GET", `/api/projects/${priv}/tickets`, as("admin"))).body as Record<string, unknown>[];
    expect(list.every((ticket) => (ticket["labels"] as { name: string }[]).some((l) => l.name === NAME))).toBe(true);
    const gabarito = list.map((ticket) => ({ ...ticket, description: String(ticket["description"] ?? ""), assigneeIds: [], depth: 0, kind: "group" }) as unknown as GabaritoTicket);
    const summarizer = new FakeBranchSummarizer();
    for (const pair of buildPairs(gabarito).pairs) if (pair.candidate.text.kind === "summary") await summarizer.summarize(pair.candidate.text.input);
    expect(summarizer.calls.length).toBeGreaterThanOrEqual(1);
    noLabel("resumidor de ramo", summarizer.calls);
    noLabel("falsos", fakeCalls());
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ActivityPage, ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0040, fatia 1: a seção "Atividade" da página do ticket.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Outro ticket", { key: "ALFA-2" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno", avatarUrl: "https://img.test/bruno.png" };
const NOW = new Date("2026-11-22T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
let counter = 0;
type Part<T extends ActivityEntry["type"]> = Omit<Extract<ActivityEntry, { type: T }>, "id" | "occurredAt" | "actor"> & Partial<Pick<ActivityEntry, "id" | "occurredAt" | "actor">>;
const entry = <T extends ActivityEntry["type"]>(data: Part<T>): ActivityEntry =>
  ({ id: `e${++counter}`, occurredAt: at(5), actor: ana, ...data }) as ActivityEntry;
const page = (entries: ActivityEntry[], before: string | null = null): ActivityPage => ({ entries, before, canComment: false });
const ref = (n: number, title = `Título ${n}`) => ({ id: `r${n}`, key: `ALFA-${n}`, title });
const gone = (key: string | null = null) => ({ id: null, key, title: null });

function setup(pages: Record<string, ActivityPage> | ((before?: string) => Promise<unknown>), options: { archived?: boolean } = {}) {
  const proj = options.archived ? makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project;
  const client = makeClient({ projects: [proj], people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")], tickets: { p1: summaries } });
  const ticketActivity = vi.fn(async (_id: string, query: { before?: string } = {}) => {
    if (typeof pages === "function") return pages(query.before) as never;
    const found = pages[query.before ?? ""];
    return found ? ok(found) : failed("unavailable");
  });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    ticketActivity,
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[proj]} ticketId="t1" creating={null} {...handlers} />);
  return { client, ticketActivity, ...handlers };
}
const section = () => screen.findByRole("region", { name: "Atividade" });
const rows = async () => within(await section()).findAllByRole("listitem");
const textOf = (row: HTMLElement) => row.querySelector(".ticket-activity-text")?.textContent?.replace(/\s+/g, " ").trim();
const texts = async () => (await rows()).map(textOf);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  await setTestLanguage("pt-BR");
});

describe("seção Atividade: frases", () => {
  it.each([
    [entry<"created">({ type: "created" }), /^Ana criou este ticket/],
    [entry<"title_changed">({ type: "title_changed", from: "x", to: "y" }), /^Ana mudou o título de «x» para «y»/],
    [entry<"description_changed">({ type: "description_changed" }), /^Ana editou a descrição/],
    [entry<"status_changed">({ type: "status_changed", from: "todo", to: "in_progress", automatic: false, causedBy: null }), /^Ana mudou a situação de A fazer para Em andamento/],
    [entry<"status_changed">({ type: "status_changed", from: "done", to: "todo", automatic: true, causedBy: ref(31, "Filho") }), /^Reaberto automaticamente porque ALFA-31 Filho foi aberto aqui dentro/],
    [entry<"status_changed">({ type: "status_changed", from: "done", to: "todo", automatic: true, causedBy: null }), /^Reaberto automaticamente/],
    [entry<"status_changed">({ type: "status_changed", from: "done", to: "todo", automatic: true, causedBy: gone("ALFA-31") }), /^Reaberto automaticamente porque ALFA-31 \(ticket removido\) foi aberto aqui dentro/],
    [entry<"parent_changed">({ type: "parent_changed", from: null, to: ref(12, "Título") }), /^Ana moveu para dentro de ALFA-12 Título/],
    [entry<"parent_changed">({ type: "parent_changed", from: ref(12), to: null }), /^Ana tirou de dentro de ALFA-12 Título 12/],
    [entry<"parent_changed">({ type: "parent_changed", from: ref(12), to: ref(13) }), /^Ana moveu de ALFA-12 Título 12 para dentro de ALFA-13 Título 13/],
    [entry<"parent_changed">({ type: "parent_changed", from: gone(), to: ref(13) }), /^Ana moveu de ticket removido para dentro de ALFA-13/],
    [entry<"assignee_added">({ type: "assignee_added", person: bruno }), /^Ana adicionou Bruno como responsável/],
    [entry<"assignee_added">({ type: "assignee_added", person: null }), /^Ana adicionou Pessoa removida como responsável/],
    [entry<"assignee_removed">({ type: "assignee_removed", person: bruno }), /^Ana tirou Bruno dos responsáveis/],
    [entry<"dependency_added">({ type: "dependency_added", ticket: ref(7, "Banco") }), /^Ana marcou que depende de ALFA-7 Banco/],
    [entry<"dependency_removed">({ type: "dependency_removed", ticket: ref(7, "Banco") }), /^Ana removeu a dependência de ALFA-7 Banco/],
    [entry<"summary_updated">({ type: "summary_updated", source: "person" }), /^Ana editou «O que entra aqui»/],
    [entry<"summary_updated">({ type: "summary_updated", source: "assistant" }), /^Ana pediu à IA para atualizar «O que entra aqui»/],
  ])("%j", async (item, expected) => {
    setup({ "": page([item]) });
    const [text] = await texts();
    expect(text).toMatch(expected);
  });

  // Reimportação do Linear (ADR 0060 seção 5): entrada `automatic: true` diz que foi automática, como a situação já diz.
  it.each([
    [entry<"title_changed">({ type: "title_changed", from: "x", to: "y", automatic: true, actor: null }), /^Título mudado automaticamente de «x» para «y»/],
    [entry<"description_changed">({ type: "description_changed", automatic: true, actor: null }), /^Descrição editada automaticamente/],
    [entry<"priority_changed">({ type: "priority_changed", from: 1, to: 2, automatic: true, actor: null }), /^Prioridade mudada automaticamente de 1 para 2/],
    [entry<"parent_changed">({ type: "parent_changed", from: null, to: ref(12, "Título"), automatic: true, actor: null }), /^Movido automaticamente para dentro de ALFA-12 Título/],
    [entry<"parent_changed">({ type: "parent_changed", from: ref(12), to: null, automatic: true, actor: null }), /^Tirado automaticamente de dentro de ALFA-12 Título 12/],
    [entry<"parent_changed">({ type: "parent_changed", from: ref(12), to: ref(13), automatic: true, actor: null }), /^Movido automaticamente de ALFA-12 Título 12 para dentro de ALFA-13 Título 13/],
    [entry<"assignee_added">({ type: "assignee_added", person: bruno, automatic: true, actor: null }), /^Bruno adicionado automaticamente como responsável/],
    [entry<"assignee_removed">({ type: "assignee_removed", person: bruno, automatic: true, actor: null }), /^Bruno tirado automaticamente dos responsáveis/],
    [entry<"title_changed">({ type: "title_changed", from: "x", to: "y" }), /^Ana mudou o título de «x» para «y»/],
  ])("automática: %j", async (item, expected) => {
    setup({ "": page([item]) });
    const [text] = await texts();
    expect(text).toMatch(expected);
  });

  it.each([
    ["en", "Activity", /^Title changed automatically from “x” to “y”/],
    ["es-MX", "Actividad", /^Título cambiado automáticamente de «x» a «y»/],
  ] as const)("automática em %s", async (language, region, expected) => {
    await setTestLanguage(language);
    setup({ "": page([entry<"title_changed">({ type: "title_changed", from: "x", to: "y", automatic: true, actor: null })]) });
    const view = within(await screen.findByRole("region", { name: region }));
    expect(textOf(await view.findByRole("listitem"))).toMatch(expected);
  });

  it("entrada sem autor usa uma frase sem sujeito", async () => {
    setup({ "": page([
      entry<"created">({ type: "created", actor: null }),
      entry<"title_changed">({ type: "title_changed", from: "a", to: "b", actor: null }),
      entry<"status_changed">({ type: "status_changed", from: "todo", to: "done", automatic: false, causedBy: null, actor: null }),
      entry<"parent_changed">({ type: "parent_changed", from: null, to: ref(3), actor: null }),
      entry<"assignee_added">({ type: "assignee_added", person: bruno, actor: null }),
      entry<"dependency_added">({ type: "dependency_added", ticket: ref(4), actor: null }),
      entry<"summary_updated">({ type: "summary_updated", source: "assistant", actor: null }),
    ]) });
    const all = (await texts()).reverse();
    expect(all[0]).toMatch(/^Ticket criado/);
    expect(all[1]).toMatch(/^Título mudado de «a» para «b»/);
    expect(all[2]).toMatch(/^Situação mudada de A fazer para Concluído/);
    expect(all[3]).toMatch(/^Movido para dentro de ALFA-3/);
    expect(all[4]).toMatch(/^Bruno adicionado como responsável/);
    expect(all[5]).toMatch(/^Passou a depender de ALFA-4/);
    expect(all[6]).toMatch(/^«O que entra aqui» foi atualizado pela IA/);
  });

  it("as frases saem nos três idiomas", async () => {
    const items = [
      entry<"status_changed">({ type: "status_changed", from: "todo", to: "in_progress", automatic: false, causedBy: null }),
      entry<"parent_changed">({ type: "parent_changed", from: null, to: ref(12, "Título") }),
    ];
    await setTestLanguage("en");
    setup({ "": page(items) });
    const view = within(await screen.findByRole("region", { name: "Activity" }));
    const en = (await view.findAllByRole("listitem")).map(textOf);
    expect(en[0]).toMatch(/Ana moved it inside ALFA-12 Título/);
    expect(en[1]).toMatch(/Ana changed the status from To do to In progress/);
  });

  it("em espanhol", async () => {
    await setTestLanguage("es-MX");
    setup({ "": page([entry<"assignee_added">({ type: "assignee_added", person: bruno })]) });
    const view = within(await screen.findByRole("region", { name: "Actividad" }));
    expect(textOf(await view.findByRole("listitem"))).toMatch(/Ana agregó a Bruno como responsable/);
  });
});

describe("seção Atividade: lista", () => {
  it("fica no fim da página, depois de Itens, e mostra do mais antigo para o mais novo", async () => {
    const newest = entry<"title_changed">({ type: "title_changed", from: "b", to: "c", occurredAt: at(1) });
    const oldest = entry<"created">({ type: "created", occurredAt: at(100) });
    setup({ "": page([newest, oldest]) });
    const list = await texts();
    expect(list[0]).toMatch(/criou este ticket/);
    expect(list[1]).toMatch(/mudou o título/);
    const text = screen.getByRole("complementary").textContent ?? "";
    expect(text.indexOf("Itens")).toBeLessThan(text.indexOf("Atividade"));
  });

  it("cada linha tem as iniciais ou a imagem de quem fez, a frase e a data com o completo no title", async () => {
    setup({ "": page([entry<"description_changed">({ type: "description_changed", actor: bruno, occurredAt: at(5) }), entry<"created">({ type: "created", occurredAt: at(2000) })]) });
    const first = (await rows())[1];
    expect(first!.querySelector("img")).toHaveAttribute("src", "https://img.test/bruno.png");
    expect(within(first!).getByText("há 5 minutos")).toHaveAttribute("title", expect.stringMatching(/2026/));
    expect(within(first!).getByText("há 5 minutos").tagName).toBe("TIME");
    const created = (await rows())[0]!;
    expect(created).toHaveTextContent("ontem");
  });

  it("sem imagem, mostra as iniciais", async () => {
    setup({ "": page([entry<"created">({ type: "created" })]) });
    expect(within((await rows())[0]!).getByText("A")).toBeInTheDocument();
  });

  it("vazio", async () => {
    setup({ "": page([]) });
    expect(await within(await section()).findByText("Nenhuma atividade registrada.")).toBeInTheDocument();
  });

  it("carregando", async () => {
    let release: (value: unknown) => void = () => undefined;
    setup(() => new Promise((resolve) => { release = resolve; }));
    expect(await within(await section()).findByText("Carregando atividade…")).toBeInTheDocument();
    release(ok(page([])));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Atividade" })).queryByText("Carregando atividade…")).not.toBeInTheDocument());
  });

  it("erro tem Tentar de novo e não derruba o resto da página", async () => {
    let fail = true;
    const { ticketActivity } = setup(async () => (fail ? failed("unavailable") : ok(page([entry<"created">({ type: "created" })]))));
    const region = await section();
    expect(await within(region).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(region).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(region).findByText(/criou este ticket/)).toBeInTheDocument();
    expect(ticketActivity).toHaveBeenCalledTimes(2);
  });

  it("o cliente que lança (rede, bug) também vira erro só na seção", async () => {
    setup(async () => { throw new Error("boom"); });
    expect(await within(await section()).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});

describe("seção Atividade: tickets citados", () => {
  it("referência existente abre o ticket; ticket removido não é clicável", async () => {
    const { onOpenTicket } = setup({ "": page([
      entry<"dependency_added">({ type: "dependency_added", ticket: gone("ALFA-9") }),
      entry<"dependency_added">({ type: "dependency_added", ticket: ref(7, "Banco") }),
    ]) });
    const region = await section();
    await userEvent.click(await within(region).findByRole("button", { name: /ALFA-7 Banco/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("r7");
    expect(within(region).queryByRole("button", { name: /ALFA-9/ })).not.toBeInTheDocument();
    expect(within(region).getByText("ALFA-9 (ticket removido)")).toBeInTheDocument();
  });
});

describe("seção Atividade: Mostrar anteriores", () => {
  const first = page([entry<"title_changed">({ id: "n2", type: "title_changed", from: "b", to: "c" }), entry<"title_changed">({ id: "n1", type: "title_changed", from: "a", to: "b" })], "cursor-1");
  const second = page([entry<"created">({ id: "n0", type: "created" })], null);

  it("só aparece com cursor; busca a página seguinte com o cursor e a põe acima", async () => {
    const { ticketActivity } = setup({ "": first, "cursor-1": second });
    const region = await section();
    await within(region).findByText(/mudou o título de «a»/);
    await userEvent.click(within(region).getByRole("button", { name: "Mostrar anteriores" }));
    await within(region).findByText(/criou este ticket/);
    expect(ticketActivity).toHaveBeenLastCalledWith("t1", { before: "cursor-1", limit: 30 }, expect.anything());
    const all = await texts();
    expect(all[0]).toMatch(/criou este ticket/);
    expect(all[2]).toMatch(/«b» para «c»/);
    expect(within(region).queryByRole("button", { name: "Mostrar anteriores" })).not.toBeInTheDocument();
  });

  it("sem cursor não há botão", async () => {
    setup({ "": second });
    await section();
    await rows();
    expect(screen.queryByRole("button", { name: "Mostrar anteriores" })).not.toBeInTheDocument();
  });

  it("erro ao buscar as anteriores mantém o que já está na tela e deixa tentar de novo", async () => {
    let fail = true;
    setup(async (before) => (before === undefined ? ok(first) : fail ? failed("unavailable") : ok(second)));
    const region = await section();
    await within(region).findByText(/mudou o título de «a»/);
    await userEvent.click(within(region).getByRole("button", { name: "Mostrar anteriores" }));
    expect(await within(region).findByRole("alert")).toBeInTheDocument();
    expect(await texts()).toHaveLength(2);
    fail = false;
    await userEvent.click(within(region).getByRole("button", { name: "Mostrar anteriores" }));
    await within(region).findByText(/criou este ticket/);
    expect(await texts()).toHaveLength(3);
  });
});

describe("seção Atividade: atualização", () => {
  it("depois de uma alteração feita na página, a atividade é buscada de novo", async () => {
    const { ticketActivity, client } = setup({ "": page([entry<"created">({ type: "created" })]) });
    await within(await section()).findByText(/criou este ticket/);
    expect(ticketActivity).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "A fazer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Em andamento" }));
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t1", { status: "in_progress" }));
    await waitFor(() => expect(ticketActivity).toHaveBeenCalledTimes(2));
  });

  it("a nova primeira página substitui a lista, sem piscar a seção", async () => {
    let call = 0;
    setup(async () => ok(page(call++ === 0 ? [entry<"created">({ id: "a", type: "created" })] : [entry<"title_changed">({ id: "b", type: "title_changed", from: "x", to: "y" }), entry<"created">({ id: "a", type: "created" })])));
    await within(await section()).findByText(/criou este ticket/);
    await userEvent.click(screen.getByRole("button", { name: "A fazer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Em andamento" }));
    await within(await section()).findByText(/mudou o título de «x» para «y»/);
    expect(within(await section()).queryByText("Carregando atividade…")).not.toBeInTheDocument();
    expect(await texts()).toHaveLength(2);
  });
});

describe("seção Atividade: não altera o que a página já faz", () => {
  it("projeto arquivado ou leitor: a seção aparece do mesmo jeito", async () => {
    setup({ "": page([entry<"created">({ type: "created" })]) }, { archived: true });
    expect(await within(await section()).findByText(/criou este ticket/)).toBeInTheDocument();
  });
});

describe("activity: idea entries (ADR 0042)", () => {
  it("writes the five idea sentences from the catalog", async () => {
    setup({
      "": page([
        entry<"idea_registered">({ type: "idea_registered" }),
        entry<"idea_stage_changed">({ type: "idea_stage_changed", from: "new", to: "refining" }),
        entry<"idea_accepted">({ type: "idea_accepted" }),
        entry<"idea_discarded">({ type: "idea_discarded" }),
        entry<"idea_reopened">({ type: "idea_reopened" }),
      ]),
    });
    // A API manda da mais recente para a mais antiga; a seção mostra a mais antiga primeiro.
    expect(await texts()).toEqual([
      "Ana reabriu a ideia",
      "Ana descartou a ideia",
      "Ana aceitou a ideia",
      "Ana mudou o estágio de Nova para Em refinamento",
      "Ana registrou como ideia",
    ]);
  });

  it("without an actor, writes the impersonal sentences", async () => {
    setup({ "": page([entry<"idea_accepted">({ type: "idea_accepted", actor: null }), entry<"idea_stage_changed">({ type: "idea_stage_changed", actor: null, from: "refining", to: "ready" })]) });
    expect(await texts()).toEqual(["Estágio mudado de Em refinamento para Pronta para triagem", "Ideia aceita"]);
  });
});

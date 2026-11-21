import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";
import type { TicketPageProps } from "./TicketPage.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const archivedProject = makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno"), makePerson("person-3", "Carla"), makePerson("person-4", "Davi", { active: false })];

// t1 (raiz, com filhos): t2 (folha, Bruno), t3 (concluída), t6 (sem filhos). t7 (raiz, um filho aberto): t8 aberto, t9 concluído.
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", status: "in_review", progress: { done: 1, total: 3, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress", assigneeIds: ["person-2"] }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Outra raiz", { key: "ALFA-4" }),
  makeTicket("t5", "p1", 5, "Fase vazia", { key: "ALFA-5" }),
  makeTicket("t6", "p1", 6, "Subfase", { key: "ALFA-6", parentId: "t1" }),
  makeTicket("t7", "p1", 7, "Um item em aberto", { key: "ALFA-7", progress: { done: 1, total: 2, excluded: 0 } }),
  makeTicket("t8", "p1", 8, "Falta fazer", { key: "ALFA-8", parentId: "t7" }),
  makeTicket("t9", "p1", 9, "Já feito", { key: "ALFA-9", parentId: "t7", status: "done" }),
];
const detailOf = (summary: TicketSummary, description = "Descrição de teste"): TicketDetail => ({
  ...summary, description, createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});

interface Options {
  me?: Me;
  project?: Project;
  ticketId?: string | null;
  creating?: TicketPageProps["creating"];
  client?: ApiClient;
}

function setup(options: Options = {}) {
  const client = options.client ?? makeClient({ projects: [options.project ?? project], people, tickets: { p1: summaries } });
  const handlers = {
    onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(),
    onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn(),
  };
  render(
    <TicketPage
      client={client}
      me={options.me ?? makePanelMe("admin")}
      projects={[options.project ?? project]}
      ticketId={options.ticketId === undefined ? "t2" : options.ticketId}
      creating={options.creating ?? null}
      {...handlers}
    />,
  );
  return { client, ...handlers };
}

/** Cliente com `getTicket` configurado: o `makeClient` base lança nos métodos de escrita. */
function clientWith(extra: Partial<Record<keyof ApiClient, unknown>> = {}, projectOverride: Project = project): ApiClient {
  const client = makeClient({ projects: [projectOverride], people, tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => {
      const found = summaries.find((entry) => entry.id === id);
      return found ? ok(detailOf(found)) : failed("not_found");
    }),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    putTicketAssignee: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    removeTicketAssignee: vi.fn(async () => ok(undefined)),
    removeTicket: vi.fn(async () => ok(undefined)),
    createTicket: vi.fn(async () => ok(detailOf(makeTicket("t99", "p1", 99, "Novo")))),
    ...extra,
  });
  return client;
}
const page = () => screen.getByRole("complementary", { name: "Página do ticket" });
const loaded = async () => screen.findByRole("heading", { level: 1 });

describe("TicketPage content", () => {
  it("shows the key, the ancestors path, the title, the state, the people, the parent and the description of a leaf", async () => {
    setup({ client: clientWith() });
    expect(await loaded()).toHaveTextContent("Escrever o texto");
    const view = within(page());
    expect(view.getByText("ALFA-2")).toBeInTheDocument();
    expect(view.getByText("Projeto Alfa › Planejar a fase")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Em andamento" })).toHaveAttribute("aria-haspopup", "menu");
    expect(view.queryByRole("menu")).not.toBeInTheDocument();
    expect(view.getByText("Bruno")).toBeInTheDocument();
    expect(view.getByRole("button", { name: /ALFA-1.*Planejar a fase/ })).toBeInTheDocument();
    expect(view.getByText("Descrição de teste")).toBeInTheDocument();
  });

  it("moves the focus to the title when the page opens", async () => {
    setup({ client: clientWith() });
    expect(await loaded()).toHaveFocus();
  });

  it("a ticket with children has the same page: its own status, the progress and the items, with no type mark", async () => {
    const { onOpenTicket } = setup({ client: clientWith(), ticketId: "t1" });
    expect(await loaded()).toHaveTextContent("Planejar a fase");
    const view = within(page());
    expect(view.queryByText("Agrupador")).not.toBeInTheDocument();
    expect(view.getByText("Situação")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Em revisão" })).toHaveAttribute("aria-haspopup", "menu");
    expect(view.getByText("Progresso")).toBeInTheDocument();
    expect(view.getByText("1 de 3 concluídos")).toBeInTheDocument();
    expect(view.getByText("Raiz do projeto")).toBeInTheDocument();
    expect(view.getByText("Pessoas")).toBeInTheDocument();
    expect(view.getByText("Descrição de teste")).toBeInTheDocument();
    const list = view.getByRole("list", { name: "Itens" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByRole("button", { name: /ALFA-3.*Revisar o texto.*Concluído/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /ALFA-6.*Subfase.*A fazer/ })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: /ALFA-3.*Revisar o texto/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t3");
  });

  it("shows the section order of the old group page, with the status where the ticket page had it", async () => {
    setup({ client: clientWith(), ticketId: "t1" });
    await loaded();
    const text = page().textContent ?? "";
    const order = ["Situação", "Progresso", "Pessoas", "Ticket pai", "Descrição", "Itens"].map((label) => text.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("a ticket without children has no progress row, but the status, the empty items list and the create action", async () => {
    setup({ client: clientWith(), ticketId: "t5" });
    await loaded();
    const view = within(page());
    expect(view.getByText("Situação")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "A fazer" })).toHaveAttribute("aria-haspopup", "menu");
    expect(view.queryByText("Progresso")).not.toBeInTheDocument();
    expect(view.queryByText("vazio")).not.toBeInTheDocument();
    expect(view.getByRole("heading", { name: "Itens" })).toBeInTheDocument();
    expect(view.getByText("Nenhum ticket aqui dentro.")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Novo ticket aqui dentro" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: /Transformar/ })).not.toBeInTheDocument();
  });

  it("a leaf with a status also has the items section and Novo ticket aqui dentro", async () => {
    setup({ client: clientWith() });
    await loaded();
    const view = within(page());
    expect(view.queryByText("Subtickets")).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Novo subticket" })).not.toBeInTheDocument();
    expect(view.getByRole("heading", { name: "Itens" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Novo ticket aqui dentro" })).toBeInTheDocument();
    expect(view.getByText("Situação")).toBeInTheDocument();
  });

  it("a parent whose items are all finalized shows the progress with the base and its own status", async () => {
    const done = [
      makeTicket("a", "p1", 1, "Pai", { key: "ALFA-1", status: "in_progress", progress: { done: 2, total: 2, excluded: 1 } }),
      makeTicket("b", "p1", 2, "Feito", { key: "ALFA-2", parentId: "a", status: "done" }),
      makeTicket("c", "p1", 3, "Feito 2", { key: "ALFA-3", parentId: "a", status: "done" }),
      makeTicket("d", "p1", 4, "Cancelado", { key: "ALFA-4", parentId: "a", status: "cancelled" }),
    ];
    const client = makeClient({ projects: [project], people, tickets: { p1: done } });
    Object.assign(client, { getTicket: vi.fn(async (id: string) => ok(detailOf(done.find((entry) => entry.id === id)!))) });
    setup({ client, ticketId: "a" });
    await loaded();
    const view = within(page());
    expect(view.getByText("2 de 2 concluídos · 1 cancelado")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Em andamento" })).toHaveAttribute("aria-haspopup", "menu");
  });

  it("opens the parent when the parent is clicked", async () => {
    const { onOpenTicket } = setup({ client: clientWith() });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-1.*Planejar a fase/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t1");
  });

  it("shows loading, then a not-found message with the close action for an unknown ticket", async () => {
    const { onClose } = setup({ client: clientWith(), ticketId: "inexistente" });
    expect(screen.getByRole("status")).toHaveTextContent("Carregando ticket");
    expect(await screen.findByRole("alert")).toHaveTextContent("Não encontramos esse item");
    await userEvent.click(within(page()).getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes with the button and with Esc outside editing", async () => {
    const { onClose } = setup({ client: clientWith() });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("TicketPage editing", () => {
  it("changes the state at once with one call and reloads the page and the map", async () => {
    const client = clientWith();
    const { onChanged } = setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Em andamento" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Em revisão" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t2", { status: "in_review" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.getTicket).toHaveBeenCalledTimes(2));
  });

  it("shows the API error next to the state control and clears it after the next success", async () => {
    const updateTicket = vi.fn().mockResolvedValueOnce(failed("conflict", "project_archived")).mockImplementation(async () => ok(detailOf(summaries[1]!)));
    setup({ client: clientWith({ updateTicket }) });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Em andamento" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O projeto está arquivado");
    await userEvent.click(within(page()).getByRole("button", { name: "Em andamento" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("changes the status of a ticket that has items too", async () => {
    const client = clientWith();
    setup({ client, ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "A fazer" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t1", { status: "todo" });
  });

  it("refuses to conclude with open items: plural message with the open direct items, and the status goes back", async () => {
    const updateTicket = vi.fn(async () => failed("conflict", "ticket_has_open_children"));
    const { onChanged } = setup({ client: clientWith({ updateTicket }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    expect(updateTicket).toHaveBeenCalledWith("t1", { status: "done" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Conclua ou cancele os 2 itens abertos antes de concluir este ticket.");
    // A situação volta ao que era: o botão ainda mostra "Em revisão".
    expect(within(page()).getByRole("button", { name: "Em revisão" })).toHaveAttribute("aria-haspopup", "menu");
    expect(within(page()).queryByRole("button", { name: "Concluído" })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("refuses to conclude with one open item: singular message", async () => {
    setup({ client: clientWith({ updateTicket: vi.fn(async () => failed("conflict", "ticket_has_open_children")) }), ticketId: "t7" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "A fazer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Conclua ou cancele o item aberto antes de concluir este ticket.");
    expect(within(page()).getByRole("button", { name: "A fazer" })).toHaveAttribute("aria-haspopup", "menu");
  });

  it("the open-items message sits next to the status control and goes away after the next success", async () => {
    const updateTicket = vi.fn().mockResolvedValueOnce(failed("conflict", "ticket_has_open_children")).mockImplementation(async () => ok(detailOf(summaries[0]!)));
    setup({ client: clientWith({ updateTicket }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    const alert = await screen.findByRole("alert");
    expect(within(page()).getByRole("button", { name: "Em revisão" }).closest("dd")).toContainElement(alert);
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "A fazer" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("edits the title and sends only the changed field; Cancelar discards", async () => {
    const client = clientWith();
    setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Editar título" }));
    const field = screen.getByRole("textbox", { name: "Título" });
    expect(field).toHaveValue("Escrever o texto");
    await userEvent.clear(field);
    await userEvent.type(field, "Texto novo");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(client.updateTicket).not.toHaveBeenCalled();
    expect(await loaded()).toHaveTextContent("Escrever o texto");

    await userEvent.click(within(page()).getByRole("button", { name: "Editar título" }));
    const again = screen.getByRole("textbox", { name: "Título" });
    await userEvent.clear(again);
    await userEvent.type(again, "Texto novo");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t2", { title: "Texto novo" });
  });

  it("does not save an empty or unchanged title", async () => {
    setup({ client: clientWith() });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Editar título" }));
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    await userEvent.clear(screen.getByRole("textbox", { name: "Título" }));
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("adds a person from the active ones not yet assigned and removes an assigned one", async () => {
    const client = clientWith();
    setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Adicionar" }));
    const select = screen.getByRole("combobox", { name: "Adicionar pessoa" });
    const names = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(names).toEqual(["Escolher pessoa", "Ana", "Carla"]);
    await userEvent.selectOptions(select, "Carla");
    expect(client.putTicketAssignee).toHaveBeenCalledWith("t2", "person-3");

    await userEvent.click(within(page()).getByRole("button", { name: "Remover Bruno" }));
    expect(client.removeTicketAssignee).toHaveBeenCalledWith("t2", "person-2");
  });

  it.each([
    ["person_without_project_access", "A pessoa ainda não tem acesso ao projeto"],
    ["person_inactive", "A pessoa não está mais na organização"],
  ])("shows %s next to the people control", async (code, text) => {
    setup({ client: clientWith({ putTicketAssignee: vi.fn(async () => failed("conflict", code)) }) });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Adicionar" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Adicionar pessoa" }), "Ana");
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("changes the parent, offering the root and every ticket of the project but itself and its descendants", async () => {
    const client = clientWith();
    setup({ client, ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o ticket pai" });
    const options = within(picker).getAllByRole("button").map((button) => button.textContent);
    expect(options).toEqual(["Raiz do projeto", "ALFA-4Outra raiz", "ALFA-5Fase vazia", "ALFA-7Um item em aberto", "ALFA-8Falta fazer", "ALFA-9Já feito"]);
    await userEvent.type(within(picker).getByRole("textbox", { name: "Filtrar tickets" }), "vazia");
    await userEvent.click(within(picker).getByRole("button", { name: /Fase vazia/ }));
    expect(client.updateTicket).toHaveBeenCalledWith("t1", { parentId: "t5" });
  });

  it("offers a ticket without children as the new parent, and never a descendant, even a deep one", async () => {
    const deep = [...summaries, makeTicket("t10", "p1", 10, "Neto", { key: "ALFA-10", parentId: "t6" })];
    const client = makeClient({ projects: [project], people, tickets: { p1: deep } });
    Object.assign(client, { getTicket: vi.fn(async (id: string) => ok(detailOf(deep.find((entry) => entry.id === id)!))) });
    setup({ client, ticketId: "t4" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o ticket pai" });
    const labels = within(picker).getAllByRole("button").map((button) => button.textContent);
    expect(labels).toContain("ALFA-5Fase vazia");
    expect(labels).toContain("ALFA-10Neto");
    expect(labels).not.toContain("ALFA-4Outra raiz");
    await userEvent.click(within(picker).getByRole("button", { name: /Fase vazia/ }));
    expect(client.updateTicket).toHaveBeenCalledWith("t4", { parentId: "t5" });
  });

  it("does not offer the descendants of a ticket as its parent", async () => {
    const deep = [...summaries, makeTicket("t10", "p1", 10, "Neto", { key: "ALFA-10", parentId: "t6" })];
    const client = makeClient({ projects: [project], people, tickets: { p1: deep } });
    Object.assign(client, { getTicket: vi.fn(async (id: string) => ok(detailOf(deep.find((entry) => entry.id === id)!))) });
    setup({ client, ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const labels = within(screen.getByRole("group", { name: "Escolher o ticket pai" })).getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["Raiz do projeto", "ALFA-4Outra raiz", "ALFA-5Fase vazia", "ALFA-7Um item em aberto", "ALFA-8Falta fazer", "ALFA-9Já feito"]);
  });

  it("moves a ticket to the project root and filters the tickets by key", async () => {
    const client = clientWith();
    setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o ticket pai" });
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["Raiz do projeto", "ALFA-1Planejar a fase", "ALFA-3Revisar o texto", "ALFA-4Outra raiz", "ALFA-5Fase vazia", "ALFA-6Subfase", "ALFA-7Um item em aberto", "ALFA-8Falta fazer", "ALFA-9Já feito"]);
    await userEvent.type(within(picker).getByRole("textbox", { name: "Filtrar tickets" }), "ALFA-5");
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["ALFA-5Fase vazia"]);
    await userEvent.clear(within(picker).getByRole("textbox", { name: "Filtrar tickets" }));
    await userEvent.click(within(picker).getByRole("button", { name: "Raiz do projeto" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t2", { parentId: null });
  });

  it("shows ticket_cycle next to the parent control", async () => {
    setup({ client: clientWith({ updateTicket: vi.fn(async () => failed("conflict", "ticket_cycle")) }) });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    await userEvent.click(screen.getByRole("button", { name: "Raiz do projeto" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Um ticket não pode ser pai de si mesmo");
  });

  it("removes with a second click and tells the host", async () => {
    const client = clientWith();
    const { onRemoved } = setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    expect(client.removeTicket).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(client.removeTicket).toHaveBeenCalledWith("t2");
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("shows ticket_has_children as a removal message when the API refuses to remove a ticket with items", async () => {
    const { onRemoved } = setup({ client: clientWith({ removeTicket: vi.fn(async () => failed("conflict", "ticket_has_children")) }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este ticket tem itens. Mova ou remova os itens antes de removê-lo.");
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe("TicketPage removal wording", () => {
  it("every ticket says Remover ticket, with or without items", async () => {
    setup({ client: clientWith(), ticketId: "t5" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    expect(within(page()).getByRole("button", { name: "Remover ticket" })).toBeInTheDocument();
    expect(within(page()).queryByRole("button", { name: "Remover agrupador" })).not.toBeInTheDocument();
  });

  it("a ticket without items is removed with a confirmation", async () => {
    const client = clientWith();
    const { onRemoved } = setup({ client, ticketId: "t5" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    expect(client.removeTicket).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(client.removeTicket).toHaveBeenCalledWith("t5");
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });
});

describe("TicketPage permissions", () => {
  it("hides removal from a contributor, who can still edit", async () => {
    setup({ client: clientWith(), me: makePanelMe("member", [{ projectId: "p1", role: "contributor" }]) });
    await loaded();
    expect(within(page()).queryByRole("button", { name: "Remover ticket" })).not.toBeInTheDocument();
    expect(within(page()).getByRole("button", { name: "Editar título" })).toBeInTheDocument();
  });

  it("is read-only for a reader: no edit, add, change or create controls", async () => {
    setup({ client: clientWith(), me: makePanelMe("member", [{ projectId: "p1", role: "reader" }]), ticketId: "t1" });
    await loaded();
    const view = within(page());
    for (const name of ["Editar título", "Adicionar", "Mudar", "Novo ticket aqui dentro", "Remover ticket", "Em revisão", "Concluído"]) {
      expect(view.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(view.queryByRole("group", { name: "Descrição" })).not.toBeInTheDocument();
    expect(view.getByText("Você tem acesso só de leitura a este projeto.")).toBeInTheDocument();
    expect(view.getByText("Planejar a fase")).toBeInTheDocument();
    expect(view.getByText("Em revisão")).toBeInTheDocument();
    expect(view.getByRole("list", { name: "Itens" })).toBeInTheDocument();
  });

  it("a reader sees the empty items state with no action to create", async () => {
    setup({ client: clientWith(), me: makePanelMe("member", [{ projectId: "p1", role: "reader" }]), ticketId: "t5" });
    await loaded();
    expect(within(page()).getByText("Nenhum ticket aqui dentro.")).toBeInTheDocument();
    expect(within(page()).queryByRole("button", { name: "Novo ticket aqui dentro" })).not.toBeInTheDocument();
  });

  it("an archived project shows the empty items state with no action to create", async () => {
    setup({ client: clientWith({}, archivedProject), project: archivedProject, ticketId: "t5" });
    await loaded();
    expect(within(page()).getByText("Nenhum ticket aqui dentro.")).toBeInTheDocument();
    expect(within(page()).queryByRole("button", { name: "Novo ticket aqui dentro" })).not.toBeInTheDocument();
  });

  it("is read-only in an archived project and says why", async () => {
    setup({ client: clientWith({}, archivedProject), project: archivedProject });
    await loaded();
    const view = within(page());
    expect(view.getByText("O projeto está arquivado: esta página é só de leitura.")).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Editar título" })).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Em revisão" })).not.toBeInTheDocument();
    expect(view.getByText("Em andamento")).toBeInTheDocument();
  });
});

describe("TicketPage creation", () => {
  it("offers Novo ticket aqui dentro in a ticket with items and hands the request, with no type, to the host", async () => {
    const { onStartCreate } = setup({ client: clientWith(), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Novo ticket aqui dentro" }));
    expect(onStartCreate).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", parent: { key: "ALFA-1", status: "in_review" } });
  });

  it("offers it in a ticket without items too, and there is no Novo agrupador anywhere", async () => {
    const { onStartCreate } = setup({ client: clientWith(), ticketId: "t5" });
    await loaded();
    expect(within(page()).queryByRole("button", { name: "Novo agrupador" })).not.toBeInTheDocument();
    await userEvent.click(within(page()).getByRole("button", { name: "Novo ticket aqui dentro" }));
    expect(onStartCreate).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t5", parent: { key: "ALFA-5", status: "todo" } });
  });

  it("creates a ticket inside a ticket with a required title and no description (typing one is in the browser suite), then hands over the new ticket", async () => {
    const client = clientWith();
    const { onCreated, onChanged } = setup({ client, creating: { projectId: "p1", parentId: "t1" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Criar" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "Escrever o rascunho");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Escrever o rascunho", parentId: "t1" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t99"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("creates a root ticket without a parent and without an empty description", async () => {
    const client = clientWith();
    setup({ client, ticketId: null, creating: { projectId: "p1", parentId: null } });
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "  Raiz nova ");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Raiz nova" });
  });

  it("shows a creation error next to the form and cancels back to the host", async () => {
    const { onCancelCreate, onCreated } = setup({ client: clientWith({ createTicket: vi.fn(async () => failed("conflict", "project_archived")) }), creating: { projectId: "p1", parentId: null } });
    await userEvent.type(await screen.findByRole("textbox", { name: "Título" }), "X");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O projeto está arquivado");
    expect(onCreated).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancelCreate).toHaveBeenCalled();
  });

  it("cancels creation with Esc", async () => {
    const { onCancelCreate, onClose } = setup({ client: clientWith(), creating: { projectId: "p1", parentId: null } });
    await screen.findByRole("textbox", { name: "Título" });
    await userEvent.keyboard("{Escape}");
    expect(onCancelCreate).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("reopening warnings (ADR 0034)", () => {
  // t20 concluído (com filho t21 concluído); t22 aberto, solto; t23 concluído, solto; t24 em andamento, com filho.
  const reopening: TicketSummary[] = [
    makeTicket("t20", "p1", 20, "Pai concluído", { key: "ALFA-20", status: "done", progress: { done: 1, total: 1, excluded: 0 } }),
    makeTicket("t21", "p1", 21, "Filho concluído", { key: "ALFA-21", parentId: "t20", status: "done" }),
    makeTicket("t22", "p1", 22, "Aberto solto", { key: "ALFA-22" }),
    makeTicket("t23", "p1", 23, "Concluído solto", { key: "ALFA-23", status: "done" }),
    makeTicket("t24", "p1", 24, "Em andamento", { key: "ALFA-24", status: "in_progress", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t25", "p1", 25, "Cancelado", { key: "ALFA-25", status: "cancelled" }),
  ];
  const clientFor = () => {
    const client = makeClient({ projects: [project], people, tickets: { p1: reopening } });
    Object.assign(client, {
      getTicket: vi.fn(async (id: string) => ok(detailOf(reopening.find((entry) => entry.id === id)!))),
      updateTicket: vi.fn(async (id: string) => ok(detailOf(reopening.find((entry) => entry.id === id)!))),
    });
    return client;
  };
  const move = async (ticketId: string, parent: RegExp) => {
    setup({ client: clientFor(), ticketId });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Escolher o ticket pai" })).getByRole("button", { name: parent }));
  };
  const notice = (key: string) => `«${key}» estava concluído e voltou para "A fazer".`;

  it("hands the concluded ticket to the create form, so it can warn, from Novo ticket aqui dentro", async () => {
    const { onStartCreate } = setup({ client: clientFor(), ticketId: "t20" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Novo ticket aqui dentro" }));
    expect(onStartCreate).toHaveBeenCalledWith({ projectId: "p1", parentId: "t20", parent: { key: "ALFA-20", status: "done" } });
  });

  it("after moving an open ticket under a concluded parent, tells that the parent was reopened", async () => {
    await move("t22", /ALFA-20/);
    expect(await within(page()).findByText(notice("ALFA-20"))).toBeInTheDocument();
  });

  it("does not tell anything when the ticket that moves in is finalized", async () => {
    await move("t23", /ALFA-20/);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Escolher o ticket pai" })).not.toBeInTheDocument());
    expect(within(page()).queryByText(/voltou para/)).not.toBeInTheDocument();
  });

  it("does not tell anything when the new parent is not concluded", async () => {
    await move("t22", /ALFA-24/);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Escolher o ticket pai" })).not.toBeInTheDocument());
    expect(within(page()).queryByText(/voltou para/)).not.toBeInTheDocument();
  });

  it("does not tell anything when the new parent is cancelled or the root", async () => {
    await move("t22", /ALFA-25/);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Escolher o ticket pai" })).not.toBeInTheDocument());
    expect(within(page()).queryByText(/voltou para/)).not.toBeInTheDocument();
  });

  it("does not tell anything when the move fails", async () => {
    const client = clientFor();
    Object.assign(client, { updateTicket: vi.fn(async () => failed("conflict", "ticket_cycle")) });
    setup({ client, ticketId: "t22" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Escolher o ticket pai" })).getByRole("button", { name: /ALFA-20/ }));
    await screen.findByRole("alert");
    expect(within(page()).queryByText(/voltou para/)).not.toBeInTheDocument();
  });
});

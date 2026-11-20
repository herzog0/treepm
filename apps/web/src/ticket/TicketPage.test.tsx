import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeGroup, makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";
import type { TicketPageProps } from "./TicketPage.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const archivedProject = makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno"), makePerson("person-3", "Carla"), makePerson("person-4", "Davi", { active: false })];

// t1 (raiz) → t2 (folha, Bruno), t3 (folha concluída); t5 é filho de t2? não: t4 é outra raiz; t6 filho de t3.
const summaries: TicketSummary[] = [
  makeGroup("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", progress: { done: 1, total: 2, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress", assigneeIds: ["person-2"] }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Outra raiz", { key: "ALFA-4" }),
  makeGroup("t5", "p1", 5, "Fase vazia", { key: "ALFA-5" }),
  makeGroup("t6", "p1", 6, "Subfase", { key: "ALFA-6", parentId: "t1" }),
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
    createTicket: vi.fn(async () => ok(detailOf(makeTicket("t9", "p1", 9, "Novo")))),
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
    expect(view.getByRole("button", { name: "Em andamento" })).toHaveAttribute("aria-pressed", "true");
    expect(view.getByRole("button", { name: "A fazer" })).toHaveAttribute("aria-pressed", "false");
    expect(view.getByText("Bruno")).toBeInTheDocument();
    expect(view.getByRole("button", { name: /ALFA-1.*Planejar a fase/ })).toBeInTheDocument();
    expect(view.getByText("Descrição de teste")).toBeInTheDocument();
  });

  it("moves the focus to the title when the page opens", async () => {
    setup({ client: clientWith() });
    expect(await loaded()).toHaveFocus();
  });

  it("a group says so in the header, shows progress instead of the state switch, and lists its items", async () => {
    const { onOpenTicket } = setup({ client: clientWith(), ticketId: "t1" });
    expect(await loaded()).toHaveTextContent("Planejar a fase");
    const view = within(page());
    expect(view.getByText("Agrupador")).toBeInTheDocument();
    expect(view.getByText("Progresso")).toBeInTheDocument();
    expect(view.queryByText("Situação")).not.toBeInTheDocument();
    expect(view.getByText("1 de 2 concluídos")).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Em revisão" })).not.toBeInTheDocument();
    expect(view.getByText("Raiz do projeto")).toBeInTheDocument();
    expect(view.getByText("Pessoas")).toBeInTheDocument();
    expect(view.getByText("Descrição de teste")).toBeInTheDocument();
    const list = view.getByRole("list", { name: "Itens" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByRole("button", { name: /ALFA-3.*Revisar o texto.*Concluído/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /ALFA-6.*Subfase.*vazio/ })).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: /ALFA-3.*Revisar o texto/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t3");
  });

  it("an empty group says 'vazio', has no items and offers Transformar em ticket", async () => {
    setup({ client: clientWith(), ticketId: "t5" });
    await loaded();
    const view = within(page());
    expect(view.getByText("vazio")).toBeInTheDocument();
    expect(view.getByText("Nenhum item ainda.")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Transformar em ticket" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Transformar em agrupador" })).not.toBeInTheDocument();
  });

  it("a group with items does not offer Transformar em ticket", async () => {
    setup({ client: clientWith(), ticketId: "t1" });
    await loaded();
    expect(within(page()).queryByRole("button", { name: "Transformar em ticket" })).not.toBeInTheDocument();
  });

  it("a ticket has no items list, no Novo subticket and offers Transformar em agrupador", async () => {
    setup({ client: clientWith() });
    await loaded();
    const view = within(page());
    expect(view.queryByText("Subtickets")).not.toBeInTheDocument();
    expect(view.queryByText("Itens")).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Novo subticket" })).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Novo ticket" })).not.toBeInTheDocument();
    expect(view.queryByText("Agrupador")).not.toBeInTheDocument();
    expect(view.getByRole("button", { name: "Transformar em agrupador" })).toBeInTheDocument();
    expect(view.getByText("Situação")).toBeInTheDocument();
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
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t2", { status: "in_review" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.getTicket).toHaveBeenCalledTimes(2));
  });

  it("shows the API error next to the state control and clears it after the next success", async () => {
    const updateTicket = vi.fn().mockResolvedValueOnce(failed("conflict", "project_archived")).mockImplementation(async () => ok(detailOf(summaries[1]!)));
    setup({ client: clientWith({ updateTicket }) });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Concluído" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O projeto está arquivado");
    await userEvent.click(within(page()).getByRole("button", { name: "Concluído" }));
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

  it("cancels the edit with Esc without closing the page", async () => {
    const { onClose } = setup({ client: clientWith() });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Editar descrição" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Descrição" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("edits the description and shows the API error next to it", async () => {
    const updateTicket = vi.fn().mockResolvedValueOnce(failed("not_found"));
    setup({ client: clientWith({ updateTicket }) });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Editar descrição" }));
    const field = screen.getByRole("textbox", { name: "Descrição" });
    await userEvent.clear(field);
    await userEvent.type(field, "Outro texto");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(updateTicket).toHaveBeenCalledWith("t2", { description: "Outro texto" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Não encontramos esse item");
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

  it("changes the parent, offering the root and the project groups but not tickets, itself or its descendants", async () => {
    const client = clientWith();
    setup({ client, ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o agrupador pai" });
    const options = within(picker).getAllByRole("button").map((button) => button.textContent);
    expect(options).toEqual(["Raiz do projeto", "ALFA-5Fase vazia"]);
    await userEvent.type(within(picker).getByRole("textbox", { name: "Filtrar agrupadores" }), "vazia");
    await userEvent.click(within(picker).getByRole("button", { name: /Fase vazia/ }));
    expect(client.updateTicket).toHaveBeenCalledWith("t1", { parentId: "t5" });
  });

  it("moves a ticket to the project root and filters the groups by key", async () => {
    const client = clientWith();
    setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o agrupador pai" });
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["Raiz do projeto", "ALFA-1Planejar a fase", "ALFA-5Fase vazia", "ALFA-6Subfase"]);
    await userEvent.type(within(picker).getByRole("textbox", { name: "Filtrar agrupadores" }), "ALFA-5");
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["ALFA-5Fase vazia"]);
    await userEvent.clear(within(picker).getByRole("textbox", { name: "Filtrar agrupadores" }));
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

  it("shows parent_not_group next to the parent control", async () => {
    setup({ client: clientWith({ updateTicket: vi.fn(async () => failed("conflict", "parent_not_group")) }) });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    await userEvent.click(screen.getByRole("button", { name: "Raiz do projeto" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Só um agrupador pode ter itens dentro dele.");
  });

  it("removes with a second click and tells the host", async () => {
    const client = clientWith();
    const { onRemoved } = setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Remover ticket" }));
    expect(client.removeTicket).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(client.removeTicket).toHaveBeenCalledWith("t2");
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("shows ticket_has_children as a removal message when the API refuses to remove a group with items", async () => {
    const { onRemoved } = setup({ client: clientWith({ removeTicket: vi.fn(async () => failed("conflict", "ticket_has_children")) }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Remover agrupador" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover agrupador" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mova ou remova os itens antes de removê-lo");
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe("TicketPage removal wording by kind", () => {
  it("a group says Remover agrupador, a ticket keeps Remover ticket", async () => {
    setup({ client: clientWith(), ticketId: "t5" });
    await loaded();
    expect(within(page()).getByRole("button", { name: "Remover agrupador" })).toBeInTheDocument();
    expect(within(page()).queryByRole("button", { name: "Remover ticket" })).not.toBeInTheDocument();
  });

  it("an empty group is removed with the group wording in the confirmation", async () => {
    const client = clientWith();
    const { onRemoved } = setup({ client, ticketId: "t5" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Remover agrupador" }));
    expect(client.removeTicket).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover agrupador" }));
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
    for (const name of ["Editar título", "Editar descrição", "Adicionar", "Mudar", "Novo ticket", "Novo agrupador", "Transformar em ticket", "Transformar em agrupador", "Remover ticket", "Remover agrupador"]) {
      expect(view.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(view.getByText("Você tem acesso só de leitura a este projeto.")).toBeInTheDocument();
    expect(view.getByText("Planejar a fase")).toBeInTheDocument();
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

describe("TicketPage kind changes", () => {
  it("turns a ticket into a group with one call, then reloads the page and the map", async () => {
    const client = clientWith();
    const { onChanged } = setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Transformar em agrupador" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t2", { kind: "group" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.getTicket).toHaveBeenCalledTimes(2));
  });

  it("shows the new type after the reload", async () => {
    const client = makeTreeClient({ projects: [project], people, tickets: { p1: summaries } });
    setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Transformar em agrupador" }));
    expect(await within(page()).findByText("Agrupador")).toBeInTheDocument();
    expect(within(page()).getByText("Progresso")).toBeInTheDocument();
    expect(within(page()).getByRole("button", { name: "Novo agrupador" })).toBeInTheDocument();
    expect(within(page()).getByRole("button", { name: "Transformar em ticket" })).toBeInTheDocument();
  });

  it("turns an empty group into a ticket with one call", async () => {
    const client = clientWith();
    setup({ client, ticketId: "t5" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Transformar em ticket" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t5", { kind: "ticket" });
  });

  it("shows the ticket_has_children message next to the button when the API refuses", async () => {
    const { onChanged } = setup({ client: clientWith({ updateTicket: vi.fn(async () => failed("conflict", "ticket_has_children")) }), ticketId: "t5" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Transformar em ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este agrupador tem itens. Mova ou remova os itens antes de transformá-lo em ticket.");
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("TicketPage creation", () => {
  it("offers Novo ticket and Novo agrupador in a group and hands the request to the host", async () => {
    const { onStartCreate } = setup({ client: clientWith(), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Novo ticket" }));
    expect(onStartCreate).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", kind: "ticket" });
    await userEvent.click(within(page()).getByRole("button", { name: "Novo agrupador" }));
    expect(onStartCreate).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", kind: "group" });
  });

  it("offers both creations in an empty group too", async () => {
    setup({ client: clientWith(), ticketId: "t5" });
    await loaded();
    expect(within(page()).getByRole("button", { name: "Novo ticket" })).toBeInTheDocument();
    expect(within(page()).getByRole("button", { name: "Novo agrupador" })).toBeInTheDocument();
  });

  it("creates a group inside a group: heading, kind sent, and the new node handed over", async () => {
    const client = clientWith({ createTicket: vi.fn(async () => ok(detailOf(makeGroup("t9", "p1", 9, "Nova fase")))) });
    const { onCreated } = setup({ client, creating: { projectId: "p1", parentId: "t1", kind: "group" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Novo agrupador" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "Nova fase");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Nova fase", parentId: "t1", kind: "group" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t9"));
  });

  it("creates a ticket inside a group with a required title and optional description, then hands over the new ticket", async () => {
    const client = clientWith();
    const { onCreated, onChanged } = setup({ client, creating: { projectId: "p1", parentId: "t1" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Criar" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "Escrever o rascunho");
    await userEvent.type(screen.getByRole("textbox", { name: "Descrição" }), "Primeira versão");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Escrever o rascunho", description: "Primeira versão", parentId: "t1", kind: "ticket" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t9"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("creates a root ticket without a parent and without an empty description", async () => {
    const client = clientWith();
    setup({ client, ticketId: null, creating: { projectId: "p1", parentId: null } });
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "  Raiz nova ");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Raiz nova", kind: "ticket" });
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

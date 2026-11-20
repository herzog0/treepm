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

// t1 (raiz) → t2 (folha, Bruno), t3 (folha concluída); t5 é filho de t2? não: t4 é outra raiz; t6 filho de t3.
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", progress: { done: 1, total: 2, excluded: 0 }, status: null }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress", assigneeIds: ["person-2"] }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Outra raiz", { key: "ALFA-4" }),
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

  it("shows progress, not the state switch, and lists the children of a ticket with children", async () => {
    const { onOpenTicket } = setup({ client: clientWith(), ticketId: "t1" });
    expect(await loaded()).toHaveTextContent("Planejar a fase");
    const view = within(page());
    expect(view.getByText("Progresso")).toBeInTheDocument();
    expect(view.getByText("1 de 2 concluídos")).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Em revisão" })).not.toBeInTheDocument();
    expect(view.getByText("Raiz do projeto")).toBeInTheDocument();
    const list = view.getByRole("list", { name: "Subtickets" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await userEvent.click(within(list).getByRole("button", { name: /ALFA-3.*Revisar o texto/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t3");
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

  it("changes the parent, offering the root and the project tickets but not itself or its descendants", async () => {
    const client = clientWith();
    setup({ client, ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o ticket pai" });
    const options = within(picker).getAllByRole("button").map((button) => button.textContent);
    expect(options).toEqual(["Raiz do projeto", "ALFA-4Outra raiz"]);
    await userEvent.type(within(picker).getByRole("textbox", { name: "Filtrar tickets" }), "outra");
    await userEvent.click(within(picker).getByRole("button", { name: /Outra raiz/ }));
    expect(client.updateTicket).toHaveBeenCalledWith("t1", { parentId: "t4" });
  });

  it("moves a ticket to the project root and filters by key", async () => {
    const client = clientWith();
    setup({ client });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    const picker = screen.getByRole("group", { name: "Escolher o ticket pai" });
    await userEvent.type(within(picker).getByRole("textbox", { name: "Filtrar tickets" }), "ALFA-3");
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["ALFA-3Revisar o texto"]);
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
    await userEvent.click(within(page()).getByRole("button", { name: "Remover ticket" }));
    expect(client.removeTicket).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(client.removeTicket).toHaveBeenCalledWith("t2");
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("shows ticket_has_children when the API refuses to remove", async () => {
    const { onRemoved } = setup({ client: clientWith({ removeTicket: vi.fn(async () => failed("conflict", "ticket_has_children")) }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Remover ticket" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este ticket tem filhos");
    expect(onRemoved).not.toHaveBeenCalled();
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
    for (const name of ["Editar título", "Editar descrição", "Adicionar", "Mudar", "Novo subticket", "Remover ticket"]) {
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

describe("TicketPage creation", () => {
  it("offers Novo subticket and hands the request to the host", async () => {
    const { onStartCreate } = setup({ client: clientWith(), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Novo subticket" }));
    expect(onStartCreate).toHaveBeenCalledWith({ projectId: "p1", parentId: "t1" });
  });

  it("offers Novo subticket in a leaf too, with the empty list", async () => {
    setup({ client: clientWith() });
    await loaded();
    expect(within(page()).getByRole("button", { name: "Novo subticket" })).toBeInTheDocument();
    expect(within(page()).getByText("Nenhum subticket ainda.")).toBeInTheDocument();
  });

  it("creates a subticket with a required title and optional description, then hands over the new ticket", async () => {
    const client = clientWith();
    const { onCreated, onChanged } = setup({ client, creating: { projectId: "p1", parentId: "t1" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Novo subticket" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Criar" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "Escrever o rascunho");
    await userEvent.type(screen.getByRole("textbox", { name: "Descrição" }), "Primeira versão");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Escrever o rascunho", description: "Primeira versão", parentId: "t1" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t9"));
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

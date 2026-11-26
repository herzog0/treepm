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
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")];

// t1 tem itens (t2 em andamento, t3 concluído, t6 a fazer); t4 não tem; t7 tem um item aberto (t8) e um concluído (t9).
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", status: "in_review", progress: { done: 1, total: 3, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Fase vazia", { key: "ALFA-4" }),
  makeTicket("t6", "p1", 6, "Subfase", { key: "ALFA-6", parentId: "t1" }),
  makeTicket("t7", "p1", 7, "Um item em aberto", { key: "ALFA-7", progress: { done: 1, total: 2, excluded: 0 } }),
  makeTicket("t8", "p1", 8, "Falta fazer", { key: "ALFA-8", parentId: "t7" }),
  makeTicket("t9", "p1", 9, "Já feito", { key: "ALFA-9", parentId: "t7", status: "done" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Descrição de teste", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});

function clientWith(extra: Partial<Record<keyof ApiClient, unknown>> = {}, theProject: Project = project): ApiClient {
  const client = makeClient({ projects: [theProject], people, tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    removeTicket: vi.fn(async () => ok(undefined)),
    ...extra,
  });
  return client;
}

function setup(options: { me?: Me; project?: Project; ticketId?: string | null; creating?: TicketPageProps["creating"]; client?: ApiClient } = {}) {
  const theProject = options.project ?? project;
  const handlers = {
    onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onShowOnMap: vi.fn(),
    onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn(),
  };
  render(
    <TicketPage
      client={options.client ?? clientWith({}, theProject)}
      me={options.me ?? makePanelMe("admin")}
      projects={[theProject]}
      ticketId={options.ticketId === undefined ? "t2" : options.ticketId}
      creating={options.creating ?? null}
      {...handlers}
    />,
  );
  return handlers;
}
const page = () => screen.getByRole("complementary", { name: "Página do ticket" });
const loaded = async () => screen.findByRole("heading", { level: 1 });
const reader = () => makePanelMe("member", [{ projectId: "p1", role: "reader" }]);
const contributor = () => makePanelMe("member", [{ projectId: "p1", role: "contributor" }]);

describe("ticket page header", () => {
  it("shows the project key and the ticket key on the left and four named icon buttons on the right", async () => {
    setup();
    await loaded();
    const view = within(page());
    expect(view.getByText("ALFA", { selector: ".ticket-project-key" })).toBeInTheDocument();
    expect(view.getByText("ALFA-2")).toBeInTheDocument();
    for (const name of ["Ver no mapa", "Copiar link", "Mais ações", "Fechar e voltar ao mapa"]) expect(view.getByRole("button", { name })).toBeInTheDocument();
  });

  it("'Ver no mapa' asks the host to frame the ticket on the map again", async () => {
    const { onShowOnMap, onClose } = setup();
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Ver no mapa" }));
    expect(onShowOnMap).toHaveBeenCalledWith("t2");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("'Copiar link' copies the page address with ?ticket=<id> and announces it", async () => {
    const user = userEvent.setup();
    setup();
    await loaded();
    await user.click(within(page()).getByRole("button", { name: "Copiar link" }));
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}${window.location.pathname}?ticket=t2`);
    expect(await within(page()).findByRole("status")).toHaveTextContent("Link copiado");
  });

  it("says the link could not be copied when the copy fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("negado"));
    setup();
    await loaded();
    await user.click(within(page()).getByRole("button", { name: "Copiar link" }));
    expect(await within(page()).findByRole("alert")).toHaveTextContent("Não foi possível copiar o link");
    expect(within(page()).queryByText("Link copiado")).not.toBeInTheDocument();
  });

  it("'Mais ações' holds the removal, which still takes two steps", async () => {
    const client = clientWith();
    const { onRemoved } = setup({ client });
    await loaded();
    expect(within(page()).queryByRole("button", { name: "Remover ticket" })).not.toBeInTheDocument();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    expect(client.removeTicket).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(client.removeTicket).toHaveBeenCalledWith("t2");
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
  });

  it("closes 'Mais ações' with Esc, returning the focus to its button, without closing the page", async () => {
    const { onClose } = setup();
    await loaded();
    const more = within(page()).getByRole("button", { name: "Mais ações" });
    await userEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the removal refusal outside the closed menu", async () => {
    setup({ client: clientWith({ removeTicket: vi.fn(async () => failed("conflict", "ticket_has_children")) }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Este ticket tem itens. Mova ou remova os itens antes de removê-lo.");
  });

  it("offers 'Mais ações' only to those who can remove or edit; a contributor gets it without 'Remover ticket' (ADR 0042: 'Transformar em ideia')", async () => {
    setup({ me: contributor() });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Mais ações" }));
    expect(within(page()).getByRole("button", { name: "Transformar em ideia" })).toBeInTheDocument();
    expect(within(page()).queryByRole("button", { name: "Remover ticket" })).not.toBeInTheDocument();
    expect(within(page()).getByRole("button", { name: "Ver no mapa" })).toBeInTheDocument();
  });

  it("a reader has no 'Mais ações'", async () => {
    setup({ me: reader() });
    await loaded();
    expect(within(page()).queryByRole("button", { name: "Mais ações" })).not.toBeInTheDocument();
    expect(within(page()).getByRole("button", { name: "Ver no mapa" })).toBeInTheDocument();
  });

  it("closes with the Fechar button", async () => {
    const { onClose } = setup();
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("status as a menu", () => {
  const trigger = () => within(page()).getByRole("button", { name: "Em andamento" });

  it("shows the current status in the row and opens a menu with the five statuses", async () => {
    setup();
    await loaded();
    expect(within(page()).queryByRole("group", { name: "Situação" })).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger());
    const menu = screen.getByRole("menu", { name: "Situação" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["A fazer", "Em andamento", "Em revisão", "Concluído", "Cancelado"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Em andamento" })).toBeChecked();
  });

  it("choosing a status makes one call, reloads the page and the map, and closes the menu", async () => {
    const client = clientWith();
    const { onChanged } = setup({ client });
    await loaded();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Em revisão" }));
    expect(client.updateTicket).toHaveBeenCalledWith("t2", { status: "in_review" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.getTicket).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("works from the keyboard: Enter opens on the current one, arrows move, Enter chooses, focus returns", async () => {
    const client = clientWith();
    setup({ client });
    await loaded();
    trigger().focus();
    // O foco acompanha o teclado de forma assíncrona (abertura do menu, efeito de foco): cada passo espera o foco chegar.
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Em andamento" })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Em revisão" })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "A fazer" })).toHaveFocus());
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Cancelado" })).toHaveFocus());
    await userEvent.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t2", { status: "done" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    // O foco volta ao botão depois da atualização do ticket; sob carga isso passa de 1 s.
    await waitFor(() => expect(within(page()).getByRole("button", { name: /Em andamento|Concluído/ })).toHaveFocus(), { timeout: 5000 });
    // Doze teclas e seis esperas de foco: legitimamente mais longo que os 5 s padrão quando a máquina está ocupada.
  }, 20_000);

  it("o botão fica desabilitado enquanto salva e o foco volta a ele quando termina (a ordem não depende da velocidade)", async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => {};
    const client = clientWith({ updateTicket: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    setup({ client });
    await loaded();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "Em andamento" })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t2", { status: "in_review" }));
    await waitFor(() => expect(within(page()).getByRole("button", { name: /Em andamento/ })).toBeDisabled());
    finish(ok(detailOf(summaries.find((entry) => entry.id === "t2")!)));
    await waitFor(() => expect(within(page()).getByRole("button", { name: /Em andamento|Em revisão/ })).toHaveFocus());
  });

  it("opens with Space too", async () => {
    setup();
    await loaded();
    trigger().focus();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("menu", { name: "Situação" })).toBeInTheDocument();
  });

  it("Esc closes only the menu, gives the focus back and keeps the page open", async () => {
    const { onClose } = setup();
    await loaded();
    await userEvent.click(trigger());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses to conclude with open items next to the status row, with today's texts", async () => {
    const updateTicket = vi.fn(async () => failed("conflict", "ticket_has_open_children"));
    const { onChanged } = setup({ client: clientWith({ updateTicket }), ticketId: "t1" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Conclua ou cancele os 2 itens abertos antes de concluir este ticket.");
    expect(within(page()).getByRole("button", { name: "Em revisão" }).closest("dd")).toContainElement(alert);
    expect(onChanged).not.toHaveBeenCalled();
    // A mensagem some no próximo sucesso.
    updateTicket.mockImplementationOnce(async () => ok(detailOf(summaries[0]!)) as never);
    await userEvent.click(within(page()).getByRole("button", { name: "Em revisão" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "A fazer" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("refuses with one open item: singular message", async () => {
    setup({ client: clientWith({ updateTicket: vi.fn(async () => failed("conflict", "ticket_has_open_children")) }), ticketId: "t7" });
    await loaded();
    await userEvent.click(within(page()).getByRole("button", { name: "A fazer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Conclua ou cancele o item aberto antes de concluir este ticket.");
  });

  it("shows another API error next to the row", async () => {
    setup({ client: clientWith({ updateTicket: vi.fn(async () => failed("conflict", "project_archived")) }) });
    await loaded();
    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O projeto está arquivado");
  });
});

describe("rows", () => {
  it("shows the Itens row only when the ticket has items, with a progress bar and the progress text", async () => {
    setup({ ticketId: "t1" });
    await loaded();
    const bar = within(page()).getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "3");
    expect(within(page()).getByText("1 de 3 concluídos")).toBeInTheDocument();
  });

  it("has no progress row on a ticket without items", async () => {
    setup({ ticketId: "t4" });
    await loaded();
    expect(within(page()).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(page()).queryByText("Progresso")).not.toBeInTheDocument();
  });

  it("lays out label and value as rows of one definition list", async () => {
    setup();
    await loaded();
    const labels = [...page().querySelectorAll("dl.ticket-fields dt")].map((node) => node.textContent);
    expect(labels).toEqual(["Situação", "Pessoas", "Prioridade", "Prazo", "Ticket pai", "Depende de"]);
  });
});

describe("read-only", () => {
  it.each([
    { name: "a reader", me: reader, project, notice: "Você tem acesso só de leitura a este projeto." },
    { name: "an archived project", me: () => makePanelMe("admin"), project: archivedProject, notice: "O projeto está arquivado: esta página é só de leitura." },
  ])("$name sees the values without controls and the notice", async ({ me, project: theProject, notice }) => {
    setup({ me: me(), project: theProject, ticketId: "t1" });
    await loaded();
    const view = within(page());
    expect(view.getByText(notice)).toBeInTheDocument();
    expect(view.getByText("Em revisão")).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Em revisão" })).not.toBeInTheDocument();
    expect(page().querySelector("[aria-haspopup]")).toBeNull();
    for (const name of ["Mais ações", "Adicionar", "Mudar", "Editar título", "Novo ticket aqui dentro"]) {
      expect(view.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(view.getByRole("button", { name: "Ver no mapa" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Copiar link" })).toBeInTheDocument();
  });
});

describe("manual creation in the new layout", () => {
  const creating = { projectId: "p1", parentId: null } satisfies NonNullable<TicketPageProps["creating"]>;

  it("has the header (project key and close only) and the same form as before", async () => {
    const { onClose, onCancelCreate } = setup({ ticketId: null, creating });
    const view = within(page());
    expect(view.getByText("ALFA", { selector: ".ticket-project-key" })).toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Copiar link" })).not.toBeInTheDocument();
    expect(view.queryByRole("button", { name: "Mais ações" })).not.toBeInTheDocument();
    expect(view.getByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    expect(view.getByRole("textbox", { name: "Título" })).toBeInTheDocument();
    expect(view.getByRole("textbox", { name: "Descrição" })).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onClose).toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onCancelCreate).toHaveBeenCalled();
  });

  it("creates inside a parent as before and hands over the new ticket", async () => {
    const client = clientWith({ createTicket: vi.fn(async () => ok(detailOf(makeTicket("t99", "p1", 99, "Novo")))) });
    const { onCreated } = setup({ client, ticketId: null, creating: { projectId: "p1", parentId: "t1" } });
    await userEvent.type(within(page()).getByRole("textbox", { name: "Título" }), " Novo ticket ");
    await userEvent.click(within(page()).getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Novo ticket", parentId: "t1" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("t99"));
  });
});

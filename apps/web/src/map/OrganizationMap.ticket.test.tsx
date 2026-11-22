import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

const SLOW = 8000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const archived = makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-01-01T00:00:00.000Z" });
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Fechar a fase", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Escrever o teste", { key: "ALFA-2", parentId: "t1", status: "in_review" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "todo" }),
  ],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const all = [...(tickets.p1 ?? []), makeTicket("t9", "p3", 1, "Antigo ticket", { key: "OLD-1", status: "todo" })];

function makeFullClient(extra: Partial<Record<keyof ApiClient, unknown>> = {}, withArchived = false): ApiClient {
  const client = makeClient({ projects: withArchived ? [...projects, archived] : projects, tickets, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => {
      const found = all.find((entry) => entry.id === id);
      return found ? ok(detailOf(found)) : failed("not_found");
    }),
    listTickets: vi.fn(async (projectId: string) => ok(projectId === "p3" ? all.filter((entry) => entry.projectId === "p3") : (tickets[projectId] ?? []))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(all.find((entry) => entry.id === id)!))),
    removeTicket: vi.fn(async () => ok(undefined)),
    createTicket: vi.fn(async () => ok(detailOf(makeTicket("t7", "p1", 7, "Novo", { key: "ALFA-7" })))),
    ...extra,
  });
  return client;
}

/** O Workspace é quem guarda o ticket aberto na URL; aqui um estado simples faz o mesmo papel. */
function Host({ client, me, initial = null, onChange }: { client: ApiClient; me?: Me; initial?: string | null; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(initial);
  return <OrganizationMap client={client} me={me ?? makePanelMe("admin")} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
/** O nó só aceita clique depois de a câmera terminar de revelá-lo (tabindex 0). */
async function ticketButton(name: RegExp) {
  const node = await screen.findByRole("button", { name }, { timeout: SLOW });
  await waitFor(() => expect(node).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
  return node;
}
/** Os tickets só aparecem depois de explorar o ramo do projeto, como no uso real. */
async function explored(ui: ReactElement) {
  render(ui);
  await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
  await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
}
const page = () => screen.queryByRole("complementary", { name: "Página do ticket" });

describe("opening a ticket from the map", () => {
  it("selects on the first click and opens on the second click of the same ticket", async () => {
    const onChange = vi.fn();
    await explored(<Host client={makeFullClient()} onChange={onChange} />);
    const node = await ticketButton(/ALFA-3 · Publicar/);
    await userEvent.click(node);
    expect(screen.getByRole("complementary", { name: "Nó selecionado" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(page()).not.toBeInTheDocument();
    await userEvent.click(node);
    expect(onChange).toHaveBeenCalledWith("t3");
    expect(await screen.findByRole("heading", { level: 1, name: "Publicar" })).toBeInTheDocument();
  }, SLOW);

  it("opens from the Abrir button of the selection card, next to Explorar ramo", async () => {
    const onChange = vi.fn();
    await explored(<Host client={makeFullClient()} onChange={onChange} />);
    await userEvent.click(await ticketButton(/ALFA-3 · Publicar/));
    const card = screen.getByRole("complementary", { name: "Nó selecionado" });
    expect(within(card).getByRole("button", { name: "Explorar ramo" })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Abrir" }));
    expect(onChange).toHaveBeenCalledWith("t3");
  }, SLOW);

  it("opens with Enter on the map when a ticket is selected, and not when only the stage is focused with nothing selected", async () => {
    const onChange = vi.fn();
    await explored(<Host client={makeFullClient()} onChange={onChange} />);
    await userEvent.click(await ticketButton(/ALFA-3 · Publicar/));
    const stage = screen.getByRole("region", { name: "Mapa da organização" });
    stage.focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("t3");
  }, SLOW);

  it("does not open on Enter without a selected ticket", async () => {
    const onChange = vi.fn();
    await explored(<Host client={makeFullClient()} onChange={onChange} />);
    await ticketButton(/ALFA-3 · Publicar/);
    screen.getByRole("region", { name: "Mapa da organização" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  }, SLOW);

  it("does not open on Enter typed in a text field of the selection or the page", async () => {
    const onChange = vi.fn();
    await explored(<Host client={makeFullClient()} onChange={onChange} />);
    await userEvent.click(await ticketButton(/ALFA-3 · Publicar/));
    const input = document.createElement("input");
    screen.getByRole("region", { name: "Mapa da organização" }).append(input);
    input.focus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  }, SLOW);

  it("never opens a page for a project or the organization, however many times they are clicked", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} onChange={onChange} />);
    const project = await screen.findByRole("button", { name: /BETA · Projeto Beta/ });
    await userEvent.click(project);
    await userEvent.click(project);
    const root = screen.getByRole("button", { name: /^Equipe Alfa\. Organização/ });
    await userEvent.click(root);
    await userEvent.click(root);
    expect(onChange).not.toHaveBeenCalled();
    expect(page()).not.toBeInTheDocument();
  }, SLOW);

  it("keeps Explorar ramo, selection and Esc as before when no page is open", async () => {
    await explored(<Host client={makeFullClient()} />);
    await userEvent.click(await ticketButton(/ALFA-3 · Publicar/));
    expect(screen.getByRole("complementary", { name: "Nó selecionado" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Nó selecionado" })).not.toBeInTheDocument();
  }, SLOW);
});

describe("the open page and the map", () => {
  it("opens a page from the URL, selects the ticket and narrows the map", async () => {
    render(<Host client={makeFullClient()} initial="t3" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Publicar" })).toBeInTheDocument();
    const node = await ticketButton(/ALFA-3 · Publicar/);
    expect(node).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".map-workspace")).toHaveClass("has-ticket-page");
    // A página substitui o cartão de seleção do ticket aberto.
    expect(screen.queryByRole("complementary", { name: "Nó selecionado" })).not.toBeInTheDocument();
  }, SLOW);

  it("shows the selection card of another node beside the page without changing the open ticket", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} initial="t3" onChange={onChange} />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    await userEvent.click(await ticketButton(/ALFA-2 · Escrever o teste/));
    const card = screen.getByRole("complementary", { name: "Nó selecionado" });
    expect(within(card).getByText("Escrever o teste")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Publicar" })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Abrir" }));
    expect(onChange).toHaveBeenCalledWith("t2");
    expect(await screen.findByRole("heading", { level: 1, name: "Escrever o teste" })).toBeInTheDocument();
  }, SLOW);

  it("closes with the button, restoring the full-width map and the focus on the map", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} initial="t3" onChange={onChange} />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    await userEvent.click(screen.getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(page()).not.toBeInTheDocument();
    expect(document.querySelector(".map-workspace")).not.toHaveClass("has-ticket-page");
    expect(screen.getByRole("region", { name: "Mapa da organização" })).toHaveFocus();
  }, SLOW);

  it("closes with Esc from the page and from the map", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} initial="t3" onChange={onChange} />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    await userEvent.keyboard("{Escape}");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(page()).not.toBeInTheDocument();
  }, SLOW);

  it("closes the page when the areas and projects panel is opened, and the panel when a ticket opens", async () => {
    render(<Host client={makeFullClient()} initial="t3" />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    const node = await ticketButton(/ALFA-3 · Publicar/);
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    expect(page()).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();

    await userEvent.click(node);
    await userEvent.click(node);
    expect(await screen.findByRole("heading", { level: 1, name: "Publicar" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
  }, SLOW);

  it("shows the not-found message inside the page for an unknown ticket in the URL", async () => {
    render(<Host client={makeFullClient()} initial="inexistente" />);
    const view = await screen.findByRole("complementary", { name: "Página do ticket" });
    expect(await within(view).findByRole("alert")).toHaveTextContent("Não encontramos esse item");
    expect(screen.queryByRole("complementary", { name: "Nó selecionado" })).not.toBeInTheDocument();
  }, SLOW);

  it("opens read-only, without selection, for a ticket of an archived project (it has no node)", async () => {
    render(<Host client={makeFullClient({}, true)} initial="t9" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Antigo ticket" })).toBeInTheDocument();
    const view = screen.getByRole("complementary", { name: "Página do ticket" });
    expect(within(view).getByText("O projeto está arquivado: esta página é só de leitura.")).toBeInTheDocument();
    expect(within(view).queryByRole("button", { name: "Editar título" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Nó selecionado" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".spatial-node.is-selected")).toHaveLength(0);
  }, SLOW);

  it("reloads the map and the page after a change, keeping the map mounted and the ticket open", async () => {
    const client = makeFullClient();
    render(<Host client={client} initial="t3" />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    await userEvent.click(screen.getByRole("button", { name: "A fazer" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Em revisão" }));
    await waitFor(() => expect(client.listProjects).toHaveBeenCalledTimes(2));
    expect(client.updateTicket).toHaveBeenCalledWith("t3", { status: "in_review" });
    expect(screen.queryByRole("status", { name: /Carregando mapa/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Publicar" })).toBeInTheDocument();
  }, SLOW);

  it("closes the page and clears the selection after removing the ticket", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} initial="t3" onChange={onChange} />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    await userEvent.click(screen.getByRole("button", { name: "Mais ações" }));
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Remover ticket" }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
    expect(page()).not.toBeInTheDocument();
    expect(document.querySelectorAll(".spatial-node.is-selected")).toHaveLength(0);
  }, SLOW);
});

describe("creating tickets", () => {
  it("creates a root ticket from Novo ticket in the project detail and shows the new ticket", async () => {
    const client = makeFullClient();
    vi.mocked(client.listTickets).mockImplementation(async (projectId: string) => ok(projectId === "p1" ? [...(tickets.p1 ?? []), makeTicket("t7", "p1", 7, "Novo", { key: "ALFA-7" })] : []));
    vi.mocked(client.listTickets).mockImplementationOnce(async () => ok(tickets.p1 ?? [])).mockImplementationOnce(async () => ok([]));
    vi.mocked(client.getTicket).mockImplementation(async (id: string) => ok(detailOf(id === "t7" ? makeTicket("t7", "p1", 7, "Novo", { key: "ALFA-7" }) : all.find((entry) => entry.id === id)!)));
    const onChange = vi.fn();
    render(<Host client={client} onChange={onChange} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Novo ticket" }));
    expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "Novo");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Novo" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("t7"));
    expect(await screen.findByRole("heading", { level: 1, name: "Novo" })).toBeInTheDocument();
  }, SLOW);

  it("the project detail has no 'Novo agrupador': only Novo ticket creates a node", async () => {
    render(<Host client={makeFullClient()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await screen.findByRole("button", { name: "Novo ticket" });
    expect(screen.queryByRole("button", { name: "Novo agrupador" })).not.toBeInTheDocument();
  }, SLOW);

  it("creates a ticket inside a ticket from the page and cancels back to the open ticket", async () => {
    render(<Host client={makeFullClient()} initial="t1" />);
    await screen.findByRole("heading", { level: 1, name: "Fechar a fase" });
    await userEvent.click(screen.getByRole("button", { name: "Novo ticket aqui dentro" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Fechar a fase" })).toBeInTheDocument();
  }, SLOW);

  it("creates a ticket inside a ticket that has no children yet, from the page", async () => {
    render(<Host client={makeFullClient()} initial="t3" />);
    await screen.findByRole("heading", { level: 1, name: "Publicar" });
    await userEvent.click(screen.getByRole("button", { name: "Novo ticket aqui dentro" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
  }, SLOW);

  it("closes the creation form together with the page", async () => {
    render(<Host client={makeFullClient()} initial="t1" />);
    await screen.findByRole("heading", { level: 1, name: "Fechar a fase" });
    await userEvent.click(screen.getByRole("button", { name: "Novo ticket aqui dentro" }));
    await screen.findByRole("heading", { level: 1, name: "Novo ticket" });
    await userEvent.click(screen.getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(page()).not.toBeInTheDocument();
  }, SLOW);
});

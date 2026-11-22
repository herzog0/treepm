import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrganizationMap } from "./OrganizationMap.js";
import { failed, makeClient, makeMe, makeProject, makeTicket } from "../test/fakes.js";

const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];

// A câmera anima por requestAnimationFrame; com a suíte inteira em paralelo a revelação dos nós passa de 1 s.
const SLOW = 8000;

describe("OrganizationMap", () => {
  it("shows a loading state, then the organization root and its projects", async () => {
    const client = makeClient({ projects });
    render(<OrganizationMap client={client} me={makeMe()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Carregando mapa");
    expect(await screen.findByRole("button", { name: /^Equipe Alfa\. Organização/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ALFA · Projeto Alfa/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BETA · Projeto Beta/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Mapa da organização" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Caminho do foco" })).toHaveTextContent("Equipe Alfa");
    expect(screen.getByText(/Wheel para zoom/)).toBeInTheDocument();
  });

  it("loads the people list together with the projects and fails the whole load when it fails", async () => {
    const client = makeClient({ projects });
    vi.mocked(client.listPeople).mockResolvedValueOnce(failed("unavailable"));
    render(<OrganizationMap client={client} me={makeMe()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível");
    expect(screen.queryByRole("region", { name: "Mapa da organização" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("button", { name: /ALFA/ })).toBeInTheDocument();
    expect(client.listPeople).toHaveBeenCalledTimes(2);
  });

  it("does not show archived projects", async () => {
    const client = makeClient({ projects: [...projects, makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-01-01T00:00:00.000Z" })] });
    render(<OrganizationMap client={client} me={makeMe()} />);
    await screen.findByRole("button", { name: /ALFA/ });
    expect(screen.queryByRole("button", { name: /Antigo/ })).not.toBeInTheDocument();
  });

  it.each([
    [failed("unavailable"), "API indisponível"],
    [failed("forbidden"), "Sessão sem acesso à API"],
  ])("shows an error for %j and retries", async (error, text) => {
    const client = makeClient({ projects });
    vi.mocked(client.listProjects).mockResolvedValueOnce(error);
    render(<OrganizationMap client={client} me={makeMe()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);

    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("button", { name: /ALFA/ })).toBeInTheDocument();
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  describe("organization without projects", () => {
    it("offers 'Criar primeiro projeto' to admins, opening the panel on Projetos", async () => {
      render(<OrganizationMap client={makeClient()} me={makeMe({ clerk: "admin" })} />);
      await userEvent.click(await screen.findByRole("button", { name: "Criar primeiro projeto" }));
      const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
      expect(within(panel).getByRole("tab", { name: "Projetos" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("button", { name: /^Equipe Alfa\. Organização/ })).toBeInTheDocument();
    });

    it("hides the button from members", async () => {
      render(<OrganizationMap client={makeClient()} me={makeMe({ clerk: "member" })} />);
      await screen.findByRole("button", { name: /^Equipe Alfa\. Organização/ });
      expect(screen.queryByRole("button", { name: "Criar primeiro projeto" })).not.toBeInTheDocument();
    });

    it("hides the button when there are projects", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await screen.findByRole("button", { name: /ALFA/ });
      expect(screen.queryByRole("button", { name: "Criar primeiro projeto" })).not.toBeInTheDocument();
    });

    it("treats archived projects as absent from the map and still offers the button", async () => {
      const archived = makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-01-01T00:00:00.000Z" });
      render(<OrganizationMap client={makeClient({ projects: [archived] })} me={makeMe()} />);
      expect(await screen.findByRole("button", { name: "Criar primeiro projeto" })).toBeInTheDocument();
    });
  });

  describe("side panel", () => {
    it("opens from the 'Áreas e projetos' button on Áreas and closes with Fechar", async () => {
      render(<OrganizationMap client={makeClient({ projects, areas: [{ id: "a1", name: "Design" }] })} me={makeMe()} />);
      await screen.findByRole("button", { name: /ALFA/ });
      expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
      const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
      expect(within(panel).getByRole("tab", { name: "Áreas" })).toHaveAttribute("aria-selected", "true");
      expect(await within(panel).findByText("Design")).toBeInTheDocument();

      await userEvent.click(within(panel).getByRole("button", { name: "Fechar" }));
      expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
    });

    it("opens on Projetos with the project selected when a project node is clicked", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /BETA · Projeto Beta/ }));
      const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
      expect(within(panel).getByRole("tab", { name: "Projetos" })).toHaveAttribute("aria-selected", "true");
      expect(within(panel).getByRole("heading", { name: "Projeto Beta" })).toBeInTheDocument();
      expect(within(panel).getByText("BETA")).toBeInTheDocument();
      expect(within(panel).queryByRole("heading", { name: "Projeto Alfa" })).not.toBeInTheDocument();
      expect(within(panel).getByRole("button", { name: "Voltar para a lista" })).toBeInTheDocument();
    });

    it("does not open for the organization root", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /^Equipe Alfa\. Organização/ }));
      expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
    });

    it("keeps c, C and Escape typed in the panel away from the map shortcuts", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /ALFA/ }));
      const toggle = screen.getByRole("button", { name: "Cores" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");

      const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
      // Foco em um botão (não editável) dentro do painel: o atalho do mapa continuaria valendo sem o isolamento.
      within(panel).getByRole("tab", { name: "Projetos" }).focus();
      await userEvent.keyboard("cC");
      expect(toggle).toHaveAttribute("aria-pressed", "false");

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
      // Escape do painel não limpou a seleção do mapa.
      expect(screen.getByRole("complementary", { name: "Nó selecionado" })).toBeInTheDocument();
    });

    it("still lets the map shortcut work when focus is on the map", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await screen.findByRole("button", { name: /ALFA/ });
      screen.getByRole("region", { name: "Mapa da organização" }).focus();
      await userEvent.keyboard("c");
      expect(screen.getByRole("button", { name: "Cores" })).toHaveAttribute("aria-pressed", "true");
    });
  });
  describe("tickets", () => {
    const alfaTickets = [
      makeTicket("t1", "p1", 1, "Fechar a fase", { key: "ALFA-1", progress: { done: 3, total: 8, excluded: 2 } }),
      makeTicket("t2", "p1", 2, "Escrever o teste", { key: "ALFA-2", parentId: "t1", status: "in_review" }),
      makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "cancelled" }),
    ];

    it("loads the tickets of each visible, non-archived project in parallel", async () => {
      const client = makeClient({
        projects: [...projects, makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-01-01T00:00:00.000Z" })],
        tickets: { p1: alfaTickets },
      });
      render(<OrganizationMap client={client} me={makeMe()} />);
      await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ });
      expect(client.listTickets).toHaveBeenCalledTimes(2);
      expect(client.listTickets).toHaveBeenCalledWith("p1");
      expect(client.listTickets).toHaveBeenCalledWith("p2");
      expect(client.listTickets).not.toHaveBeenCalledWith("p3");
    });

    it("keeps showing the loading state until the tickets arrive", async () => {
      const client = makeClient({ projects });
      let release: (value: Awaited<ReturnType<typeof client.listTickets>>) => void = () => undefined;
      vi.mocked(client.listTickets).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      render(<OrganizationMap client={client} me={makeMe()} />);
      await waitFor(() => expect(client.listTickets).toHaveBeenCalled());
      expect(screen.getByRole("status")).toHaveTextContent("Carregando mapa");
      expect(screen.queryByRole("button", { name: /ALFA/ })).not.toBeInTheDocument();
      release({ ok: true, data: [] });
    });

    it("shows the error state when a ticket load fails, and retries everything", async () => {
      const client = makeClient({ projects, tickets: { p1: alfaTickets } });
      vi.mocked(client.listTickets).mockResolvedValueOnce(failed("unavailable"));
      render(<OrganizationMap client={client} me={makeMe()} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível");

      await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
      expect(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ })).toBeInTheDocument();
      expect(client.listProjects).toHaveBeenCalledTimes(2);
    });

    async function openAlfa(client = makeClient({ projects, tickets: { p1: alfaTickets } })) {
      render(<OrganizationMap client={client} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
      await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
      return client;
    }

    it("renders ticket nodes with key and title once the project branch is explored", async () => {
      await openAlfa();
      expect(await screen.findByRole("button", { name: /ALFA-3 · Publicar/ }, { timeout: SLOW })).toBeInTheDocument();
    });

    it("selecting a project counts its root children as 'itens'", async () => {
      render(<OrganizationMap client={makeClient({ projects, tickets: { p1: [makeTicket("g1", "p1", 1, "Fase", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }), makeTicket("t2", "p1", 2, "Solto", { key: "ALFA-2" })] } })} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
      const card = screen.getByRole("complementary", { name: "Nó selecionado" });
      expect(within(card).getByText("2 itens")).toBeInTheDocument();
      expect(within(card).queryByText(/tickets/)).not.toBeInTheDocument();
    });

    it("selecting a project with a single root child says '1 item'", async () => {
      render(<OrganizationMap client={makeClient({ projects, tickets: { p1: [makeTicket("t2", "p1", 2, "Solto", { key: "ALFA-2" })] } })} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
      expect(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByText("1 item")).toBeInTheDocument();
    });

    it("still opens the project detail in the panel when a project node is clicked", async () => {
      const client = makeClient({ projects, tickets: { p1: alfaTickets } });
      render(<OrganizationMap client={client} me={makeMe()} />);
      await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
      const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
      expect(within(panel).getByRole("heading", { name: "Projeto Alfa" })).toBeInTheDocument();
    });
  });

  describe("theme and import entry", () => {
    it("starts with the dark card (Cores off), as ADR 0025 describes", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await screen.findByRole("button", { name: /ALFA/ });
      expect(screen.getByRole("button", { name: "Cores" })).toHaveAttribute("aria-pressed", "false");
      expect(document.querySelector(".spatial-shell")).not.toHaveClass("is-color-mode");
    });

    it("scopes the map theme to the organization map root", async () => {
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
      await screen.findByRole("button", { name: /ALFA/ });
      expect(document.querySelector(".spatial-shell")).toHaveClass("org-map");
    });

    it("hands the project to onImport from 'Importar lista' in the side panel", async () => {
      const onImport = vi.fn();
      render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} onImport={onImport} />);
      await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Importar lista" }));
      expect(onImport).toHaveBeenCalledWith("p1");
    });
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrganizationMap } from "./OrganizationMap.js";
import { failed, makeClient, makeMe, makeProject } from "../test/fakes.js";

const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];

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
      expect(toggle).toHaveAttribute("aria-pressed", "true");

      const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
      // Foco em um botão (não editável) dentro do painel: o atalho do mapa continuaria valendo sem o isolamento.
      within(panel).getByRole("tab", { name: "Projetos" }).focus();
      await userEvent.keyboard("cC");
      expect(toggle).toHaveAttribute("aria-pressed", "true");

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
      expect(screen.getByRole("button", { name: "Cores" })).toHaveAttribute("aria-pressed", "false");
    });
  });
});

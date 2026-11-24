import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace.js";

function orgFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const token = new Headers(init?.headers).get("Authorization");
    const orgId = token?.replace("Bearer ", "") ?? "";
    const name = orgId === "org-1" ? "Org Alfa" : "Org Beta";
    if (input === "/api/me") {
      return Response.json({
        person: { id: "p", displayName: "Ana", email: "a@x.com", avatarUrl: null },
        organization: { orgId, name, slug: name },
        roles: { clerk: "admin", teams: [], projects: [] },
      });
    }
    if (input === "/api/projects") {
      return Response.json([{ id: `${orgId}-proj`, name: `Projeto de ${name}`, key: "PRJ", visibility: "organization", archivedAt: null, members: [], teamIds: [] }]);
    }
    if (typeof input === "string" && /^\/api\/projects\/[^/]+\/tickets$/.test(input)) {
      const projectId = `${orgId}-proj`;
      return Response.json(input.includes(projectId) ? [{ id: "t1", projectId, number: 1, key: "PRJ-1", parentId: null, title: "Primeiro", status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "" }] : []);
    }
    if (input === "/api/tickets/t1") {
      return Response.json({ id: "t1", projectId: `${orgId}-proj`, number: 1, key: "PRJ-1", parentId: null, title: "Primeiro", status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "", description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "p", createdAt: "x", updatedAt: "y" });
    }
    if (input === "/api/people") return Response.json([]);
    return new Response(null, { status: 404 });
  });
}

describe("Workspace", () => {
  it("shows the map by default and the teams shell for the teams view", async () => {
    const fetchImpl = orgFetch();
    const getToken = async () => "org-1";
    const { rerender } = render(<Workspace orgId="org-1" view="map" getToken={getToken} fetch={fetchImpl} />);
    expect(await screen.findByRole("button", { name: /Projeto de Org Alfa/ })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();

    rerender(<Workspace orgId="org-1" view="teams" getToken={getToken} fetch={fetchImpl} />);
    expect(await screen.findByRole("heading", { name: "Times", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Projeto de/ })).not.toBeInTheDocument();
  });

  it("shows the settings page for the settings view, without waiting for the API", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    render(<Workspace orgId="org-1" view="settings" getToken={async () => "t"} fetch={fetchImpl} />);
    expect(screen.getByRole("heading", { name: "Configurações", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Idioma da interface" })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("shows the GitHub section in the settings once /api/me says GitHub is enabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === "/api/me") {
        return Response.json({
          person: { id: "p", displayName: "Ana", email: "a@x.com", avatarUrl: null },
          organization: { orgId: "org-1", name: "Org Alfa", slug: "alfa" },
          roles: { clerk: "admin", teams: [], projects: [] },
          github: { enabled: true },
        });
      }
      if (input === "/api/github/installation") return Response.json({ installation: null });
      return new Response(null, { status: 404 });
    });
    window.location.hash = "github";
    render(<Workspace orgId="org-1" view="settings" getToken={async () => "t"} fetch={fetchImpl} />);
    expect(await screen.findByRole("heading", { name: "GitHub", level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Conectar GitHub" })).toBeInTheDocument();
    window.location.hash = "";
  });

  it("never calls a GitHub route when /api/me has no github field or says it is disabled", async () => {
    for (const github of [undefined, { enabled: false }]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
        input === "/api/me"
          ? Response.json({
              person: { id: "p", displayName: "Ana", email: "a@x.com", avatarUrl: null },
              organization: { orgId: "org-1", name: "Org Alfa", slug: "alfa" },
              roles: { clerk: "admin", teams: [], projects: [] },
              ...(github ? { github } : {}),
            })
          : new Response(null, { status: 404 }),
      );
      const { unmount } = render(<Workspace orgId="org-1" view="settings" getToken={async () => "t"} fetch={fetchImpl} />);
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith("/api/me", expect.anything()));
      expect(await screen.findByRole("heading", { name: "Idioma" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "GitHub" })).not.toBeInTheDocument();
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("github"))).toEqual([]);
      unmount();
    }
  });

  it("shows an error with retry when /api/me fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    render(<Workspace orgId="org-1" view="map" getToken={async () => "t"} fetch={fetchImpl} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível");
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
  });

  it.each(["map", "teams"] as const)("discards the previous organization's data and refetches when orgId changes (%s)", async (view) => {
    const fetchImpl = orgFetch();
    let token = "org-1";
    const getToken = async () => token;
    const { rerender } = render(<Workspace orgId="org-1" view={view} getToken={getToken} fetch={fetchImpl} />);
    if (view === "map") await screen.findByRole("button", { name: /Projeto de Org Alfa/ });
    else await screen.findByRole("heading", { name: "Times" });
    const callsBefore = fetchImpl.mock.calls.filter(([url]) => url === "/api/me").length;

    token = "org-2";
    rerender(<Workspace orgId="org-2" view={view} getToken={getToken} fetch={fetchImpl} />);
    // Os dados da organização anterior somem na hora, antes da nova resposta.
    expect(screen.queryByRole("button", { name: /Org Alfa/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    if (view === "map") expect(await screen.findByRole("button", { name: /Projeto de Org Beta/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchImpl.mock.calls.filter(([url]) => url === "/api/me").length).toBe(callsBefore + 1));
    if (view === "map") expect(fetchImpl.mock.calls.filter(([url]) => url === "/api/projects").length).toBe(2);
    expect(screen.queryByText(/Org Alfa/)).not.toBeInTheDocument();
  });

  it("closes the side panel and drops its data when the organization changes", async () => {
    const fetchImpl = orgFetch();
    let token = "org-1";
    const getToken = async () => token;
    const { rerender } = render(<Workspace orgId="org-1" view="map" getToken={getToken} fetch={fetchImpl} />);
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(await screen.findByRole("button", { name: /Projeto de Org Alfa/ }));
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();

    token = "org-2";
    rerender(<Workspace orgId="org-2" view="map" getToken={getToken} fetch={fetchImpl} />);
    await screen.findByRole("button", { name: /Projeto de Org Beta/ });
    expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
  });

  it("shows the import screen for the import view and leaves for the map through onNavigate", async () => {
    const fetchImpl = orgFetch();
    const onNavigate = vi.fn();
    render(<Workspace orgId="org-1" view="import" projectId="org-1-proj" onNavigate={onNavigate} getToken={async () => "org-1"} fetch={fetchImpl} />);
    expect(await screen.findByRole("heading", { name: "Importar lista", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Lista" })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Projeto de/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onNavigate).toHaveBeenCalledWith("map");
  });

  it("opens the ticket page from the ticket route and reports opening and closing to the host", async () => {
    const fetchImpl = orgFetch();
    const onOpenTicket = vi.fn();
    render(<Workspace orgId="org-1" view="map" ticketId="t1" onOpenTicket={onOpenTicket} getToken={async () => "org-1"} fetch={fetchImpl} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Primeiro" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onOpenTicket).toHaveBeenCalledWith(null);
  });
});

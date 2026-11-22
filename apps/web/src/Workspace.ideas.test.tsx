import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "./Workspace.js";

function fakeFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (input === "/api/me") {
      return Response.json({
        person: { id: "p", displayName: "Ana", email: "a@x.com", avatarUrl: null },
        organization: { orgId: "org-1", name: "Org Alfa", slug: "alfa" },
        roles: { clerk: "admin", teams: [], projects: [] },
      });
    }
    if (input === "/api/projects") return Response.json([{ id: "proj", name: "Projeto Alfa", key: "PRJ", visibility: "organization", archivedAt: null, members: [], teamIds: [] }]);
    if (input === "/api/projects/proj/ideas") {
      return Response.json([{ id: "i1", number: 1, key: "PRJ-1", title: "Exportar CSV", stage: "new", path: ["Acesso"], createdAt: new Date().toISOString() }]);
    }
    return new Response(null, { status: 404 });
  });
}
const getToken = async () => "org-1";

describe("Workspace: the Ideias screen", () => {
  it("shows the ideas of the project for the ideas view", async () => {
    render(<Workspace orgId="org-1" view="ideas" getToken={getToken} fetch={fakeFetch()} />);
    expect(await screen.findByRole("heading", { name: "Ideias", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("PRJ-1")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Peça qualquer coisa" })).not.toBeInTheDocument();
  });

  it("“Abrir” goes to the map with the idea open, and “Ver no mapa” with the camera on it", async () => {
    const onNavigate = vi.fn();
    render(<Workspace orgId="org-1" view="ideas" onNavigate={onNavigate} getToken={getToken} fetch={fakeFetch()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Abrir PRJ-1" }));
    expect(onNavigate).toHaveBeenLastCalledWith("map", null, { ticketId: "i1" });
    await userEvent.click(screen.getByRole("button", { name: "Ver no mapa PRJ-1" }));
    expect(onNavigate).toHaveBeenLastCalledWith("map", null, { focusId: "i1" });
  });
});

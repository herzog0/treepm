import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeClient, makeMe, makeProject, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// A seção real ainda é somente leitura; este stub só exercita a costura `onChanged`.
vi.mock("../panel/ProjectsSection.js", () => ({
  ProjectsSection: ({ onChanged }: { onChanged: () => void }) => <button onClick={onChanged}>Simular alteração</button>,
}));

describe("OrganizationMap reload", () => {
  it("reloads the projects (keeping the map on screen) when a section reports a change", async () => {
    const first = [makeProject("p1", "ALFA", "Projeto Alfa")];
    const client = makeClient({ projects: first });
    render(<OrganizationMap client={client} me={makeMe()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA/ }));

    vi.mocked(client.listProjects).mockResolvedValue(ok([...first, makeProject("p2", "GAMA", "Projeto Gama")]));
    await userEvent.click(screen.getByRole("button", { name: "Simular alteração" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /GAMA · Projeto Gama/ })).toBeInTheDocument());
    expect(client.listProjects).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

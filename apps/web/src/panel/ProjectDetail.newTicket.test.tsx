import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Me, Project } from "../api/client.js";
import { makeProject } from "../test/fakes.js";
import { ProjectsSection } from "./ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

const alpha = makeProject("p1", "ALFA", "Alfa");

function setup(me: Me, project: Project = alpha, onCreateTicket: ((projectId: string) => void) | null = vi.fn(), onImportProject = vi.fn()) {
  const client = makePanelClient({ projects: [project], people: [makePerson("person-1", "Ana")] });
  render(<ProjectsSection client={client} me={me} projects={[project]} selectedProject={project} onChanged={vi.fn()} onImportProject={onImportProject} {...(onCreateTicket ? { onCreateTicket } : {})} />);
  return { onCreateTicket };
}
const action = () => screen.queryByRole("button", { name: "Novo ticket" });
const groupAction = () => screen.queryByRole("button", { name: "Novo agrupador" });

describe("Novo ticket in the project detail", () => {
  it.each([
    ["organization admin", makePanelMe("admin")],
    ["project manager", makePanelMe("member", [{ projectId: "p1", role: "manager" }])],
    ["project contributor", makePanelMe("member", [{ projectId: "p1", role: "contributor" }])],
  ])("is offered to %s next to Importar lista and creates a ticket at the project root", async (_name, me) => {
    const { onCreateTicket } = setup(me);
    expect(await screen.findByRole("button", { name: "Importar lista" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Novo ticket" }));
    expect(onCreateTicket).toHaveBeenCalledWith("p1");
    expect(onCreateTicket).toHaveBeenCalledTimes(1);
    expect(groupAction()).not.toBeInTheDocument();
  });

  it.each([
    ["project reader", makePanelMe("member", [{ projectId: "p1", role: "reader" }])],
    ["member without role", makePanelMe("member")],
  ])("is hidden from a %s", async (_name, me) => {
    setup(me);
    await screen.findByRole("heading", { name: "Alfa" });
    expect(action()).not.toBeInTheDocument();
    expect(groupAction()).not.toBeInTheDocument();
  });

  it("is hidden for an archived project", async () => {
    setup(makePanelMe("admin"), makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }));
    await screen.findByRole("heading", { name: "Alfa" });
    expect(action()).not.toBeInTheDocument();
    expect(groupAction()).not.toBeInTheDocument();
  });

  it("is hidden when the host gives no way to create", async () => {
    setup(makePanelMe("admin"), alpha, null);
    await screen.findByRole("heading", { name: "Alfa" });
    expect(action()).not.toBeInTheDocument();
    expect(groupAction()).not.toBeInTheDocument();
  });
});

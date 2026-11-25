import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Me, Project, ProjectLinear } from "../api/client.js";
import { makeLinearConnection, makeProject } from "../test/fakes.js";
import type { FakeLinear } from "../test/fakes.js";
import { ProjectsSection } from "./ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

const alpha = makeProject("p1", "ALFA", "Alfa");

function setup(me: Me, project: Project = alpha, onImportProject: ((id: string, mode?: "sync") => void) | null = vi.fn(), linear?: FakeLinear) {
  const client = makePanelClient({ projects: [project], people: [makePerson("person-1", "Ana")], ...(linear ? { linear } : {}) });
  render(<ProjectsSection client={client} me={me} projects={[project]} selectedProject={project} onChanged={vi.fn()} {...(onImportProject ? { onImportProject } : {})} />);
  return { onImportProject };
}
const action = () => screen.queryByRole("button", { name: "Importar lista" });

describe("Importar lista in the project detail", () => {
  it.each([
    ["organization admin", makePanelMe("admin")],
    ["project manager", makePanelMe("member", [{ projectId: "p1", role: "manager" }])],
    ["project contributor", makePanelMe("member", [{ projectId: "p1", role: "contributor" }])],
  ])("is offered to %s and opens the import screen for the project", async (_name, me) => {
    const { onImportProject } = setup(me);
    await userEvent.click(await screen.findByRole("button", { name: "Importar lista" }));
    expect(onImportProject).toHaveBeenCalledWith("p1");
  });

  it.each([
    ["project reader", makePanelMe("member", [{ projectId: "p1", role: "reader" }])],
    ["member without role", makePanelMe("member")],
    ["contributor of another project", makePanelMe("member", [{ projectId: "other", role: "contributor" }])],
  ])("is hidden from a %s", async (_name, me) => {
    setup(me);
    await screen.findByRole("heading", { name: "Alfa" });
    expect(action()).not.toBeInTheDocument();
  });

  it("is hidden for an archived project", async () => {
    setup(makePanelMe("admin"), makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }));
    await screen.findByRole("heading", { name: "Alfa" });
    expect(action()).not.toBeInTheDocument();
  });

  it("is hidden when the host gives no way to open the screen", async () => {
    setup(makePanelMe("admin"), alpha, null);
    await screen.findByRole("heading", { name: "Alfa" });
    expect(action()).not.toBeInTheDocument();
  });
});

describe("Sincronizar com o Linear in the project detail (ADR 0061)", () => {
  const LINKED: ProjectLinear = {
    source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } },
    canLink: false,
    keyMatches: true,
  };
  const linked = (): FakeLinear => ({ connection: makeLinearConnection(), projects: { p1: LINKED } });
  const sync = () => screen.queryByRole("button", { name: "Sincronizar com o Linear" });

  it.each([
    ["organization admin", makePanelMe("admin")],
    ["project manager", makePanelMe("member", [{ projectId: "p1", role: "manager" }])],
    ["project contributor", makePanelMe("member", [{ projectId: "p1", role: "contributor" }])],
  ])("is offered to %s of a project linked to a Linear team, next to Importar lista, and opens the import already syncing", async (_name, me) => {
    const { onImportProject } = setup(me, alpha, vi.fn(), linked());
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar com o Linear" }));
    expect(onImportProject).toHaveBeenCalledWith("p1", "sync");
    expect(screen.getByRole("button", { name: "Importar lista" })).toBeInTheDocument();
  });

  it("is hidden for a project that is not linked to a Linear team", async () => {
    setup(makePanelMe("admin"), alpha, vi.fn(), { connection: makeLinearConnection(), projects: {} });
    await screen.findByRole("button", { name: "Importar lista" });
    await waitFor(() => expect(sync()).not.toBeInTheDocument());
  });

  it("is hidden when the server has no Linear configured, or the client cannot ask", async () => {
    setup(makePanelMe("admin"), alpha, vi.fn(), { configured: false });
    await screen.findByRole("button", { name: "Importar lista" });
    expect(sync()).not.toBeInTheDocument();
  });

  it.each([
    ["project reader", makePanelMe("member", [{ projectId: "p1", role: "reader" }])],
    ["member without role", makePanelMe("member")],
  ])("is hidden from a %s", async (_name, me) => {
    setup(me, alpha, vi.fn(), linked());
    await screen.findByRole("heading", { name: "Alfa" });
    expect(sync()).not.toBeInTheDocument();
  });

  it("is hidden for an archived project", async () => {
    setup(makePanelMe("admin"), makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }), vi.fn(), linked());
    await screen.findByRole("heading", { name: "Alfa" });
    expect(sync()).not.toBeInTheDocument();
  });

  it("is hidden when the host gives no way to open the screen", async () => {
    setup(makePanelMe("admin"), alpha, null, linked());
    await screen.findByRole("heading", { name: "Alfa" });
    expect(sync()).not.toBeInTheDocument();
  });
});

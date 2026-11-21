import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult, Me, Project } from "../api/client.js";
import { makeGithubRepository, makeInstallation, makeProject } from "../test/fakes.js";
import type { FakeGithub } from "../test/fakes.js";
import { ProjectsSection } from "./ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

const alpha = makeProject("p1", "ALFA", "Alfa");
const treepm = makeGithubRepository(1, "herzog0/treepm");
const privateRepo = makeGithubRepository(2, "herzog0/segredo", { private: true });
const docs = makeGithubRepository(3, "herzog0/docs");
const linked = (repo: typeof treepm, id = `link-${repo.repoId}`) => ({ ...repo, id, linkedAt: "2026-11-20T12:00:00.000Z" });

const withGithub = (me: Me): Me => ({ ...me, github: { enabled: true } });
const admin = withGithub(makePanelMe("admin"));
const manager = withGithub(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));

function setup(me: Me, options: { project?: Project; github?: FakeGithub } = {}) {
  const project = options.project ?? alpha;
  const github: FakeGithub = { installation: makeInstallation(), repositories: [treepm, privateRepo, docs], ...options.github };
  const client = makePanelClient({ projects: [project], people: [makePerson("person-1", "Ana")], me, github });
  render(<ProjectsSection client={client} me={me} projects={[project]} selectedProject={project} onChanged={vi.fn()} />);
  return { client };
}
const heading = () => screen.queryByRole("heading", { name: "Repositórios" });
const repositories = async () => {
  await screen.findByRole("heading", { name: "Repositórios" });
  await waitFor(() => expect(screen.queryByText("Carregando repositórios…")).not.toBeInTheDocument());
  return screen.getByRole("heading", { name: "Repositórios" }).parentElement!;
};

describe("Detalhe do projeto › Repositórios", () => {
  it("does not appear and calls nothing when GitHub is disabled", async () => {
    const { client } = setup(makePanelMe("admin"), { github: { enabled: false } });
    await screen.findByRole("heading", { name: "Alfa" });
    await screen.findByRole("heading", { name: "Pessoas com acesso" });
    expect(heading()).not.toBeInTheDocument();
    expect(client.getGithubInstallation).not.toHaveBeenCalled();
    expect(client.listProjectRepositories).not.toHaveBeenCalled();
  });

  it("does not appear while the organization is not linked", async () => {
    const { client } = setup(admin, { github: { installation: null } });
    await screen.findByRole("heading", { name: "Pessoas com acesso" });
    await vi.waitFor(() => expect(client.getGithubInstallation).toHaveBeenCalled());
    expect(heading()).not.toBeInTheDocument();
    expect(client.listProjectRepositories).not.toHaveBeenCalled();
  });

  it("lists the linked repositories as links to GitHub, marking the private ones", async () => {
    setup(admin, { github: { linked: { p1: [linked(treepm), linked(privateRepo)] } } });
    const section = within(await repositories());
    const link = section.getByRole("link", { name: "herzog0/treepm" });
    expect(link).toHaveAttribute("href", "https://github.com/herzog0/treepm");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const items = section.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).queryByText("privado")).not.toBeInTheDocument();
    expect(within(items[1]!).getByText("privado")).toBeInTheDocument();
  });

  it("says when no repository is linked", async () => {
    setup(admin);
    expect(await within(await repositories()).findByText("Nenhum repositório ligado a este projeto.")).toBeInTheDocument();
  });

  it.each([["administrator", admin], ["project manager", manager]])("lets a %s link and remove", async (_name, me) => {
    setup(me, { github: { linked: { p1: [linked(treepm)] } } });
    const section = within(await repositories());
    expect(await section.findByRole("button", { name: "Ligar repositório" })).toBeInTheDocument();
    expect(section.getByRole("button", { name: /Remover/ })).toBeInTheDocument();
  });

  it.each([
    ["project contributor", withGithub(makePanelMe("member", [{ projectId: "p1", role: "contributor" }]))],
    ["project reader", withGithub(makePanelMe("member", [{ projectId: "p1", role: "reader" }]))],
    ["manager of another project", withGithub(makePanelMe("member", [{ projectId: "p2", role: "manager" }]))],
  ])("only lets a %s see the list", async (_name, me) => {
    setup(me, { github: { linked: { p1: [linked(treepm)] } } });
    const section = within(await repositories());
    expect(await section.findByRole("link", { name: "herzog0/treepm" })).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Ligar repositório" })).not.toBeInTheDocument();
    expect(section.queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
  });

  it("offers no controls on an archived project", async () => {
    setup(admin, { project: makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }), github: { linked: { p1: [linked(treepm)] } } });
    const section = within(await repositories());
    expect(await section.findByRole("link", { name: "herzog0/treepm" })).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Ligar repositório" })).not.toBeInTheDocument();
    expect(section.queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
  });

  it("fetches the available repositories only when the choice opens, listing the ones not yet linked", async () => {
    const { client } = setup(admin, { github: { linked: { p1: [linked(treepm)] } } });
    const section = within(await repositories());
    expect(client.listGithubRepositories).not.toHaveBeenCalled();
    await userEvent.click(await section.findByRole("button", { name: "Ligar repositório" }));
    expect(client.listGithubRepositories).toHaveBeenCalledTimes(1);
    const choice = await section.findByRole("group", { name: "Repositórios disponíveis" });
    expect(within(choice).getByRole("button", { name: /herzog0\/segredo/ })).toBeInTheDocument();
    expect(within(choice).getByRole("button", { name: /herzog0\/docs/ })).toBeInTheDocument();
    expect(within(choice).queryByRole("button", { name: /herzog0\/treepm/ })).not.toBeInTheDocument();
  });

  it("filters the choice by name", async () => {
    setup(admin);
    const section = within(await repositories());
    await userEvent.click(await section.findByRole("button", { name: "Ligar repositório" }));
    await userEvent.type(await section.findByRole("textbox", { name: "Filtrar repositórios" }), "DOC");
    const choice = section.getByRole("group", { name: "Repositórios disponíveis" });
    expect(within(choice).getAllByRole("button")).toHaveLength(1);
    expect(within(choice).getByRole("button", { name: /herzog0\/docs/ })).toBeInTheDocument();
    await userEvent.clear(section.getByRole("textbox", { name: "Filtrar repositórios" }));
    await userEvent.type(section.getByRole("textbox", { name: "Filtrar repositórios" }), "nada");
    expect(section.getByText("Nenhum repositório encontrado.")).toBeInTheDocument();
  });

  it("links the chosen repository and shows it in the list", async () => {
    const { client } = setup(manager);
    const section = within(await repositories());
    await userEvent.click(await section.findByRole("button", { name: "Ligar repositório" }));
    await userEvent.click(await section.findByRole("button", { name: /herzog0\/docs/ }));
    expect(client.linkProjectRepository).toHaveBeenCalledWith("p1", { repoId: 3 });
    expect(await section.findByRole("link", { name: "herzog0/docs" })).toBeInTheDocument();
    expect(section.queryByRole("group", { name: "Repositórios disponíveis" })).not.toBeInTheDocument();
    expect(section.queryByText("Nenhum repositório ligado a este projeto.")).not.toBeInTheDocument();
  });

  it("removes a repository only after the confirmation that explains the effect", async () => {
    const { client } = setup(admin, { github: { linked: { p1: [linked(treepm, "link-a")] } } });
    const section = within(await repositories());
    await userEvent.click(await section.findByRole("button", { name: "Remover herzog0/treepm" }));
    expect(client.unlinkProjectRepository).not.toHaveBeenCalled();
    expect(section.getByText("Os vínculos de código dos tickets com este repositório serão removidos.")).toBeInTheDocument();
    await userEvent.click(section.getByRole("button", { name: "Confirmar: Remover herzog0/treepm" }));
    expect(client.unlinkProjectRepository).toHaveBeenCalledWith("p1", "link-a");
    expect(await section.findByText("Nenhum repositório ligado a este projeto.")).toBeInTheDocument();
  });

  const linkFailures: [string, ApiResult<never>, string][] = [
    ["repository_already_linked", { ok: false, error: { kind: "conflict", code: "repository_already_linked" } }, "Este repositório já está ligado."],
    ["repository_not_found", { ok: false, error: { kind: "not_found", code: "repository_not_found" } }, "O app não tem acesso a este repositório."],
    ["not_connected", { ok: false, error: { kind: "conflict", code: "not_connected" } }, "A organização não está ligada ao GitHub."],
    ["installation_unavailable", { ok: false, error: { kind: "conflict", code: "installation_unavailable" } }, "A instalação do app no GitHub não está disponível."],
    ["github_unavailable", { ok: false, error: { kind: "unavailable", code: "github_unavailable" } }, "O GitHub não respondeu. Tente de novo em instantes."],
    ["project_archived", { ok: false, error: { kind: "conflict", code: "project_archived" } }, "O projeto está arquivado e só aceita leitura."],
  ];
  it.each(linkFailures)("explains %s next to the choice", async (_code, result, message) => {
    const { client } = setup(admin);
    vi.mocked(client.linkProjectRepository).mockResolvedValueOnce(result);
    const section = within(await repositories());
    await userEvent.click(await section.findByRole("button", { name: "Ligar repositório" }));
    await userEvent.click(await section.findByRole("button", { name: /herzog0\/docs/ }));
    expect(await section.findByRole("alert")).toHaveTextContent(message);
    expect(section.queryByRole("link", { name: "herzog0/docs" })).not.toBeInTheDocument();
  });

  it("explains a failure to list the available repositories inside the choice", async () => {
    const { client } = setup(admin);
    vi.mocked(client.listGithubRepositories).mockResolvedValueOnce({ ok: false, error: { kind: "conflict", code: "installation_unavailable" } });
    const section = within(await repositories());
    await userEvent.click(await section.findByRole("button", { name: "Ligar repositório" }));
    expect(await section.findByRole("alert")).toHaveTextContent("A instalação do app no GitHub não está disponível.");
  });

  it("explains a failed removal next to the repository", async () => {
    const { client } = setup(admin, { github: { linked: { p1: [linked(treepm, "link-a")] } } });
    vi.mocked(client.unlinkProjectRepository).mockResolvedValueOnce({ ok: false, error: { kind: "conflict", code: "project_archived" } });
    const section = within(await repositories());
    await userEvent.click(await section.findByRole("button", { name: "Remover herzog0/treepm" }));
    await userEvent.click(section.getByRole("button", { name: "Confirmar: Remover herzog0/treepm" }));
    expect(await section.findByRole("alert")).toHaveTextContent("O projeto está arquivado e só aceita leitura.");
    expect(section.getByRole("link", { name: "herzog0/treepm" })).toBeInTheDocument();
  });
});

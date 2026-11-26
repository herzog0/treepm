import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, ApiResult, CodeRefresh, Me, Project, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeCodeLink, makeGithubRepository, makeInstallation, makeProject, makeTicket, ok } from "../test/fakes.js";
import type { FakeGithub } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const archivedProject = makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", progress: { done: 0, total: 2, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Descrição", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const t2 = { id: "t2", key: "ALFA-2", title: "Escrever o texto" };
const t3 = { id: "t3", key: "ALFA-3", title: "Revisar o texto" };
const treepm = { fullName: "herzog0/treepm", htmlUrl: "https://github.com/herzog0/treepm" };
const open = makeCodeLink("l1", t2, { repository: treepm, number: 12, title: "Corrige o login", state: "open" });
const merged = makeCodeLink("l2", t2, { repository: treepm, number: 9, title: "Primeira versão", state: "merged", url: "https://github.com/herzog0/treepm/pull/9" });
const branch = makeCodeLink("l3", t2, { repository: treepm, kind: "branch", ref: "feat/alfa-2-login", number: null, title: null, state: "active", url: "https://github.com/herzog0/treepm/tree/feat/alfa-2-login" });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const githubMe = (me: Me = makePanelMe("admin")): Me => ({ ...me, github: { enabled: true } });

function setup(options: { me?: Me; project?: Project; ticketId?: string; github?: FakeGithub; strict?: boolean } = {}) {
  const me = options.me ?? githubMe();
  const theProject = options.project ?? project;
  const github: FakeGithub = {
    installation: makeInstallation(),
    repositories: [makeGithubRepository(1, "herzog0/treepm")],
    linked: { p1: [{ ...makeGithubRepository(1, "herzog0/treepm"), id: "link-1", linkedAt: "2026-11-20T12:00:00.000Z" }] },
    ...options.github,
  };
  const client = makeClient({ me, projects: [theProject], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries }, github });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const page = (
    <TicketPage client={client} me={me} projects={[theProject]} ticketId={options.ticketId ?? "t2"} creating={null} {...handlers} />
  );
  render(options.strict ? <StrictMode>{page}</StrictMode> : page);
  return { client: client as ApiClient };
}
const section = async () => within(await screen.findByRole("region", { name: "Código" }));
const noSection = async () => {
  await screen.findByRole("heading", { level: 1 });
  await screen.findByText("Ticket pai");
};

describe("Página do ticket › Código", () => {
  it("does not appear and calls nothing when GitHub is disabled", async () => {
    const { client } = setup({ me: makePanelMe("admin"), github: { enabled: false, code: { t2: { links: [open] } } } });
    await noSection();
    expect(screen.queryByRole("region", { name: "Código" })).not.toBeInTheDocument();
    expect(client.getTicketCode).not.toHaveBeenCalled();
    expect(client.refreshProjectCode).not.toHaveBeenCalled();
  });

  it("is hidden when the project has no linked repository, and does not try to refresh", async () => {
    const { client } = setup({ github: { linked: {}, code: { t2: { links: [] } } } });
    await waitFor(() => expect(client.getTicketCode).toHaveBeenCalledWith("t2"));
    await noSection();
    expect(screen.queryByRole("region", { name: "Código" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Código" })).not.toBeInTheDocument();
    expect(client.refreshProjectCode).not.toHaveBeenCalled();
  });

  it("lists a pull request, a merged one and a branch with their state, repository and links", async () => {
    setup({ github: { code: { t2: { links: [open, merged, branch], syncedAt: minutesAgo(1) } } } });
    const code = await section();
    const items = await code.findAllByRole("listitem");
    expect(items).toHaveLength(3);

    const pr = within(items[0]!);
    const prLink = pr.getByRole("link", { name: "#12 Corrige o login" });
    expect(prLink).toHaveAttribute("href", "https://github.com/herzog0/treepm/pull/12");
    expect(prLink).toHaveAttribute("target", "_blank");
    expect(prLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(pr.getByText("aberto")).toBeInTheDocument();
    expect(pr.getByText("herzog0/treepm")).toBeInTheDocument();
    expect(items[0]!.querySelector(".status-mark")).not.toBeNull();

    expect(within(items[1]!).getByRole("link", { name: "#9 Primeira versão" })).toBeInTheDocument();
    expect(within(items[1]!).getByText("mesclado")).toBeInTheDocument();

    const branchItem = within(items[2]!);
    expect(branchItem.getByRole("link", { name: "feat/alfa-2-login" })).toHaveAttribute("href", "https://github.com/herzog0/treepm/tree/feat/alfa-2-login");
    expect(branchItem.getByText("herzog0/treepm")).toBeInTheDocument();
    expect(branchItem.queryByText("aberto")).not.toBeInTheDocument();
  });

  it("shows 'fechado' for a closed pull request", async () => {
    setup({ github: { code: { t2: { links: [makeCodeLink("l9", t2, { state: "closed" })], syncedAt: minutesAgo(1) } } } });
    expect(await (await section()).findByText("fechado")).toBeInTheDocument();
  });

  it("shows the ticket key on each item of a ticket that has items", async () => {
    setup({ ticketId: "t1", github: { code: { t1: { links: [open, makeCodeLink("l4", t3, { repository: treepm, number: 14, title: "Revisão" })], syncedAt: minutesAgo(1) } } } });
    const items = await (await section()).findAllByRole("listitem");
    expect(within(items[0]!).getByText("ALFA-2")).toBeInTheDocument();
    expect(within(items[1]!).getByText("ALFA-3")).toBeInTheDocument();
  });

  it("shows the key only on the links of other tickets when a ticket with items has its own link too", async () => {
    const own = makeCodeLink("l5", { id: "t1", key: "ALFA-1", title: "Planejar a fase" }, { repository: treepm, number: 20, title: "Plano" });
    setup({ ticketId: "t1", github: { code: { t1: { links: [own, open], syncedAt: minutesAgo(1) } } } });
    const items = await (await section()).findAllByRole("listitem");
    expect(within(items[0]!).queryByText("ALFA-1")).not.toBeInTheDocument();
    expect(within(items[1]!).getByText("ALFA-2")).toBeInTheDocument();
  });

  it("does not repeat the key on a ticket's own items", async () => {
    setup({ github: { code: { t2: { links: [open], syncedAt: minutesAgo(1) } } } });
    const items = await (await section()).findAllByRole("listitem");
    expect(within(items[0]!).queryByText("ALFA-2")).not.toBeInTheDocument();
  });

  it("tells how long ago it was updated, or that it never was", async () => {
    setup({ github: { code: { t2: { links: [open], syncedAt: minutesAgo(2) } } } });
    expect(await (await section()).findByText("Atualizado há 2 minutos")).toBeInTheDocument();
  });

  it("says it was never synchronized", async () => {
    setup({ github: { code: { t2: { links: [], syncedAt: null } }, refresh: { ok: false, error: { kind: "unavailable" } } } });
    expect(await (await section()).findByText("Ainda não sincronizado")).toBeInTheDocument();
  });

  it("explains an empty list for a ticket without items", async () => {
    setup({ github: { code: { t2: { links: [], syncedAt: minutesAgo(1) } } } });
    expect(await (await section()).findByText("Nenhum branch ou pull request cita ALFA-2. Inclua a chave no nome do branch ou no título do PR.")).toBeInTheDocument();
  });

  it("explains an empty list for a ticket that has items", async () => {
    setup({ ticketId: "t1", github: { code: { t1: { links: [], syncedAt: minutesAgo(1) } } } });
    expect(await (await section()).findByText("Nenhum branch ou pull request cita este ticket nem os itens dentro dele.")).toBeInTheDocument();
  });

  it("refreshes on demand: the button is disabled meanwhile and the list reloads", async () => {
    const { client } = setup({ github: { code: { t2: { links: [], syncedAt: minutesAgo(1) } } } });
    const code = await section();
    await code.findByText(/Nenhum branch/);
    let release!: (value: ApiResult<CodeRefresh>) => void;
    vi.mocked(client.refreshProjectCode).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const calls = vi.mocked(client.getTicketCode).mock.calls.length;
    await userEvent.click(code.getByRole("button", { name: "Atualizar" }));
    expect(client.refreshProjectCode).toHaveBeenCalledWith("p1");
    expect(code.getByRole("button", { name: "Atualizar" })).toBeDisabled();
    release(ok({ refreshed: true, syncedAt: minutesAgo(0), repositories: [{ id: "link-1", fullName: "herzog0/treepm", status: "ok" }] }));
    await waitFor(() => expect(code.getByRole("button", { name: "Atualizar" })).toBeEnabled());
    await waitFor(() => expect(vi.mocked(client.getTicketCode).mock.calls.length).toBe(calls + 1));
  });

  it("lets a reader refresh too", async () => {
    setup({ me: githubMe(makePanelMe("member", [{ projectId: "p1", role: "reader" }])), github: { code: { t2: { links: [], syncedAt: minutesAgo(1) } } } });
    expect(await (await section()).findByRole("button", { name: "Atualizar" })).toBeEnabled();
  });

  it("warns about a repository that could not be read and about a truncated one", async () => {
    const refresh: CodeRefresh = {
      refreshed: true,
      syncedAt: minutesAgo(0),
      repositories: [
        { id: "a", fullName: "herzog0/privado", status: "unavailable" },
        { id: "b", fullName: "herzog0/grande", status: "truncated" },
        { id: "c", fullName: "herzog0/ok", status: "ok" },
      ],
    };
    setup({ github: { code: { t2: { links: [], syncedAt: minutesAgo(1) } }, refresh } });
    const code = await section();
    await userEvent.click(await code.findByRole("button", { name: "Atualizar" }));
    expect(await code.findByText("Não foi possível ler herzog0/privado agora.")).toBeInTheDocument();
    expect(code.getByText("herzog0/grande tem mais branches ou pull requests do que o TreePM lê; os mais antigos ficam de fora.")).toBeInTheDocument();
    expect(code.queryByText(/herzog0\/ok/)).not.toBeInTheDocument();
  });

  it("shows the quiet line when a manual refresh fails, keeping the stored list", async () => {
    setup({ github: { code: { t2: { links: [open], syncedAt: minutesAgo(1) } }, refresh: { ok: false, error: { kind: "unavailable", code: "github_unavailable" } } } });
    const code = await section();
    await userEvent.click(await code.findByRole("button", { name: "Atualizar" }));
    expect(await code.findByText("Não foi possível atualizar agora.")).toBeInTheDocument();
    expect(code.getByRole("link", { name: "#12 Corrige o login" })).toBeInTheDocument();
  });

  describe("automatic refresh on open", () => {
    it("runs once in the background when it was never synchronized, even with the double effect", async () => {
      const { client } = setup({ strict: true, github: { code: { t2: { links: [open], syncedAt: null } } } });
      const code = await section();
      expect(await code.findByRole("link", { name: "#12 Corrige o login" })).toBeInTheDocument();
      await waitFor(() => expect(client.refreshProjectCode).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(code.getByText(/^Atualizado /)).toBeInTheDocument());
      expect(client.refreshProjectCode).toHaveBeenCalledTimes(1);
    });

    it("runs when the last synchronization is older than 5 minutes", async () => {
      const { client } = setup({ github: { code: { t2: { links: [open], syncedAt: minutesAgo(6) } } } });
      await section();
      await waitFor(() => expect(client.refreshProjectCode).toHaveBeenCalledWith("p1"));
    });

    it("does not run when it is recent", async () => {
      const { client } = setup({ github: { code: { t2: { links: [open], syncedAt: minutesAgo(4) } } } });
      await (await section()).findByRole("link", { name: "#12 Corrige o login" });
      expect(client.refreshProjectCode).not.toHaveBeenCalled();
    });

    it("does not block the page: the stored list shows while it runs", async () => {
      const { client } = setup({ github: { code: { t2: { links: [open], syncedAt: null } } } });
      vi.mocked(client.refreshProjectCode).mockImplementation(() => new Promise(() => {}));
      const code = await section();
      expect(await code.findByRole("link", { name: "#12 Corrige o login" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Escrever o texto");
    });

    it("shows the quiet line and the stored list when it fails", async () => {
      setup({ github: { code: { t2: { links: [open], syncedAt: null } }, refresh: { ok: false, error: { kind: "unavailable", code: "github_unavailable" } } } });
      const code = await section();
      expect(await code.findByText("Não foi possível atualizar agora.")).toBeInTheDocument();
      expect(code.getByRole("link", { name: "#12 Corrige o login" })).toBeInTheDocument();
    });
  });

  describe("archived project", () => {
    it("has no button and no automatic refresh, but shows the stored list", async () => {
      const { client } = setup({ project: archivedProject, github: { code: { t2: { links: [open], syncedAt: null } } } });
      const code = await section();
      expect(await code.findByRole("link", { name: "#12 Corrige o login" })).toBeInTheDocument();
      expect(code.queryByRole("button", { name: "Atualizar" })).not.toBeInTheDocument();
      expect(client.refreshProjectCode).not.toHaveBeenCalled();
      expect(code.getByText("Ainda não sincronizado")).toBeInTheDocument();
    });
  });
});

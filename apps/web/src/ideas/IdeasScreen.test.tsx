import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketSummary } from "../api/client.js";
import { resources } from "../i18n/resources.js";
import { makePanelMe } from "../panel/testing.js";
import { failed, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { IdeasScreen } from "./IdeasScreen.js";
import { resetIdeasSession } from "./session.js";

const SLOW = 8000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const idea = (stage: "new" | "refining" | "ready" | "discarded") => ({ idea: { root: true as const, stage } });
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1" }),
    makeTicket("i1", "p1", 3, "Exportar CSV", { key: "ALFA-3", parentId: "t2", ...idea("ready") }),
    makeTicket("i2", "p1", 4, "Modo escuro", { key: "ALFA-4", ...idea("refining") }),
    makeTicket("i3", "p1", 5, "Notificações", { key: "ALFA-5", ...idea("new") }),
    makeTicket("i4", "p1", 6, "Painel antigo", { key: "ALFA-6", ...idea("discarded") }),
    makeTicket("i5", "p1", 7, "Atalhos de teclado", { key: "ALFA-7", ...idea("new") }),
    makeTicket("c1", "p1", 8, "Dentro da ideia", { key: "ALFA-8", parentId: "i1" }),
  ],
  p2: [makeTicket("j1", "p2", 1, "Relatório mensal", { key: "BETA-1", ...idea("new") })],
};
const ideaCreatedAt = { i1: hoursAgo(3), i2: hoursAgo(5), i3: hoursAgo(30), i4: hoursAgo(50), i5: hoursAgo(2) };
const manager = (): Me => makePanelMe("member", [{ projectId: "p1", role: "manager" }, { projectId: "p2", role: "manager" }]);
const contributor = (): Me => makePanelMe("member", [{ projectId: "p1", role: "contributor" }, { projectId: "p2", role: "contributor" }]);
const reader = (): Me => makePanelMe("member", [{ projectId: "p1", role: "reader" }, { projectId: "p2", role: "reader" }]);

function client(extra: { projects?: typeof projects; tickets?: Record<string, TicketSummary[]> } = {}): ApiClient {
  return makeTreeClient({ projects: extra.projects ?? projects, tickets: extra.tickets ?? tickets, ideaCreatedAt });
}
function renderScreen(api: ApiClient, me: Me, handlers: { onOpenIdea?: (id: string) => void; onShowOnMap?: (id: string) => void } = {}) {
  return render(<IdeasScreen client={api} me={me} onOpenIdea={handlers.onOpenIdea ?? vi.fn()} onShowOnMap={handlers.onShowOnMap ?? vi.fn()} />);
}
const row = (key: string) => screen.getByText(key).closest("li") as HTMLElement;
const GROUPS = ["Pronta para triagem", "Em refinamento", "Nova", "Descartada"];

beforeEach(() => resetIdeasSession());

describe("the Ideias screen: states", () => {
  it("says it is loading, then shows the ideas of the first project", async () => {
    const api = client();
    renderScreen(api, manager());
    expect(screen.getByRole("status")).toHaveTextContent("Carregando as ideias");
    expect(await screen.findByText("ALFA-3")).toBeInTheDocument();
    expect(api.listIdeas).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("heading", { name: "Ideias", level: 1 })).toBeInTheDocument();
  }, SLOW);

  it("says there are no ideas, and how to register one", async () => {
    renderScreen(client({ tickets: { p1: [tickets.p1![0]!], p2: [] } }), manager());
    expect(await screen.findByText("Nenhuma ideia neste projeto")).toBeInTheDocument();
    expect(screen.getByText(/barra de pedidos/i)).toHaveTextContent(/Registrar ideia/);
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  }, SLOW);

  it("shows the error with “Tentar de novo”, and loads again on retry", async () => {
    const api = client();
    const real = api.listIdeas;
    const listIdeas = vi.fn(real).mockResolvedValueOnce(failed("unavailable"));
    Object.assign(api, { listIdeas });
    renderScreen(api, manager());
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("ALFA-3")).toBeInTheDocument();
    expect(listIdeas).toHaveBeenCalledTimes(2);
  }, SLOW);

  it("says there is no project to show when the person sees none", async () => {
    renderScreen(client({ projects: [] }), manager());
    expect(await screen.findByText("Nenhum projeto à vista")).toBeInTheDocument();
  }, SLOW);
});

describe("the Ideias screen: the list", () => {
  it("groups by stage in the order Pronta para triagem, Em refinamento, Nova, Descartada", async () => {
    renderScreen(client(), manager());
    await screen.findByText("ALFA-3");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent ?? "");
    expect(headings).toHaveLength(4);
    GROUPS.forEach((name, index) => expect(headings[index]).toContain(name));
    expect(within(screen.getByRole("region", { name: /^Nova/ })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("ALFA-5"),
      expect.stringContaining("ALFA-7"),
    ]);
  }, SLOW);

  it("omits a stage with no ideas", async () => {
    renderScreen(client({ tickets: { p1: tickets.p1!.filter((entry) => entry.idea?.root !== true || entry.idea.stage === "new"), p2: [] } }), manager());
    await screen.findByText("ALFA-5");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
  }, SLOW);

  it("each row has the key, the title, the path in the tree and how long ago it was registered", async () => {
    renderScreen(client(), manager());
    await screen.findByText("ALFA-3");
    expect(row("ALFA-3")).toHaveTextContent("Exportar CSV");
    expect(row("ALFA-3")).toHaveTextContent("Acesso");
    expect(row("ALFA-3")).toHaveTextContent("Login");
    expect(row("ALFA-3")).toHaveTextContent("há 3 horas");
    expect(row("ALFA-5")).toHaveTextContent("ontem");
  }, SLOW);

  it("a root idea says it is at the root of the project", async () => {
    renderScreen(client(), manager());
    await screen.findByText("ALFA-4");
    expect(row("ALFA-4")).toHaveTextContent("Raiz do projeto");
  }, SLOW);

  it("shortens a long path, keeping the first and the last titles, and the full path is in the tooltip", async () => {
    const chain = ["Um", "Dois", "Três", "Quatro", "Cinco", "Seis"].map((title, index) => makeTicket(`n${index}`, "p1", 20 + index, title, { key: `ALFA-${20 + index}`, ...(index === 0 ? {} : { parentId: `n${index - 1}` }) }));
    const deep = makeTicket("deep", "p1", 30, "Ideia funda", { key: "ALFA-30", parentId: "n5", ...idea("new") });
    renderScreen(client({ tickets: { p1: [...chain, deep], p2: [] } }), manager());
    await screen.findByText("ALFA-30");
    const path = row("ALFA-30").querySelector<HTMLElement>(".ideas-path")!;
    expect(path.textContent).toContain("Um");
    expect(path.textContent).toContain("…");
    expect(path.textContent).toContain("Seis");
    expect(path.textContent).not.toContain("Três");
    expect(path.getAttribute("title")).toBe("Um › Dois › Três › Quatro › Cinco › Seis");
  }, SLOW);

  it("keeps Descartada folded, with its count, until the person opens it", async () => {
    renderScreen(client(), manager());
    await screen.findByText("ALFA-3");
    const toggle = screen.getByRole("button", { name: /Descartada/ });
    expect(toggle).toHaveTextContent("1");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("ALFA-6")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ALFA-6")).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(screen.queryByText("ALFA-6")).not.toBeInTheDocument();
  }, SLOW);

  it("never calls the stage a “tipo”", async () => {
    renderScreen(client(), manager());
    await screen.findByText("ALFA-3");
    await userEvent.click(screen.getByRole("button", { name: /Descartada/ }));
    const texts = [document.body.textContent ?? "", ...[...document.body.querySelectorAll("[aria-label],[title]")].flatMap((element) => [element.getAttribute("aria-label") ?? "", element.getAttribute("title") ?? ""])];
    expect(texts.filter((text) => /\btipo\b/i.test(text))).toEqual([]);
  }, SLOW);
});

describe("the Ideias screen: the project selector", () => {
  it("shows a selector when there is more than one project, and loads the one chosen", async () => {
    const api = client();
    renderScreen(api, manager());
    await screen.findByText("ALFA-3");
    const select = screen.getByRole("combobox", { name: "Projeto" });
    await userEvent.selectOptions(select, "p2");
    expect(await screen.findByText("BETA-1")).toBeInTheDocument();
    expect(api.listIdeas).toHaveBeenLastCalledWith("p2");
    expect(screen.queryByText("ALFA-3")).not.toBeInTheDocument();
  }, SLOW);

  it("has no selector with one project", async () => {
    renderScreen(client({ projects: [projects[0]!] }), manager());
    await screen.findByText("ALFA-3");
    expect(screen.queryByRole("combobox", { name: "Projeto" })).not.toBeInTheDocument();
    expect(screen.getByText(/Projeto Alfa/)).toBeInTheDocument();
  }, SLOW);

  it("remembers the last project for the session, without localStorage", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const first = renderScreen(client(), manager());
    await screen.findByText("ALFA-3");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Projeto" }), "p2");
    await screen.findByText("BETA-1");
    first.unmount();
    renderScreen(client(), manager());
    expect(await screen.findByText("BETA-1")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Projeto" })).toHaveValue("p2");
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  }, SLOW);
});

describe("the Ideias screen: the actions", () => {
  it("“Abrir” opens the idea page and “Ver no mapa” takes the camera to it", async () => {
    const onOpenIdea = vi.fn();
    const onShowOnMap = vi.fn();
    renderScreen(client(), reader(), { onOpenIdea, onShowOnMap });
    await screen.findByText("ALFA-3");
    await userEvent.click(within(row("ALFA-3")).getByRole("button", { name: "Abrir ALFA-3" }));
    expect(onOpenIdea).toHaveBeenCalledWith("i1");
    await userEvent.click(within(row("ALFA-4")).getByRole("button", { name: "Ver no mapa ALFA-4" }));
    expect(onShowOnMap).toHaveBeenCalledWith("i2");
  }, SLOW);

  it("the manager accepts after the same confirmation as on the ticket page, and the list updates", async () => {
    const api = client();
    renderScreen(api, manager());
    await screen.findByText("ALFA-3");
    await userEvent.click(within(row("ALFA-3")).getByRole("button", { name: "Aceitar ALFA-3" }));
    expect(screen.getByText(resources["pt-BR"].ticket.idea.acceptMessage)).toBeInTheDocument();
    expect(api.acceptIdea).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Aceitar ALFA-3" }));
    await waitFor(() => expect(api.acceptIdea).toHaveBeenCalledWith("i1"));
    await waitFor(() => expect(screen.queryByText("ALFA-3")).not.toBeInTheDocument());
    expect(api.listIdeas).toHaveBeenCalledTimes(2);
  }, SLOW);

  it("the manager discards after confirming, and the idea moves to Descartada", async () => {
    const api = client();
    renderScreen(api, manager());
    await screen.findByText("ALFA-4");
    await userEvent.click(within(row("ALFA-4")).getByRole("button", { name: "Descartar ALFA-4" }));
    expect(screen.getByText(resources["pt-BR"].ticket.idea.discardMessage)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Descartar ALFA-4" }));
    await waitFor(() => expect(api.discardIdea).toHaveBeenCalledWith("i2"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Descartada/ })).toHaveTextContent("2"));
    expect(screen.queryByText("ALFA-4")).not.toBeInTheDocument();
  }, SLOW);

  it("cancelling the confirmation does nothing", async () => {
    const api = client();
    renderScreen(api, manager());
    await screen.findByText("ALFA-3");
    await userEvent.click(within(row("ALFA-3")).getByRole("button", { name: "Aceitar ALFA-3" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.acceptIdea).not.toHaveBeenCalled();
    expect(within(row("ALFA-3")).getByRole("button", { name: "Aceitar ALFA-3" })).toBeInTheDocument();
  }, SLOW);

  it("a discarded idea has “Reabrir”, which sends it back to Em refinamento", async () => {
    const api = client();
    renderScreen(api, manager());
    await screen.findByText("ALFA-3");
    await userEvent.click(screen.getByRole("button", { name: /Descartada/ }));
    expect(within(row("ALFA-6")).queryByRole("button", { name: "Aceitar ALFA-6" })).not.toBeInTheDocument();
    await userEvent.click(within(row("ALFA-6")).getByRole("button", { name: "Reabrir ALFA-6" }));
    await waitFor(() => expect(api.putIdeaStage).toHaveBeenCalledWith("i4", { stage: "refining" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: /^Em refinamento/ })).getByText("ALFA-6")).toBeInTheDocument());
  }, SLOW);

  it("shows the refusal next to the list when an action fails", async () => {
    const api = client();
    Object.assign(api, { acceptIdea: vi.fn(async () => failed("forbidden")) });
    renderScreen(api, manager());
    await screen.findByText("ALFA-3");
    await userEvent.click(within(row("ALFA-3")).getByRole("button", { name: "Aceitar ALFA-3" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Aceitar ALFA-3" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("ALFA-3")).toBeInTheDocument();
  }, SLOW);

  it("a contributor sees the list without the triage buttons, a reader too", async () => {
    for (const me of [contributor(), reader()]) {
      const { unmount } = renderScreen(client(), me);
      await screen.findByText("ALFA-3");
      expect(screen.queryByRole("button", { name: /^Aceitar/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Descartar/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Abrir ALFA-3" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Ver no mapa ALFA-3" })).toBeInTheDocument();
      unmount();
    }
  }, SLOW);

  it("the organization admin is a manager everywhere", async () => {
    renderScreen(client(), makePanelMe("admin"));
    await screen.findByText("ALFA-3");
    expect(screen.getByRole("button", { name: "Aceitar ALFA-3" })).toBeInTheDocument();
  }, SLOW);

  it("a reader cannot reopen, a contributor can (it is refining, as on the ticket page)", async () => {
    const { unmount } = renderScreen(client(), reader());
    await screen.findByText("ALFA-3");
    await userEvent.click(screen.getByRole("button", { name: /Descartada/ }));
    expect(screen.queryByRole("button", { name: /^Reabrir/ })).not.toBeInTheDocument();
    unmount();
    renderScreen(client(), contributor());
    await screen.findByText("ALFA-3");
    await userEvent.click(screen.getByRole("button", { name: /Descartada/ }));
    expect(screen.getByRole("button", { name: "Reabrir ALFA-6" })).toBeInTheDocument();
  }, SLOW);

  it("an archived project is read-only: no triage buttons", async () => {
    const archived = [makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-11-01T00:00:00.000Z" })];
    renderScreen(client({ projects: archived }), manager());
    await screen.findByText("ALFA-3");
    expect(screen.queryByRole("button", { name: /^Aceitar/ })).not.toBeInTheDocument();
  }, SLOW);
});

describe("the Ideias screen: languages", () => {
  it.each(["en", "es-MX"] as const)("%s has the screen, the groups and the actions", async (language) => {
    await setTestLanguage(language);
    renderScreen(client(), manager());
    const text = resources[language];
    expect(await screen.findByRole("heading", { name: text.ideas.title, level: 1 })).toBeInTheDocument();
    await screen.findByText("ALFA-3");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent ?? "");
    (["ready", "refining", "new", "discarded"] as const).forEach((stage, index) => expect(headings[index]).toContain(text.map.idea.stage[stage]));
    expect(screen.getByRole("button", { name: text.ideas.actions.openFor.replace("{{key}}", "ALFA-3") })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: text.ideas.project.label })).toBeInTheDocument();
  }, SLOW);

  it("no catalog calls the idea stage a “type”", () => {
    for (const language of ["pt-BR", "en", "es-MX"] as const) {
      const flat = JSON.stringify(resources[language].ideas);
      expect(flat, language).not.toMatch(/\b(tipo|type)s?\b/i);
    }
  });
});

describe("what is listed", () => {
  it("ignores tickets inside an idea: only roots are listed", async () => {
    renderScreen(client(), manager());
    await screen.findByText("ALFA-3");
    expect(screen.queryByText("ALFA-8")).not.toBeInTheDocument();
  }, SLOW);
});

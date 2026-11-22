import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project, TicketDetail } from "../api/client.js";
import i18n from "../i18n/index.js";
import type { Language } from "../i18n/languages.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeCodeLink, makeGithubRepository, makeInstallation, makeMe, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeGithub } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { GithubCallback } from "./GithubCallback.js";
import { GithubSettings } from "./GithubSettings.js";
import { ProjectRepositories } from "./ProjectRepositories.js";
import { TicketCode } from "./TicketCode.js";

type Foreign = Exclude<Language, "pt-BR">;
const goodSearch = "?code=secret-code&state=secret-state&installation_id=42&setup_action=install";
const arrive = (search: string) => window.history.pushState({}, "", `/github/callback${search}`);
afterEach(() => window.history.pushState({}, "", "/"));
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const TEXTS = {
  en: {
    working: "Checking the connection with GitHub…", done: "GitHub connected to account herzog0.", resume: "Continue", back: "Back",
    requested: "The installation request was sent and needs to be approved on GitHub.", incomplete: "The installation was not finished on GitHub.",
    expired: "The connection expired. Start again in Settings.", forbidden: "Only an organization administrator can connect GitHub.", generic: "Could not complete the connection with GitHub.",
    loading: "Loading…", notLinked: "The organization is not linked to GitHub.", connect: "Connect GitHub", hint: "TreePM only reads: repository names, branches and pull requests. No code is copied.",
    askAdmin: "Ask an organization administrator to connect.", linkedTo: "Connected to account herzog0 since November 20, 2026.", selected: "The app only sees the repositories chosen at installation.",
    disconnect: "Disconnect", warning: "The repositories linked to projects and the ticket code links will be removed from TreePM. The app stays installed on GitHub until you remove it there.",
    repos: "Repositories", noRepos: "No repository linked to this project.", repoList: "Project repositories", private: "private", remove: "Remove", removeNamed: "Remove herzog0/treepm",
    removeWarning: "The ticket code links to this repository will be removed.", link: "Link repository", searching: "Searching repositories…", filter: "Filter repositories", none: "No repository found.",
    allLinked: "All the repositories the app can see are already linked.", available: "Available repositories", cancel: "Cancel",
    code: "Code", notSynced: "Not synced yet", updated: "Updated 3 minutes ago", updatedNow: "Updated just now", refresh: "Refresh", refreshFailed: "Could not refresh now.",
    opened: "open", merged: "merged", closed: "closed", noLinksItems: "No branch or pull request mentions this ticket or the items inside it.",
    noLinks: "No branch or pull request mentions ALFA-2. Include the key in the branch name or in the PR title.", unreadable: "Could not read herzog0/treepm now.",
    truncated: "herzog0/treepm has more branches or pull requests than TreePM reads; the oldest are left out.",
    ago: ["just now", "1 minute ago", "2 minutes ago", "1 hour ago", "2 hours ago", "1 day ago", "2 days ago"],
  },
  "es-MX": {
    working: "Comprobando la conexión con GitHub…", done: "GitHub conectado a la cuenta herzog0.", resume: "Continuar", back: "Volver",
    requested: "La solicitud de instalación se envió y debe aprobarse en GitHub.", incomplete: "La instalación no se completó en GitHub.",
    expired: "La conexión expiró. Empieza de nuevo en Configuración.", forbidden: "Solo un administrador de la organización puede conectar GitHub.", generic: "No se pudo completar la conexión con GitHub.",
    loading: "Cargando…", notLinked: "La organización no está vinculada a GitHub.", connect: "Conectar GitHub", hint: "TreePM solo lee: nombres de repositorios, ramas y pull requests. No se copia ningún código.",
    askAdmin: "Pide a un administrador de la organización que la conecte.", linkedTo: "Conectada a la cuenta herzog0 desde el 20 de noviembre de 2026.", selected: "La app solo ve los repositorios elegidos en la instalación.",
    disconnect: "Desconectar", warning: "Los repositorios vinculados a los proyectos y los vínculos de código de los tickets se quitarán de TreePM. La app sigue instalada en GitHub hasta que la quites allá.",
    repos: "Repositorios", noRepos: "Ningún repositorio vinculado a este proyecto.", repoList: "Repositorios del proyecto", private: "privado", remove: "Quitar", removeNamed: "Quitar herzog0/treepm",
    removeWarning: "Se quitarán los vínculos de código de los tickets con este repositorio.", link: "Vincular repositorio", searching: "Buscando repositorios…", filter: "Filtrar repositorios", none: "No se encontró ningún repositorio.",
    allLinked: "Todos los repositorios que ve la app ya están vinculados.", available: "Repositorios disponibles", cancel: "Cancelar",
    code: "Código", notSynced: "Aún no sincronizado", updated: "Actualizado hace 3 minutos", updatedNow: "Actualizado ahora", refresh: "Actualizar", refreshFailed: "No se pudo actualizar ahora.",
    opened: "abierto", merged: "fusionado", closed: "cerrado", noLinksItems: "Ninguna rama ni pull request menciona este ticket ni los elementos dentro de él.",
    noLinks: "Ninguna rama ni pull request menciona ALFA-2. Incluye la clave en el nombre de la rama o en el título del PR.", unreadable: "No se pudo leer herzog0/treepm ahora.",
    truncated: "herzog0/treepm tiene más ramas o pull requests de los que TreePM lee; los más antiguos se quedan fuera.",
    ago: ["ahora", "hace 1 minuto", "hace 2 minutos", "hace 1 hora", "hace 2 horas", "hace 1 día", "hace 2 días"],
  },
};

function callback(search: string, github: FakeGithub = {}, me: Me = makeMe({ github: true })) {
  arrive(search);
  const client = makeClient({ me, github });
  const onOpenSettings = vi.fn();
  const view = render(<GithubCallback client={client} onOpenSettings={onOpenSettings} />);
  return { client, onOpenSettings, ...view };
}

const alpha = makeProject("p1", "ALFA", "Projeto Alfa");
const treepm = makeGithubRepository(1, "herzog0/treepm");
const secret = makeGithubRepository(2, "herzog0/segredo", { private: true });
const linkedRepo = (repo: typeof treepm) => ({ ...repo, id: `link-${repo.repoId}`, linkedAt: "2026-11-20T12:00:00.000Z" });
const adminMe: Me = { ...makePanelMe("admin"), github: { enabled: true } };

describe.each(["en", "es-MX"] as const)("GitHub in %s", (language: Foreign) => {
  const text = TEXTS[language];

  describe("callback", () => {
    it("shows progress, then the account, then the button", async () => {
      await setTestLanguage(language);
      callback(goodSearch);
      expect(screen.getByRole("status")).toHaveTextContent(text.working);
      expect(await screen.findByText(text.done)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.resume })).toBeInTheDocument();
    });

    it.each([
      ["?state=s", "incomplete"],
      ["?code=c&state=s&setup_action=request", "requested"],
    ] as const)("explains the arrival %s", async (search, key) => {
      await setTestLanguage(language);
      callback(search);
      expect(await screen.findByText(text[key])).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.back })).toBeInTheDocument();
    });

    it.each([
      [{ completeError: ["invalid", "invalid_state"] }, makeMe({ github: true }), "expired"],
      [{}, makeMe({ github: true, clerk: "member" }), "forbidden"],
      [{ completeError: ["server_error"] }, makeMe({ github: true }), "generic"],
    ] as const)("explains the error %#", async (github, me, key) => {
      await setTestLanguage(language);
      callback(goodSearch, github as FakeGithub, me);
      expect(await screen.findByRole("alert")).toHaveTextContent(text[key]);
    });
  });

  describe("settings", () => {
    const settings = (me: Me, github: FakeGithub) => render(<GithubSettings client={makeClient({ me, github })} me={me} />);

    it("offers to connect when disconnected, for an administrator", async () => {
      await setTestLanguage(language);
      settings(adminMe, { installation: null });
      expect(await screen.findByText(text.notLinked)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.connect })).toBeInTheDocument();
      expect(screen.getByText(text.hint)).toBeInTheDocument();
    });

    it("asks a member to call an administrator", async () => {
      await setTestLanguage(language);
      const member: Me = { ...makePanelMe("member"), github: { enabled: true } };
      settings(member, { installation: null });
      expect(await screen.findByText(text.askAdmin)).toBeInTheDocument();
    });

    it("shows the account with the date in the language, the selection note and the disconnect warning", async () => {
      await setTestLanguage(language);
      settings(adminMe, { installation: makeInstallation({ repositorySelection: "selected" }) });
      expect(await screen.findByText(text.linkedTo)).toBeInTheDocument();
      expect(screen.getByText(text.selected)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: text.disconnect }));
      expect(screen.getByText(text.warning)).toBeInTheDocument();
    });
  });

  describe("repositories", () => {
    const repositories = (github: FakeGithub, me: Me = adminMe, project: Project = alpha) => {
      const client = makeClient({ me, projects: [project], github: { installation: makeInstallation(), repositories: [treepm, secret], ...github } });
      return render(<ProjectRepositories client={client} me={me} project={project} />);
    };

    it("shows the empty state and lets an administrator link a repository", async () => {
      await setTestLanguage(language);
      repositories({});
      expect(await screen.findByRole("heading", { name: text.repos })).toBeInTheDocument();
      expect(await screen.findByText(text.noRepos)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: text.link }));
      expect(await screen.findByLabelText(text.filter)).toBeInTheDocument();
      const group = screen.getByRole("group", { name: text.available });
      expect(within(group).getByText(text.private)).toBeInTheDocument();
      await userEvent.type(screen.getByLabelText(text.filter), "zzz");
      expect(screen.getByText(text.none)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: text.cancel })).toBeInTheDocument();
    });

    it("lists the linked ones with the private badge and a named remove button with its warning", async () => {
      await setTestLanguage(language);
      repositories({ linked: { p1: [linkedRepo(treepm), linkedRepo(secret)] } });
      const list = await screen.findByRole("list", { name: text.repoList });
      expect(within(list).getByText(text.private)).toBeInTheDocument();
      await userEvent.click(within(list).getByRole("button", { name: text.removeNamed }));
      expect(screen.getByText(text.removeWarning)).toBeInTheDocument();
    });

    it("says when every repository is already linked", async () => {
      await setTestLanguage(language);
      repositories({ repositories: [treepm], linked: { p1: [linkedRepo(treepm)] } });
      await userEvent.click(await screen.findByRole("button", { name: text.link }));
      expect(await screen.findByText(text.allLinked)).toBeInTheDocument();
    });
  });

  describe("ticket code", () => {
    const ticket = { id: "t2", key: "ALFA-2", title: "Escrever o texto" };
    const summary = makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2" });
    const detail = { ...summary, description: "", mentionedBy: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" } as TicketDetail;
    const withLinks = (links: ReturnType<typeof makeCodeLink>[], syncedAt: string | null, extra: FakeGithub = {}) => {
      const client = makeClient({
        me: adminMe, projects: [alpha],
        github: { installation: makeInstallation(), repositories: [treepm], linked: { p1: [linkedRepo(treepm)] }, code: { t2: { links, syncedAt } }, ...extra },
      });
      render(<TicketCode client={client as ApiClient} detail={detail} project={alpha} />);
      return client;
    };

    it("shows the heading, the sync line, the states and the refresh button", async () => {
      await setTestLanguage(language);
      const open = makeCodeLink("l1", ticket, { state: "open" });
      const merged = makeCodeLink("l2", ticket, { number: 9, title: "Primeira versão", state: "merged" });
      const closed = makeCodeLink("l3", ticket, { number: 8, title: "Desistência", state: "closed" });
      withLinks([open, merged, closed], minutesAgo(3));
      const region = within(await screen.findByRole("region", { name: text.code }));
      expect(region.getByText(text.updated)).toBeInTheDocument();
      expect(region.getByRole("button", { name: text.refresh })).toBeInTheDocument();
      for (const state of [text.opened, text.merged, text.closed]) expect(region.getByText(state)).toBeInTheDocument();
    });

    it("says it was not synced yet", async () => {
      await setTestLanguage(language);
      withLinks([], null, { refresh: { ok: false, error: { kind: "unavailable" } } });
      const region = within(await screen.findByRole("region", { name: text.code }));
      await waitFor(() => expect(region.getByText(text.refreshFailed)).toBeInTheDocument());
      expect(region.getByText(text.noLinks)).toBeInTheDocument();
    });

    it("says there are no links for a ticket with items", async () => {
      await setTestLanguage(language);
      const withItems = { ...detail, progress: { done: 0, total: 2, excluded: 0 } };
      const client = makeClient({ me: adminMe, projects: [alpha], github: { installation: makeInstallation(), linked: { p1: [linkedRepo(treepm)] }, code: { t2: { links: [], syncedAt: minutesAgo(1) } } } });
      render(<TicketCode client={client as ApiClient} detail={withItems} project={alpha} />);
      expect(await screen.findByText(text.noLinksItems)).toBeInTheDocument();
    });

    it("warns about a repository that could not be read or was truncated", async () => {
      await setTestLanguage(language);
      withLinks([makeCodeLink("l1", ticket)], minutesAgo(20), {
        refresh: { refreshed: true, syncedAt: new Date().toISOString(), repositories: [{ id: "link-1", fullName: "herzog0/treepm", status: "unavailable" }] },
      });
      expect(await screen.findByText(text.unreadable)).toBeInTheDocument();
    });

    it("warns about a truncated repository", async () => {
      await setTestLanguage(language);
      withLinks([makeCodeLink("l1", ticket)], minutesAgo(20), {
        refresh: { refreshed: true, syncedAt: new Date().toISOString(), repositories: [{ id: "link-1", fullName: "herzog0/treepm", status: "truncated" }] },
      });
      expect(await screen.findByText(text.truncated)).toBeInTheDocument();
    });

    it("has the relative time forms in the catalog", () => {
      const t = i18n.getFixedT(language, "github");
      const now = Date.parse("2026-11-21T12:00:00.000Z");
      const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
      void at;
      expect([
        t("code.relative.now"), t("code.relative.minutes", { count: 1 }), t("code.relative.minutes", { count: 2 }),
        t("code.relative.hours", { count: 1 }), t("code.relative.hours", { count: 2 }), t("code.relative.days", { count: 1 }), t("code.relative.days", { count: 2 }),
      ]).toEqual(text.ago);
    });

    it("says now for a fresh sync", async () => {
      await setTestLanguage(language);
      withLinks([makeCodeLink("l1", ticket)], new Date().toISOString());
      expect(await screen.findByText(text.updatedNow)).toBeInTheDocument();
    });
  });
});

describe("GitHub language switch", () => {
  it("re-renders the open callback notice, the settings and the code section", async () => {
    callback("?state=s");
    expect(await screen.findByText("A instalação não foi concluída no GitHub.")).toBeInTheDocument();
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(screen.getByText(TEXTS.en.incomplete)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("re-renders a callback error and a refresh warning", async () => {
    callback(goodSearch, { completeError: ["invalid", "invalid_state"] });
    expect(await screen.findByRole("alert")).toHaveTextContent("A conexão expirou. Comece de novo em Configurações.");
    await act(async () => {
      await i18n.changeLanguage("es-MX");
    });
    expect(screen.getByRole("alert")).toHaveTextContent(TEXTS["es-MX"].expired);
  });

  it("re-renders the settings section", async () => {
    render(<GithubSettings client={makeClient({ me: adminMe, github: { installation: makeInstallation() } })} me={adminMe} />);
    expect(await screen.findByText("Ligada à conta herzog0 desde 20 de novembro de 2026.")).toBeInTheDocument();
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(screen.getByText(TEXTS.en.linkedTo)).toBeInTheDocument();
  });
});

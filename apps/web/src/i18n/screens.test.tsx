import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { LoadError } from "../LoadError.js";
import { Loading } from "../Loading.js";
import { AppNav } from "../nav/navigation.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { SettingsScreen } from "../settings/SettingsScreen.js";
import { TeamsScreen } from "../teams/TeamsScreen.js";
import { Workspace } from "../Workspace.js";
import type { Me, Person, Team } from "../api/client.js";
import { makeClient, makeMe, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import type { Language } from "./languages.js";
import { resources } from "./resources.js";

/** Textos em português dos catálogos desta entrega que o idioma testado traduziu de outro jeito. */
function portugueseStringsNotShared(language: Language): string[] {
  const out: string[] = [];
  const walk = (pt: unknown, other: unknown) => {
    if (typeof pt === "string") {
      if (pt !== other && !pt.includes("{{") && !pt.includes("<")) out.push(pt);
    } else if (typeof pt === "object" && pt !== null) {
      for (const [key, value] of Object.entries(pt)) walk(value, (other as Record<string, unknown> | undefined)?.[key]);
    }
  };
  for (const namespace of ["app", "settings", "nav", "teams"] as const) walk(resources["pt-BR"][namespace], resources[language][namespace]);
  return out;
}

function expectNoPortuguese(container: HTMLElement, language: Language) {
  const visible = `${container.textContent ?? ""}\n${[...container.querySelectorAll("[aria-label],[title],[placeholder]")]
    .map((element) => ["aria-label", "title", "placeholder"].map((attribute) => element.getAttribute(attribute) ?? "").join(" "))
    .join("\n")}\n${[...container.querySelectorAll("option")].map((option) => option.textContent).join("\n")}`;
  for (const text of portugueseStringsNotShared(language)) expect(visible, `Portuguese text left: "${text}"`).not.toContain(text);
}

const person = (id: string, displayName: string, active = true): Person => ({
  id, displayName, email: `${displayName.toLowerCase()}@example.com`, avatarUrl: null, clerkRole: "member", active,
});
const PEOPLE = [person("p-ana", "Ana"), person("p-bia", "Bia"), person("p-caio", "Caio")];
const TEAMS: Team[] = [
  { id: "t-alfa", name: "Alfa", members: [{ personId: "p-ana", role: "admin" }, { personId: "p-bia", role: "member" }] },
  { id: "t-beta", name: "Beta", members: [{ personId: "p-ana", role: "member" }] },
  { id: "t-gama", name: "Gama", members: [] },
];

const meAsAdmin = (): Me => makeMe({ clerk: "admin" });
const teamsClient = () => ({ ...makeClient(), listTeams: vi.fn(async () => ok(structuredClone(TEAMS))), listPeople: vi.fn(async () => ok(PEOPLE)) });

describe.each([
  {
    language: "en" as const,
    settings: { h1: "Settings", camera: "Camera", cameraGroup: "When closing a ticket", restore: "Return to where it was", stay: "Stay where it is", languageGroup: "Interface language", auto: "Automatic" },
    nav: { label: "Sections", links: ["Map", "Teams", "Settings"] },
    teams: { h1: "Teams", list: "Organization teams", counts: ["2 members", "1 member", "0 members"], create: "New team name", createButton: "Create team", pick: "Choose a team to see its members.", region: "Team Alfa", members: "Members", admin: "Team administrator", member: "Member", rename: "Team name", renameButton: "Rename", remove: "Remove team", add: "Add", person: "Person to add", pickPerson: "Choose a person", removeAna: "Remove Ana" },
    app: { loading: "Loading TreePM…", loadingOrg: "Loading organization…", retry: "Try again", unavailable: "API unavailable.", noAccess: "Session has no access to the API.", config: "TreePM setup", demo: "Open the demo" },
  },
  {
    language: "es-MX" as const,
    settings: { h1: "Configuración", camera: "Cámara", cameraGroup: "Al cerrar un ticket", restore: "Volver a donde estaba", stay: "Quedarse donde está", languageGroup: "Idioma de la interfaz", auto: "Automático" },
    nav: { label: "Secciones", links: ["Mapa", "Equipos", "Configuración"] },
    teams: { h1: "Equipos", list: "Equipos de la organización", counts: ["2 miembros", "1 miembro", "0 miembros"], create: "Nombre del nuevo equipo", createButton: "Crear equipo", pick: "Elige un equipo para ver sus miembros.", region: "Equipo Alfa", members: "Miembros", admin: "Administrador del equipo", member: "Miembro", rename: "Nombre del equipo", renameButton: "Renombrar", remove: "Eliminar equipo", add: "Agregar", person: "Persona por agregar", pickPerson: "Elige una persona", removeAna: "Quitar a Ana" },
    app: { loading: "Cargando TreePM…", loadingOrg: "Cargando organización…", retry: "Intentar de nuevo", unavailable: "API no disponible.", noAccess: "La sesión no tiene acceso a la API.", config: "Configuración de TreePM", demo: "Abrir la demostración" },
  },
])("screens in $language", ({ language, settings, nav, teams, app }) => {
  it("renders Settings", async () => {
    await setTestLanguage(language);
    const { container } = render(<MemoryPreferencesProvider><SettingsScreen /></MemoryPreferencesProvider>);
    expect(screen.getByRole("heading", { level: 1, name: settings.h1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: settings.camera })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: settings.cameraGroup })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: settings.restore })).toBeChecked();
    expect(screen.getByRole("radio", { name: settings.stay })).not.toBeChecked();
    expect(screen.getByRole("radiogroup", { name: settings.languageGroup })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: settings.auto })).toBeChecked();
    expectNoPortuguese(container, language);
  });

  it("renders the navigation", async () => {
    await setTestLanguage(language);
    const { container } = render(<AppNav view="map" onNavigate={() => {}} />);
    const bar = screen.getByRole("navigation", { name: nav.label });
    expect(within(bar).getAllByRole("link").map((link) => link.textContent)).toEqual(nav.links);
    expectNoPortuguese(container, language);
  });

  it("renders the teams list and the open team, with the plural of each count", async () => {
    await setTestLanguage(language);
    const { container } = render(<TeamsScreen client={teamsClient()} me={meAsAdmin()} />);
    expect(screen.getByRole("heading", { level: 1, name: teams.h1 })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: teams.list })).toBeInTheDocument();
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("button").map((button) => button.querySelector("small")?.textContent)).toEqual(teams.counts);
    expect(screen.getByLabelText(teams.create)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: teams.createButton })).toBeInTheDocument();
    expect(screen.getByText(teams.pick)).toBeInTheDocument();

    await userEvent.click(within(list).getByRole("button", { name: /Alfa/ }));
    const region = await screen.findByRole("region", { name: teams.region });
    expect(within(region).getByRole("heading", { level: 3, name: teams.members })).toBeInTheDocument();
    expect(within(region).getByLabelText(teams.rename)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: teams.renameButton })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: teams.remove })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: teams.removeAna })).toBeInTheDocument();
    expect(within(region).getAllByRole("option", { name: teams.admin }).length).toBeGreaterThan(0);
    expect(within(region).getByLabelText(teams.person)).toBeInTheDocument();
    expect(within(region).getByRole("option", { name: teams.pickPerson })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: teams.add })).toBeInTheDocument();
    expectNoPortuguese(container, language);
  });

  it("renders the load error and the loading messages", async () => {
    await setTestLanguage(language);
    const onRetry = vi.fn();
    const { container, rerender } = render(<LoadError error={{ kind: "unavailable" }} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(app.unavailable);
    await userEvent.click(screen.getByRole("button", { name: app.retry }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<LoadError error={{ kind: "forbidden" }} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent(app.noAccess);
    expectNoPortuguese(container, language);
    rerender(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent(app.loading);
  });

  it("renders the workspace loading message and the missing-configuration screen", async () => {
    await setTestLanguage(language);
    const pending = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const { container, unmount } = render(<Workspace orgId="org-1" view="map" getToken={async () => "t"} fetch={pending} />);
    expect(screen.getByRole("status")).toHaveTextContent(app.loadingOrg);
    expectNoPortuguese(container, language);
    unmount();

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    const entry = render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: app.config })).toBeInTheDocument();
    expect(screen.getByText("VITE_CLERK_PUBLISHABLE_KEY").tagName).toBe("CODE");
    expect(screen.getByRole("link", { name: app.demo })).toBeInTheDocument();
    expectNoPortuguese(entry.container, language);
    vi.unstubAllEnvs();
  });
});

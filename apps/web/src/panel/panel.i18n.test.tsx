import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Me, Team } from "../api/client.js";
import { resources } from "../i18n/resources.js";
import type { Language } from "../i18n/languages.js";
import { failed, makeClient, makeMe, makeProject } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { makePerson } from "./testing.js";
import { SidePanel } from "./SidePanel.js";
import type { PanelTab } from "./SidePanel.js";

/** Textos em português do catálogo do painel que o idioma testado traduziu de outro jeito. */
function portugueseNotShared(language: Language): string[] {
  const out: string[] = [];
  const walk = (pt: unknown, other: unknown) => {
    if (typeof pt === "string") {
      if (pt !== other && !pt.includes("{{") && !pt.includes("<")) out.push(pt);
    } else if (typeof pt === "object" && pt !== null) {
      for (const [key, value] of Object.entries(pt)) walk(value, (other as Record<string, unknown> | undefined)?.[key]);
    }
  };
  walk(resources["pt-BR"].panel, resources[language].panel);
  return out;
}

function expectNoPortuguese(container: HTMLElement, language: Language) {
  const visible = `${container.textContent}\n${[...container.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label")).join("\n")}`;
  for (const text of portugueseNotShared(language)) expect(visible, `Portuguese text left: "${text}"`).not.toContain(text);
}

const PEOPLE = [makePerson("p-ana", "Ana"), makePerson("p-bia", "Bia")];
const TEAMS: Team[] = [{ id: "t-alfa", name: "Alfa", members: [] }, { id: "t-beta", name: "Beta", members: [] }];
const PROJECT = makeProject("p1", "PRJ", "Obra", { members: [{ personId: "p-ana", role: "manager" }], teamIds: ["t-alfa"], visibility: "private" });
const ARCHIVED = makeProject("p2", "ARQ", "Velho", { archivedAt: "2026-11-01T00:00:00.000Z" });

function setup(tab: PanelTab, options: { me?: Me; selected?: string | null; client?: Partial<ReturnType<typeof makeClient>>; assistant?: boolean } = {}) {
  const projects = [PROJECT, ARCHIVED];
  const client = { ...makeClient({ areas: [{ id: "a1", name: "Design" }], projects, people: PEOPLE, teams: TEAMS }), ...options.client };
  return render(
    <SidePanel
      client={client}
      me={options.me ?? makeMe({ clerk: "admin" })}
      projects={projects}
      tab={tab}
      selectedProjectId={options.selected ?? null}
      onTabChange={() => undefined}
      onClose={() => undefined}
      onChanged={() => undefined}
      onImportProject={() => undefined}
      onCreateTicket={() => undefined}
      assistantAvailable={options.assistant ?? false}
    />,
  );
}

const EN = {
  panel: "Areas and projects", sections: "Panel sections", areas: "Areas", projects: "Projects", close: "Close",
  loadingAreas: "Loading areas…", newArea: "New area name", createArea: "Create area", missingArea: "Enter the area name.",
  rename: "Rename Design", renameField: "New name of Design", save: "Save", cancel: "Cancel", remove: "Remove Design", confirm: "Confirm: Remove Design",
  newProject: "New project", private: "Private", archived: "Archived", form: "New project", name: "Name", key: "Key", visibility: "Visibility",
  createProject: "Create project", missingName: "Enter the project name.", keyHelp: "The key must start with an uppercase letter and be 2 to 10 characters long, using only uppercase letters and numbers.",
  org: "The whole organization",
  back: "Back to the list", newTicket: "New ticket", noAssistant: "Create without the assistant", importList: "Import list", projectName: "Project name", saveName: "Save name", archive: "Archive project", unarchive: "Unarchive project",
  people: "People with access", roleOf: "Role of Ana", manager: "Manager", contributor: "Contributor", reader: "Reader", revoke: "Revoke access of Ana", pickPerson: "Choose a person", newRole: "Role of the new person", grant: "Give access",
  teams: "Project teams", hint: "Linking a team does not give access to its people; access comes from the roles above.", unlink: "Unlink Alfa", pickTeam: "Choose a team", link: "Link team", noRoles: "Nobody has a role on this project.",
  serverError: "The server ran into an error. Try again; if it keeps happening, let your administrator know.", visibilityLine: "Visibility: Private",
};
const ES = {
  panel: "Áreas y proyectos", sections: "Secciones del panel", areas: "Áreas", projects: "Proyectos", close: "Cerrar",
  loadingAreas: "Cargando áreas…", newArea: "Nombre de la nueva área", createArea: "Crear área", missingArea: "Escribe el nombre del área.",
  rename: "Renombrar Design", renameField: "Nuevo nombre de Design", save: "Guardar", cancel: "Cancelar", remove: "Eliminar Design", confirm: "Confirmar: Eliminar Design",
  newProject: "Nuevo proyecto", private: "Privado", archived: "Archivado", form: "Nuevo proyecto", name: "Nombre", key: "Clave", visibility: "Visibilidad",
  createProject: "Crear proyecto", missingName: "Escribe el nombre del proyecto.", keyHelp: "La clave debe empezar con una letra mayúscula y tener de 2 a 10 caracteres, solo letras mayúsculas y números.",
  org: "Toda la organización",
  back: "Volver a la lista", newTicket: "Nuevo ticket", noAssistant: "Crear sin el asistente", importList: "Importar lista", projectName: "Nombre del proyecto", saveName: "Guardar nombre", archive: "Archivar proyecto", unarchive: "Desarchivar proyecto",
  people: "Personas con acceso", roleOf: "Rol de Ana", manager: "Gestor", contributor: "Colaborador", reader: "Lector", revoke: "Revocar el acceso de Ana", pickPerson: "Elige una persona", newRole: "Rol de la persona nueva", grant: "Dar acceso",
  teams: "Equipos del proyecto", hint: "Asociar un equipo no da acceso a sus integrantes; el acceso viene de los roles de arriba.", unlink: "Desasociar Alfa", pickTeam: "Elige un equipo", link: "Asociar equipo", noRoles: "Nadie tiene un rol en este proyecto.",
  serverError: "El servidor tuvo un error. Inténtalo de nuevo; si sigue igual, avisa a quien administra.", visibilityLine: "Visibilidad: Privado",
};

describe.each([
  { language: "en" as const, s: EN },
  { language: "es-MX" as const, s: ES },
])("side panel in $language", ({ language, s }) => {
  it("renders the areas tab, with edit, confirmation and error", async () => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    const createArea = vi.fn(async () => failed("server_error"));
    const { container } = setup("areas", { client: { createArea } });
    expect(screen.getByRole("complementary", { name: s.panel })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: s.sections })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: s.areas })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: s.projects })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.close })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: s.areas })).toBeInTheDocument();
    expect(await screen.findByText("Design")).toBeInTheDocument();
    expect(screen.getByLabelText(s.newArea)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: s.createArea }));
    expect(screen.getByRole("alert")).toHaveTextContent(s.missingArea);
    await user.type(screen.getByLabelText(s.newArea), "Nova");
    await user.click(screen.getByRole("button", { name: s.createArea }));
    expect(await screen.findByText(s.serverError)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: s.rename }));
    expect(screen.getByLabelText(s.renameField)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.save })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: s.cancel }));
    await user.click(screen.getByRole("button", { name: s.remove }));
    expect(screen.getByRole("button", { name: s.confirm })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.cancel })).toBeInTheDocument();
    expectNoPortuguese(container, language);
  });

  it("shows the loading text of areas", async () => {
    await setTestLanguage(language);
    setup("areas", { client: { listAreas: () => new Promise(() => undefined) } });
    expect(screen.getByRole("status")).toHaveTextContent(s.loadingAreas);
  });

  it("renders the projects list and the creation form", async () => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    const { container } = setup("projects");
    expect(screen.getByRole("heading", { level: 2, name: s.projects })).toBeInTheDocument();
    expect(screen.getByText(s.private)).toBeInTheDocument();
    expect(screen.getByText(s.archived)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: s.newProject }));
    const form = screen.getByRole("form", { name: s.form });
    expect(within(form).getByLabelText(s.name)).toBeInTheDocument();
    expect(within(form).getByLabelText(s.key)).toBeInTheDocument();
    expect(within(form).getByLabelText(s.visibility)).toBeInTheDocument();
    expect(within(form).getByRole("option", { name: s.org })).toBeInTheDocument();
    expect(within(form).getByRole("option", { name: s.private })).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: s.createProject }));
    expect(within(form).getByText(s.missingName)).toBeInTheDocument();
    expect(within(form).getByText(s.keyHelp)).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: s.cancel })).toBeInTheDocument();
    expectNoPortuguese(container, language);
  });

  it("renders the empty projects text for a member", async () => {
    await setTestLanguage(language);
    const { container } = render(
      <SidePanel client={makeClient()} me={makeMe({ clerk: "member" })} projects={[]} tab="projects" selectedProjectId={null} onTabChange={() => undefined} onClose={() => undefined} onChanged={() => undefined} />,
    );
    expect(container.textContent).toContain(language === "en" ? "No projects created." : "No hay proyectos creados.");
    expectNoPortuguese(container, language);
  });

  it("renders the project detail with people and teams", async () => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    const { container } = setup("projects", { selected: "p1" });
    expect(screen.getByRole("button", { name: s.back })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.newTicket })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.importList })).toBeInTheDocument();
    expect(screen.getByLabelText(s.projectName)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.saveName })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.archive })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: s.people })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: s.roleOf })).toBeInTheDocument();
    for (const role of [s.manager, s.contributor, s.reader]) expect(screen.getAllByRole("option", { name: role })).toHaveLength(2);
    expect(screen.getByRole("button", { name: s.revoke })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: s.pickPerson })).toBeInTheDocument();
    expect(screen.getByLabelText(s.newRole)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.grant })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: s.teams })).toBeInTheDocument();
    expect(await screen.findByText(s.hint)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.unlink })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: s.pickTeam })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: s.link })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: s.revoke }));
    expect(screen.getByRole("button", { name: `${language === "en" ? "Confirm" : "Confirmar"}: ${s.revoke}` })).toBeInTheDocument();
    expectNoPortuguese(container, language);
  });

  it("renders the detail of an archived project, a reader view and the assistant variant", async () => {
    await setTestLanguage(language);
    const archived = setup("projects", { selected: "p2" });
    expect(screen.getByRole("button", { name: s.unarchive })).toBeInTheDocument();
    expect(await screen.findByText(s.noRoles)).toBeInTheDocument();
    archived.unmount();
    const reader = setup("projects", { selected: "p1", me: makeMe({ clerk: "member" }), assistant: true });
    expect(await screen.findByText(s.visibilityLine)).toBeInTheDocument();
    expect(reader.container.textContent).toContain(s.manager);
    reader.unmount();
    setup("projects", { selected: "p1", assistant: true });
    expect(screen.getByRole("button", { name: s.noAssistant })).toBeInTheDocument();
  });

  it("follows a language change while the panel is open", async () => {
    await setTestLanguage(language);
    setup("areas");
    expect(screen.getByRole("complementary", { name: s.panel })).toBeInTheDocument();
    await setTestLanguage("pt-BR");
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fechar" })).toBeInTheDocument();
  });
});

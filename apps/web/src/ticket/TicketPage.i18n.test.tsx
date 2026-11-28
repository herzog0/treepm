import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project, TicketDetail, TicketSummary } from "../api/client.js";
import type { Language } from "../i18n/languages.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { CreateTicket } from "./CreateTicket.js";
import { reopenedNoticeText, reopenWarningText } from "./reopen.js";
import { TicketPage } from "./TicketPage.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const archivedProject = makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")];
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", status: "in_review", progress: { done: 1, total: 3, excluded: 1 }, assigneeIds: ["person-1"] }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Fase vazia", { key: "ALFA-4" }),
  makeTicket("t5", "p1", 5, "Entregue", { key: "ALFA-5", status: "done" }),
];
const detailOf = (summary: TicketSummary, description = "Texto de teste"): TicketDetail => ({
  ...summary, description, mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const byAi = { text: "Reúne o trabalho.", source: "assistant" as const, updatedAt: "2026-11-20T12:00:00.000Z" };
const aiMe = (me: Me = makePanelMe("admin")): Me => ({ ...me, assistant: { enabled: true } });

function setup(options: { me?: Me; project?: Project; ticketId?: string; override?: Partial<Record<keyof ApiClient, unknown>> } = {}) {
  const theProject = options.project ?? project;
  const me = options.me ?? aiMe();
  const client = makeClient({ me, projects: [theProject], people, tickets: { p1: summaries }, summaries: { texts: { t1: byAi } } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!, id === "t4" ? "" : "Texto de teste"))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    ...options.override,
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onShowOnMap: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const view = render(<TicketPage client={client} me={me} projects={[theProject]} ticketId={options.ticketId ?? "t1"} creating={null} {...handlers} />);
  return { client, view };
}

/** Textos em português do catálogo `ticket` que o idioma testado traduziu de outro jeito: nenhum pode sobrar na tela. */
const PORTUGUESE = ["Ver no mapa", "Copiar link", "Mais ações", "Link copiado", "Página do ticket", "Situação", "Progresso", "Pessoas", "Ticket pai", "Descrição", "O que entra aqui", "Itens", "Raiz do projeto", "Novo ticket aqui dentro", "Carregando", "Escrito pela IA", "concluídos"];
const expectNoPortuguese = (container: HTMLElement) => {
  const visible = `${container.textContent ?? ""} ${[...container.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label")).join(" ")}`;
  for (const text of PORTUGUESE) expect(visible, `Portuguese text left: "${text}"`).not.toContain(text);
};

describe.each([
  {
    language: "en" as const,
    page: "Ticket page", close: "Close and go back to the map", status: "Status", progress: "1 of 3 done · 1 canceled", chip: "In review", people: "People", parent: "Parent ticket", root: "Project root",
    editTitle: "Edit title", invite: "Click to write the description.", description: "Description", add: "Add", remove: "Remove Ana", summary: "What goes in here", summaryMeta: "Written by the AI on November 20, 2026",
    items: "Items", newHere: "New ticket inside", removeTicket: "Remove ticket", itemState: "To do", doneButton: "Done",
    derived: "Calculated from its items.", refusedDerived: "This ticket's status comes from its items. Change the status of the items.",
    archived: "This project is archived: this page is read-only.", reader: "You have read-only access to this project.",
    empty: "No tickets inside.", noDescription: "No description.", noOne: "No one assigned",
    pick: "Choose the parent ticket", filter: "Filter tickets",
    viewOnMap: "Show on map", copyLink: "Copy link", more: "More actions", linkCopied: "Link copied", copyFailed: "Could not copy the link",
  },
  {
    language: "es-MX" as const,
    page: "Página del ticket", close: "Cerrar y volver al mapa", status: "Estado", progress: "1 de 3 terminados · 1 cancelado", chip: "En revisión", people: "Personas", parent: "Ticket padre", root: "Raíz del proyecto",
    editTitle: "Editar título", invite: "Haz clic para escribir la descripción.", description: "Descripción", add: "Agregar", remove: "Quitar a Ana", summary: "Qué entra aquí", summaryMeta: "Escrito por la IA el 20 de noviembre de 2026",
    items: "Elementos", newHere: "Nuevo ticket aquí dentro", removeTicket: "Eliminar ticket", itemState: "Por hacer", doneButton: "Terminado",
    derived: "Calculado a partir de sus elementos.", refusedDerived: "El estado de este ticket viene de sus elementos. Cambia el estado de los elementos.",
    archived: "Este proyecto está archivado: esta página es de solo lectura.", reader: "Tienes acceso de solo lectura a este proyecto.",
    empty: "Ningún ticket aquí dentro.", noDescription: "Sin descripción.", noOne: "Nadie asignado",
    pick: "Elige el ticket padre", filter: "Filtrar tickets",
    viewOnMap: "Ver en el mapa", copyLink: "Copiar enlace", more: "Más acciones", linkCopied: "Enlace copiado", copyFailed: "No se pudo copiar el enlace",
  },
])("ticket page in $language", (expected) => {
  const { language } = expected;

  it("shows the whole page of a ticket with items in the language", async () => {
    await setTestLanguage(language);
    const { view } = setup();
    const page = await screen.findByRole("complementary", { name: expected.page });
    await screen.findByRole("heading", { level: 1, name: "Planejar a fase" });
    expect(within(page).getByRole("button", { name: expected.close })).toBeInTheDocument();
    for (const term of [expected.status, expected.people, expected.parent, expected.root]) expect(page).toHaveTextContent(term);
    expect(page).toHaveTextContent(expected.progress);
    expect(within(page).getByText(expected.derived).closest("dd")).toHaveTextContent(expected.chip);
    expect(within(page).queryByRole("button", { name: expected.chip })).not.toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.editTitle })).toBeInTheDocument();
    expect(within(page).getByRole("group", { name: expected.description })).toBeInTheDocument();
    expect(within(page).getByRole("heading", { level: 2, name: expected.description })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.remove })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.add })).toBeInTheDocument();
    expect(within(page).getByRole("heading", { level: 2, name: expected.items })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.newHere })).toBeInTheDocument();
    await userEvent.click(within(page).getByRole("button", { name: expected.more }));
    expect(within(page).getByRole("button", { name: expected.removeTicket })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: /ALFA-2/ })).toHaveTextContent(expected.itemState === "To do" ? "In progress" : "En curso");
    expect(await within(page).findByRole("region", { name: expected.summary })).toHaveTextContent(expected.summaryMeta);
    expectNoPortuguese(view.container);
  });

  it("shows a ticket without items and without a description", async () => {
    await setTestLanguage(language);
    setup({ ticketId: "t4" });
    const page = await screen.findByRole("complementary", { name: expected.page });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    expect(page).toHaveTextContent(expected.empty);
    expect(within(page).getByRole("button", { name: expected.invite })).toBeInTheDocument();
    expect(within(page).queryByRole("region", { name: expected.summary })).not.toBeInTheDocument();
  });

  it("says why the page is read-only, for an archived project and for a reader", async () => {
    await setTestLanguage(language);
    const archived = setup({ project: archivedProject, ticketId: "t4" });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    expect(screen.getByRole("complementary")).toHaveTextContent(expected.archived);
    expect(screen.getByRole("complementary")).toHaveTextContent(expected.noOne);
    archived.view.unmount();
    setup({ me: makePanelMe("member", [{ projectId: "p1", role: "reader" }]), ticketId: "t4" });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    expect(screen.getByRole("complementary")).toHaveTextContent(expected.reader);
  });

  it("refuses a status that became derived, in the language", async () => {
    await setTestLanguage(language);
    const updateTicket = vi.fn(async () => failed("conflict", "status_is_derived"));
    setup({ override: { updateTicket }, ticketId: "t4" });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    await userEvent.click(screen.getByRole("button", { name: expected.itemState }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: expected.doneButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(expected.refusedDerived);
  });

  it("opens the parent picker with its labels in the language", async () => {
    await setTestLanguage(language);
    setup({ ticketId: "t4" });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    await userEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("aria-expanded") === "false" && !button.hasAttribute("aria-haspopup"))!);
    const picker = screen.getByRole("group", { name: expected.pick });
    expect(within(picker).getByRole("textbox", { name: expected.filter })).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: expected.root })).toBeInTheDocument();
  });

  it("names the header buttons, the status menu and the copy notices in the language", async () => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    // Um ticket sem filhos: o de com filhos não tem menu de situação (ADR 0068).
    const { view } = setup({ ticketId: "t4" });
    const page = await screen.findByRole("complementary", { name: expected.page });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    for (const name of [expected.viewOnMap, expected.copyLink, expected.more, expected.close]) expect(within(page).getByRole("button", { name })).toBeInTheDocument();
    await user.click(within(page).getByRole("button", { name: expected.copyLink }));
    expect(await within(page).findByRole("status")).toHaveTextContent(expected.linkCopied);
    await user.click(within(page).getByRole("button", { name: expected.itemState }));
    expect(within(screen.getByRole("menu", { name: expected.status })).getAllByRole("menuitemradio")).toHaveLength(5);
    expectNoPortuguese(view.container);
  });

  it("says the link could not be copied, in the language", async () => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("negado"));
    setup();
    const page = await screen.findByRole("complementary", { name: expected.page });
    await screen.findByRole("heading", { level: 1, name: "Planejar a fase" });
    await user.click(within(page).getByRole("button", { name: expected.copyLink }));
    expect(await within(page).findByRole("alert")).toHaveTextContent(expected.copyFailed);
  });

  it("shows the summary editor with the formatted counter", async () => {
    await setTestLanguage(language);
    setup();
    const region = await screen.findByRole("region", { name: expected.summary });
    await userEvent.click(within(region).getAllByRole("button")[0]!);
    const counter = language === "en" ? "17 of 1,000 characters" : "17 de 1,000 caracteres";
    expect(region).toHaveTextContent(counter);
  });
});

describe("ticket page language switch", () => {
  it("changes the open page when the language changes", async () => {
    setup();
    await screen.findByRole("heading", { level: 1, name: "Planejar a fase" });
    expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(await screen.findByRole("complementary", { name: "Ticket page" })).toHaveTextContent("Parent ticket");
    await act(async () => { await i18n.changeLanguage("es-MX"); });
    expect(await screen.findByRole("complementary", { name: "Página del ticket" })).toHaveTextContent("Ticket padre");
  });
});

describe("create ticket in the language", () => {
  const show = (request: Parameters<typeof CreateTicket>[0]["request"]) =>
    render(<CreateTicket client={makeClient()} project={project} request={request} onChanged={vi.fn()} onCreated={vi.fn()} onCancel={vi.fn()} />);

  it.each([
    { language: "en" as const, heading: "New ticket", inside: "In Projeto Alfa, inside the open ticket.", root: "In Projeto Alfa, at the project root.", title: "Title", description: "Description", create: "Create", cancel: "Cancel", warning: "“ALFA-5” is done and stops being done when it receives this ticket: its status comes from its items." },
    { language: "es-MX" as const, heading: "Nuevo ticket", inside: "En Projeto Alfa, dentro del ticket abierto.", root: "En Projeto Alfa, en la raíz del proyecto.", title: "Título", description: "Descripción", create: "Crear", cancel: "Cancelar", warning: "«ALFA-5» está terminado y deja de estarlo al recibir este ticket: su estado sale de sus elementos." },
  ])("shows the form in $language, with the reopen warning", async (expected) => {
    await setTestLanguage(expected.language);
    const { unmount } = show({ projectId: "p1", parentId: "t5", parent: { key: "ALFA-5", status: "done" } });
    expect(screen.getByRole("heading", { level: 1, name: expected.heading })).toBeInTheDocument();
    expect(screen.getByText(expected.inside)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: expected.title })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: expected.description })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: expected.create })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: expected.cancel })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(expected.warning);
    unmount();
    show({ projectId: "p1", parentId: null });
    expect(screen.getByText(expected.root)).toBeInTheDocument();
  });
});

describe("texts for a done ticket that receives an open one (ADR 0068: the status comes from the items)", () => {
  const cases = [
    { language: "pt-BR" as const, warning: "«K-1» está concluído e deixa de estar ao receber este ticket: a situação dele sai dos itens.", notice: "«K-1» estava concluído e deixou de estar: a situação dele sai dos itens." },
    { language: "en" as const, warning: "“K-1” is done and stops being done when it receives this ticket: its status comes from its items.", notice: "“K-1” was done and no longer is: its status comes from its items." },
    { language: "es-MX" as const, warning: "«K-1» está terminado y deja de estarlo al recibir este ticket: su estado sale de sus elementos.", notice: "«K-1» estaba terminado y dejó de estarlo: su estado sale de sus elementos." },
  ];
  it.each(cases)("in $language", async ({ language, warning, notice }) => {
    await setTestLanguage(language as Language);
    const t = i18n.getFixedT(language, "ticket");
    expect(reopenWarningText(t, "K-1")).toBe(warning);
    expect(reopenedNoticeText(t, "K-1")).toBe(notice);
  });
});

void waitFor;

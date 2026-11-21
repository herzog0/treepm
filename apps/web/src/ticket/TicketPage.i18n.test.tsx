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
import { openItemsText } from "./fields.js";
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
  ...summary, description, createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
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
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const view = render(<TicketPage client={client} me={me} projects={[theProject]} ticketId={options.ticketId ?? "t1"} creating={null} {...handlers} />);
  return { client, view };
}

/** Textos em português do catálogo `ticket` que o idioma testado traduziu de outro jeito: nenhum pode sobrar na tela. */
const PORTUGUESE = ["Página do ticket", "Situação", "Progresso", "Pessoas", "Ticket pai", "Descrição", "O que entra aqui", "Itens", "Raiz do projeto", "Novo ticket aqui dentro", "Carregando", "Escrito pela IA", "concluídos"];
const expectNoPortuguese = (container: HTMLElement) => {
  const visible = `${container.textContent ?? ""} ${[...container.querySelectorAll("[aria-label]")].map((node) => node.getAttribute("aria-label")).join(" ")}`;
  for (const text of PORTUGUESE) expect(visible, `Portuguese text left: "${text}"`).not.toContain(text);
};

describe.each([
  {
    language: "en" as const,
    page: "Ticket page", close: "Close and go back to the map", status: "Status", progress: "1 of 3 done · 1 canceled", chip: "In review", people: "People", parent: "Parent ticket", root: "Project root",
    editTitle: "Edit title", editDescription: "Edit description", description: "Description", add: "Add", remove: "Remove Ana", summary: "What goes in here", summaryMeta: "Written by the AI on November 20, 2026",
    items: "Items", newHere: "New ticket inside", removeTicket: "Remove ticket", itemState: "To do", doneButton: "Done",
    openItems: "Finish or cancel the open item before finishing this ticket.",
    archived: "This project is archived: this page is read-only.", reader: "You have read-only access to this project.",
    empty: "No tickets inside.", noDescription: "No description.", noOne: "No one assigned",
    pick: "Choose the parent ticket", filter: "Filter tickets",
  },
  {
    language: "es-MX" as const,
    page: "Página del ticket", close: "Cerrar y volver al mapa", status: "Estado", progress: "1 de 3 terminados · 1 cancelado", chip: "En revisión", people: "Personas", parent: "Ticket padre", root: "Raíz del proyecto",
    editTitle: "Editar título", editDescription: "Editar descripción", description: "Descripción", add: "Agregar", remove: "Quitar a Ana", summary: "Qué entra aquí", summaryMeta: "Escrito por la IA el 20 de noviembre de 2026",
    items: "Elementos", newHere: "Nuevo ticket aquí dentro", removeTicket: "Eliminar ticket", itemState: "Por hacer", doneButton: "Terminado",
    openItems: "Termina o cancela el elemento abierto antes de terminar este ticket.",
    archived: "Este proyecto está archivado: esta página es de solo lectura.", reader: "Tienes acceso de solo lectura a este proyecto.",
    empty: "Ningún ticket aquí dentro.", noDescription: "Sin descripción.", noOne: "Nadie asignado",
    pick: "Elige el ticket padre", filter: "Filtrar tickets",
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
    expect(within(page).getByRole("group", { name: expected.status })).toBeInTheDocument();
    expect(page).toHaveTextContent(expected.progress);
    expect(within(page).getByRole("button", { name: expected.chip })).toHaveAttribute("aria-pressed", "true");
    expect(within(page).getByRole("button", { name: expected.editTitle })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.editDescription })).toBeInTheDocument();
    expect(within(page).getByRole("heading", { level: 2, name: expected.description })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.remove })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.add })).toBeInTheDocument();
    expect(within(page).getByRole("heading", { level: 2, name: expected.items })).toBeInTheDocument();
    expect(within(page).getByRole("button", { name: expected.newHere })).toBeInTheDocument();
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
    expect(page).toHaveTextContent(expected.noDescription);
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

  it("refuses to conclude with open items, in the language", async () => {
    await setTestLanguage(language);
    const updateTicket = vi.fn(async () => failed("conflict", "ticket_has_open_children"));
    setup({ override: { updateTicket } });
    await screen.findByRole("heading", { level: 1, name: "Planejar a fase" });
    await userEvent.click(screen.getByRole("button", { name: expected.doneButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(expected.openItems);
  });

  it("opens the parent picker with its labels in the language", async () => {
    await setTestLanguage(language);
    setup({ ticketId: "t4" });
    await screen.findByRole("heading", { level: 1, name: "Fase vazia" });
    await userEvent.click(screen.getAllByRole("button").find((button) => button.getAttribute("aria-expanded") === "false")!);
    const picker = screen.getByRole("group", { name: expected.pick });
    expect(within(picker).getByRole("textbox", { name: expected.filter })).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: expected.root })).toBeInTheDocument();
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
    { language: "en" as const, heading: "New ticket", inside: "In Projeto Alfa, inside the open ticket.", root: "In Projeto Alfa, at the project root.", title: "Title", description: "Description", create: "Create", cancel: "Cancel", warning: "“ALFA-5” is done and goes back to \"To do\" when it receives this ticket." },
    { language: "es-MX" as const, heading: "Nuevo ticket", inside: "En Projeto Alfa, dentro del ticket abierto.", root: "En Projeto Alfa, en la raíz del proyecto.", title: "Título", description: "Descripción", create: "Crear", cancel: "Cancelar", warning: "«ALFA-5» está terminado y vuelve a \"Por hacer\" al recibir este ticket." },
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

describe("reopen texts and the open-items message by count", () => {
  const cases = [
    { language: "pt-BR" as const, zero: "Conclua ou cancele os 0 itens abertos antes de concluir este ticket.", one: "Conclua ou cancele o item aberto antes de concluir este ticket.", two: "Conclua ou cancele os 2 itens abertos antes de concluir este ticket.", warning: "«K-1» está concluído e volta para \"A fazer\" ao receber este ticket.", notice: "«K-1» estava concluído e voltou para \"A fazer\"." },
    { language: "en" as const, zero: "Finish or cancel the 0 open items before finishing this ticket.", one: "Finish or cancel the open item before finishing this ticket.", two: "Finish or cancel the 2 open items before finishing this ticket.", warning: "“K-1” is done and goes back to \"To do\" when it receives this ticket.", notice: "“K-1” was done and went back to \"To do\"." },
    { language: "es-MX" as const, zero: "Termina o cancela los 0 elementos abiertos antes de terminar este ticket.", one: "Termina o cancela el elemento abierto antes de terminar este ticket.", two: "Termina o cancela los 2 elementos abiertos antes de terminar este ticket.", warning: "«K-1» está terminado y vuelve a \"Por hacer\" al recibir este ticket.", notice: "«K-1» estaba terminado y volvió a \"Por hacer\"." },
  ];
  it.each(cases)("in $language", async ({ language, zero, one, two, warning, notice }) => {
    await setTestLanguage(language as Language);
    const t = i18n.getFixedT(language, "ticket");
    expect([openItemsText(t, 0), openItemsText(t, 1), openItemsText(t, 2)]).toEqual([zero, one, two]);
    expect(reopenWarningText(t, "K-1")).toBe(warning);
    expect(reopenedNoticeText(t, "K-1")).toBe(notice);
  });
});

void waitFor;

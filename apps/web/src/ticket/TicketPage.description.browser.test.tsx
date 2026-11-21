import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";
import type { TicketPageProps } from "./TicketPage.js";

// Digitação de verdade, em navegador real (ADR 0036): a descrição em blocos, as menções e o salvamento ao sair do campo.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", status: "in_review" }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
  makeTicket("t5", "p1", 5, "Fase vazia", { key: "ALFA-5" }),
];
const detailOf = (id: string, description: string): TicketDetail => ({
  ...summaries.find((entry) => entry.id === id)!, description, createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});

function clientWith(description: string, updateTicket?: ApiClient["updateTicket"]): ApiClient {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  return Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(id, description))),
    updateTicket: updateTicket ?? vi.fn(async (id: string, body: { description?: string }) => ok(detailOf(id, body.description ?? description))),
    createTicket: vi.fn(async () => ok(detailOf("t5", ""))),
  });
}

async function open(description: string, extra: { updateTicket?: ApiClient["updateTicket"]; creating?: TicketPageProps["creating"]; ticketId?: string | null } = {}) {
  const client = clientWith(description, extra.updateTicket);
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(
    <TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId={extra.ticketId === undefined ? "t2" : extra.ticketId} creating={extra.creating ?? null} {...handlers} />,
  );
  await expect.element(screen.getByRole("heading", { level: 1 })).toBeVisible();
  return { screen, client, ...handlers, update: client.updateTicket as ReturnType<typeof vi.fn> };
}

const lastDescription = (update: ReturnType<typeof vi.fn>) => (update.mock.calls.at(-1) as [string, { description: string }])[1].description;

describe("description editing in place", () => {
  it("clicking the text edits it; typing and leaving the field saves once, and the indicator says so", async () => {
    const { screen, update } = await open("Texto antigo");
    await screen.getByText("Texto antigo").click();
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).toHaveFocus();
    await userEvent.keyboard("{Control>}{End}{/Control} novo");
    await screen.getByRole("heading", { level: 1 }).click();
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(update).toHaveBeenCalledWith("t2", { description: "Texto antigo novo" });
    await expect.element(screen.getByText("Salvo")).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).not.toBeInTheDocument();
  });

  it("does not call the API when the text did not change", async () => {
    const { screen, update } = await open("Texto antigo");
    await screen.getByText("Texto antigo").click();
    await screen.getByRole("heading", { level: 1 }).click();
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("does not rewrite a stored text that the editor would write differently when nothing was edited", async () => {
    const { screen, update } = await open("Critérios de aceite:\n- um\n- dois");
    await screen.getByText("dois").click();
    await screen.getByRole("heading", { level: 1 }).click();
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter saves and leaves the edition", async () => {
    const { screen, update } = await open("Texto antigo");
    await screen.getByText("Texto antigo").click();
    await userEvent.keyboard("{Control>}{End}{/Control}!{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(lastDescription(update)).toBe("Texto antigo!");
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).not.toBeInTheDocument();
  });

  it("Enter on the focused text starts the edition", async () => {
    const { screen } = await open("Texto antigo");
    screen.getByRole("group", { name: "Descrição" }).element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).toHaveFocus();
  });

  it("Esc undoes what was not saved without closing the page; a second Esc closes it", async () => {
    const { screen, update, onClose } = await open("Texto antigo");
    await screen.getByText("Texto antigo").click();
    await userEvent.keyboard("{Control>}{End}{/Control} lixo{Escape}");
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Texto antigo")).toBeVisible();
    expect(update).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the text and shows the API error when saving fails, and nothing is lost", async () => {
    const { screen, update } = await open("Texto antigo", { updateTicket: vi.fn(async () => failed("not_found")) });
    await screen.getByText("Texto antigo").click();
    await userEvent.keyboard("{Control>}{End}{/Control} novo{Control>}{Enter}{/Control}");
    await expect.poll(() => document.querySelector("[role=alert]")?.textContent).toContain("Não encontramos esse item");
    await expect.poll(() => document.querySelector("[role=textbox]")?.textContent).toBe("Texto antigo novo");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("an empty description offers an invitation that starts the edition", async () => {
    const { screen, update } = await open("");
    await screen.getByRole("button", { name: "Clique para escrever a descrição." }).click();
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).toHaveFocus();
    await userEvent.keyboard("Primeira{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(lastDescription(update)).toBe("Primeira");
  });
});

describe("blocks menu (/)", () => {
  it("opens with '/', filters by typing, inserts the block with Enter and Esc closes only the menu", async () => {
    const { screen, update, onClose } = await open("Texto");
    await screen.getByText("Texto").click();
    await userEvent.keyboard("{Control>}{End}{/Control}{Enter}/");
    const menu = screen.getByRole("menu", { name: "Blocos" });
    await expect.element(menu).toBeVisible();
    for (const label of ["Texto", "Título", "Lista", "Lista de tarefas", "Citação", "Código", "Mencionar ticket"]) await expect.element(menu.getByRole("menuitem", { name: new RegExp(`^.*${label}`) }).first()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(menu).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("textbox", { name: "Descrição" })).toBeVisible();
    await userEvent.keyboard("{Backspace}/tarefa");
    await expect.poll(() => document.querySelectorAll("[role=menuitem]").length).toBe(1);
    await userEvent.keyboard("{Enter}uma tarefa{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(lastDescription(update)).toBe("Texto\n\n- [ ] uma tarefa");
  });

  it.each([
    ["# Título", "# Título"],
    ["- item", "- item"],
    ["1. item", "1. item"],
    ["[[] tarefa", "- [ ] tarefa"],
    ["> citação", "> citação"],
    ["use `código` aqui", "use `código` aqui"],
    ["```\nlinha", "```\nlinha\n```"],
  ])("the markdown shortcut %j works while typing", async (typed, saved) => {
    const { screen, update } = await open("");
    await screen.getByRole("button", { name: "Clique para escrever a descrição." }).click();
    await userEvent.keyboard(typed.replace(/\n/g, "{Enter}") + "{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(lastDescription(update)).toBe(saved);
  });
});

describe("mentions (@)", () => {
  it("lists the tickets of the project without the open one, filters, inserts the key as text and shows it as a mention", async () => {
    const { screen, update } = await open("Ver");
    await screen.getByText("Ver").click();
    await userEvent.keyboard("{Control>}{End}{/Control} @");
    const list = screen.getByRole("listbox", { name: "Mencionar ticket" });
    await expect.element(list).toBeVisible();
    await expect.poll(() => document.querySelectorAll("[role=option]").length).toBe(2);
    await expect.element(list.getByText("ALFA-2")).not.toBeInTheDocument();
    await userEvent.keyboard("vazia");
    await expect.poll(() => document.querySelectorAll("[role=option]").length).toBe(1);
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
    await userEvent.keyboard("agora{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(lastDescription(update)).toBe("Ver ALFA-5 agora");
    await expect.element(screen.getByRole("link", { name: /ALFA-5 Fase vazia/ })).toBeVisible();
  });

  it("clicking a mention in the reading opens that ticket", async () => {
    const { screen, onOpenTicket } = await open("Depende de ALFA-5.");
    await screen.getByRole("link", { name: /ALFA-5 Fase vazia/ }).click();
    expect(onOpenTicket).toHaveBeenCalledWith("t5");
  });
});

describe("tasks while reading", () => {
  it("checking a task saves the new text", async () => {
    const { screen, update } = await open("- [ ] fazer\n- [x] feito");
    await screen.getByRole("checkbox", { name: "Tarefa: fazer" }).click();
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(update).toHaveBeenCalledWith("t2", { description: "- [x] fazer\n- [x] feito" });
  });
});

describe("manual creation", () => {
  it("types the description in the same editor and sends it with the ticket", async () => {
    const { screen, client } = await open("", { ticketId: null, creating: { projectId: "p1", parentId: "t1" } });
    await screen.getByRole("textbox", { name: "Título" }).fill("Escrever o rascunho");
    await screen.getByRole("textbox", { name: "Descrição" }).click();
    await userEvent.keyboard("Primeira versão");
    await screen.getByRole("button", { name: "Criar" }).click();
    await expect.poll(() => (client.createTicket as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(client.createTicket).toHaveBeenCalledWith("p1", { title: "Escrever o rascunho", description: "Primeira versão", parentId: "t1" });
  });
});

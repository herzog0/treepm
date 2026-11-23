import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { ApiClient, ApiResult, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";
import { descriptionEditorMounted, editableFocused } from "../test/stable.js";

// "Pedir ao assistente para escrever" (ADR 0036, fatia 5), em navegador real: o menu "/", o campo do pedido, a espera, a proposta,
// o erro, e o que NÃO pode acontecer (salvar por causa do campo, ou desfazer a edição com o Esc).
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Planejar a fase", { key: "ALFA-1", status: "in_review" }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
];
const detailOf = (id: string, description: string): TicketDetail => ({
  ...summaries.find((entry) => entry.id === id)!, description, mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});

type Draft = ApiClient["draftTicketDescription"];
type DraftResult = ApiResult<{ text: string; model: string }>;
const PROPOSAL = "## Critérios\n\n- [ ] Um\n- [ ] Dois";

async function open(description: string, { assistant = true, draft, role = "admin" }: { assistant?: boolean; draft?: Draft; role?: "admin" | "member" } = {}) {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  const draftTicketDescription = vi.fn<Draft>(draft ?? (async () => ok({ text: PROPOSAL, model: "fake-model" })));
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(id, description))),
    updateTicket: vi.fn(async (id: string, body: { description?: string }) => ok(detailOf(id, body.description ?? description))),
    draftTicketDescription,
  });
  const me = { ...makePanelMe(role, role === "member" ? [{ projectId: "p1", role: "reader" as const }] : []), ...(assistant ? { assistant: { enabled: true } } : {}) };
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(<TicketPage client={client} me={me} projects={[project]} ticketId="t2" creating={null} {...handlers} />);
  await expect.element(screen.getByRole("heading", { level: 1 })).toBeVisible();
  // Antes de o editor montar o clique não edita (RichDescription.tsx): espera por ele em vez de clicar cedo.
  await descriptionEditorMounted();
  const update = client.updateTicket as ReturnType<typeof vi.fn>;
  return { screen, client, draft: draftTicketDescription, update, ...handlers };
}

/** Clica no texto, vai ao fim e abre o menu "/" numa linha nova. */
async function openMenu(screen: Awaited<ReturnType<typeof open>>["screen"], text: string) {
  await screen.getByText(text).click();
  await editableFocused();
  await userEvent.keyboard("{Control>}{End}{/Control}{Enter}/");
  return screen.getByRole("menu", { name: "Blocos" });
}
async function askAssistant(screen: Awaited<ReturnType<typeof open>>["screen"], text: string) {
  await openMenu(screen, text);
  await userEvent.keyboard("assist{Enter}");
  const field = screen.getByRole("textbox", { name: "O que o assistente deve escrever?" });
  await expect.element(field).toHaveFocus();
  return field;
}
const lastDescription = (update: ReturnType<typeof vi.fn>) => (update.mock.calls.at(-1) as [string, { description: string }])[1].description;
const editor = (screen: Awaited<ReturnType<typeof open>>["screen"]) => screen.getByRole("textbox", { name: "Descrição" });

describe("the menu item", () => {
  it("shows 'Pedir ao assistente para escrever' after a separator, below the blocks", async () => {
    const { screen } = await open("Texto");
    const menu = await openMenu(screen, "Texto");
    const item = menu.getByRole("menuitem", { name: /Pedir ao assistente para escrever/ });
    await expect.element(item, { timeout: 10_000 }).toBeVisible();
    const items = Array.from(document.querySelectorAll("[role=menuitem]"));
    expect(items.at(-1)).toBe(item.element());
    expect(item.element().previousElementSibling?.getAttribute("role")).toBe("separator");
  });

  it("is absent when the assistant is off", async () => {
    const { screen } = await open("Texto", { assistant: false });
    await openMenu(screen, "Texto");
    expect(document.body.textContent).not.toContain("Pedir ao assistente para escrever");
    expect(document.querySelector("[role=separator]")).toBeNull();
  });

  it("is absent for someone who cannot edit (there is no editor to open it in)", async () => {
    const { screen } = await open("Texto", { role: "member" });
    await screen.getByText("Texto").click();
    expect(document.querySelector("[role=textbox]")).toBeNull();
    expect(document.body.textContent).not.toContain("Pedir ao assistente para escrever");
  });

  it("choosing it removes the typed '/' and opens a one-line field in place of the menu, focused", async () => {
    const { screen } = await open("Texto");
    const menu = await openMenu(screen, "Texto");
    await menu.getByRole("menuitem", { name: /Pedir ao assistente para escrever/ }).click();
    await expect.element(menu).not.toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "O que o assistente deve escrever?" });
    await expect.element(field).toHaveFocus();
    expect((editor(screen).element().textContent ?? "").includes("/")).toBe(false);
  });
});

describe("the request", () => {
  it("an empty (or blank) request is not sent", async () => {
    const { screen, draft } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("   {Enter}");
    expect(draft).not.toHaveBeenCalled();
  });

  it("Enter sends the request and the CURRENT editor text (unsaved), not the stored one", async () => {
    const { screen, draft, update } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva os critérios{Enter}");
    await expect.poll(() => draft.mock.calls.length).toBe(1);
    const [id, body, options] = draft.mock.calls[0]!;
    expect(id).toBe("t2");
    expect(body).toEqual({ request: "Escreva os critérios", description: "Texto" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(update).not.toHaveBeenCalled();
  });

  it("while waiting the field is locked and says 'Escrevendo…' in a live region; Esc aborts and brings the request back", async () => {
    let signal: AbortSignal | undefined;
    const { screen, update, onClose } = await open("Texto", {
      draft: (_id, _body, options) => new Promise<DraftResult>((resolve) => {
        signal = options?.signal;
        options?.signal?.addEventListener("abort", () => resolve(failed("unavailable")));
      }),
    });
    const field = await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva os critérios{Enter}");
    await expect.element(screen.getByText("Escrevendo…")).toBeVisible();
    expect(document.querySelector("[aria-live]:not(:empty)")?.textContent).toContain("Escrevendo…");
    expect(field.element().hasAttribute("readonly")).toBe(true);
    await userEvent.keyboard("lixo");
    expect((field.element() as HTMLInputElement).value).toBe("Escreva os critérios");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => signal?.aborted).toBe(true);
    await expect.element(screen.getByText("Escrevendo…")).not.toBeInTheDocument();
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect((field.element() as HTMLInputElement).value).toBe("Escreva os critérios");
    expect(field.element().hasAttribute("readonly")).toBe(false);
    await expect.element(field).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("the proposal", () => {
  it("shows the text drawn as markdown, read-only, with Inserir and Descartar", async () => {
    const { screen } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva os critérios{Enter}");
    const proposal = screen.getByRole("region", { name: "Proposta do assistente" });
    await expect.element(proposal).toBeVisible();
    await expect.element(proposal.getByRole("heading", { level: 2, name: "Critérios" })).toBeVisible();
    expect(proposal.element().querySelectorAll('ul[data-type="taskList"] > li')).toHaveLength(2);
    expect(proposal.element().querySelector("[contenteditable=true]")).toBeNull();
    await expect.element(proposal.getByRole("button", { name: "Inserir" })).toBeVisible();
    await expect.element(proposal.getByRole("button", { name: "Descartar" })).toBeVisible();
  });

  it("Inserir puts the blocks where the caret was, closes the proposal and returns the focus to the editor; nothing is saved until the usual way", async () => {
    const { screen, update } = await open("Primeira\n\nÚltima");
    await screen.getByText("Primeira").click();
    await userEvent.keyboard("{End}{Enter}/assist{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "O que o assistente deve escrever?" })).toHaveFocus();
    await userEvent.keyboard("Escreva os critérios{Enter}");
    await screen.getByRole("button", { name: "Inserir" }).click();
    await expect.element(screen.getByRole("region", { name: "Proposta do assistente" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "O que o assistente deve escrever?" })).not.toBeInTheDocument();
    await expect.element(editor(screen)).toHaveFocus();
    const dom = editor(screen).element();
    expect(dom.querySelectorAll("h2")).toHaveLength(1);
    expect(dom.querySelectorAll('ul[data-type="taskList"] > li')).toHaveLength(2);
    expect(update).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    const saved = lastDescription(update);
    expect(saved.indexOf("Primeira")).toBeLessThan(saved.indexOf("## Critérios"));
    expect(saved.indexOf("- [ ] Dois")).toBeLessThan(saved.indexOf("Última"));
    expect(saved).not.toContain("/");
    expect(saved).toBe("Primeira\n\n## Critérios\n\n- [ ] Um\n- [ ] Dois\n\nÚltima");
  });

  it("the insertion follows the text when it changed while the proposal was open", async () => {
    const { screen, update } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva{Enter}");
    await expect.element(screen.getByRole("button", { name: "Inserir" })).toBeVisible();
    // Foco por programa, não por clique: neste quadro a folha do assistente (fixa) cobre a linha do texto, e o clique cairia nela.
    editor(screen).element().focus();
    await userEvent.keyboard("{Control>}{Home}{/Control}Antes ");
    await screen.getByRole("button", { name: "Inserir" }).click();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    const saved = lastDescription(update);
    expect(saved.startsWith("Antes Texto")).toBe(true);
    expect(saved.indexOf("Antes Texto")).toBeLessThan(saved.indexOf("## Critérios"));
  });

  it("Descartar closes without changing the text, returns the focus to the editor and saves nothing", async () => {
    const { screen, update } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva{Enter}");
    await screen.getByRole("button", { name: "Descartar" }).click();
    await expect.element(screen.getByRole("region", { name: "Proposta do assistente" })).not.toBeInTheDocument();
    await expect.element(editor(screen)).toHaveFocus();
    expect(editor(screen).element().querySelector("h2")).toBeNull();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBeLessThanOrEqual(1);
    if (update.mock.calls.length === 1) expect(lastDescription(update).includes("Critérios")).toBe(false);
  });

  it("Esc on the proposal discards it, keeps the edition and does not close the page", async () => {
    const { screen, update, onClose } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva{Enter}");
    await expect.element(screen.getByRole("button", { name: "Inserir" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("region", { name: "Proposta do assistente" })).not.toBeInTheDocument();
    await expect.element(editor(screen)).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("the error", () => {
  it("shows a short message in a live region and 'Tentar de novo', which asks again", async () => {
    let calls = 0;
    const { screen, draft } = await open("Texto", {
      draft: async () => (++calls === 1 ? failed("unavailable", "assistant_unavailable") : ok({ text: PROPOSAL, model: "fake-model" })),
    });
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva{Enter}");
    const alert = screen.getByRole("alert");
    await expect.element(alert).toHaveTextContent("O assistente não está disponível agora.");
    await expect.element(screen.getByRole("region", { name: "Proposta do assistente" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Tentar de novo" }).click();
    await expect.poll(() => draft.mock.calls.length).toBe(2);
    expect(draft.mock.calls[1]![1]).toEqual({ request: "Escreva", description: "Texto" });
    await expect.element(screen.getByRole("button", { name: "Inserir" })).toBeVisible();
  });
});

describe("it is part of the edition", () => {
  it("focusing the field, writing in it and tabbing through the buttons never saves the description", async () => {
    const { screen, update } = await open("Texto");
    const field = await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(update).not.toHaveBeenCalled();
    await expect.element(field).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("button", { name: "Inserir" })).toBeVisible();
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(update).not.toHaveBeenCalled();
    await expect.element(editor(screen)).toBeVisible();
  });

  it("Esc in the field closes only the field: the edition (and what was typed) stays, the page does not close, and the focus goes back to the editor", async () => {
    const { screen, update, onClose } = await open("Texto");
    await screen.getByText("Texto").click();
    await userEvent.keyboard("{Control>}{End}{/Control} digitado{Enter}/assist{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "O que o assistente deve escrever?" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("textbox", { name: "O que o assistente deve escrever?" })).not.toBeInTheDocument();
    await expect.element(editor(screen)).toHaveFocus();
    expect(editor(screen).element().textContent).toContain("Texto digitado");
    expect(onClose).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(lastDescription(update)).toContain("Texto digitado");
  });

  it("clicking outside the whole thing leaves the edition and saves the text the usual way, closing the field", async () => {
    const { screen, update } = await open("Texto");
    await askAssistant(screen, "Texto");
    await userEvent.keyboard("Escreva");
    await screen.getByRole("heading", { level: 1 }).click();
    await expect.element(screen.getByRole("textbox", { name: "O que o assistente deve escrever?" })).not.toBeInTheDocument();
    expect(update.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

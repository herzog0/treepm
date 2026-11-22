import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { ActivityComment, ActivityEntry, ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0040, fatia 2, em navegador real: escrever, enviar (botão e atalho), editar, Esc e o que não pode acontecer sozinho.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }), makeTicket("t2", "p1", 2, "Outro ticket", { key: "ALFA-2" })];
const detail: TicketDetail = { ...summaries[0]!, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
let counter = 0;
const made = (data: Partial<ActivityComment> = {}): ActivityComment => ({
  id: `c${++counter}`, type: "comment", occurredAt: new Date().toISOString(), actor: ana, body: "Texto", editedAt: null, removed: false, canEdit: true, canRemove: true, area: null, ...data,
});

async function open(existing: ActivityEntry[] = [], overrides: Partial<Record<"createTicketComment" | "updateComment", unknown>> = {}) {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async () => ok(detail)),
    ticketActivity: vi.fn(async () => ok({ entries: existing, before: null, canComment: true })),
    createTicketComment: vi.fn(async (_id: string, body: { body: string }) => ok(made({ body: body.body }))),
    updateComment: vi.fn(async (id: string, body: { body: string }) => ok(made({ id, body: body.body, editedAt: new Date().toISOString() }))),
    ...overrides,
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />);
  await expect.element(screen.getByRole("textbox", { name: "Novo comentário" })).toBeVisible();
  return { screen, client: client as ApiClient & Record<"createTicketComment" | "updateComment", ReturnType<typeof vi.fn>>, ...handlers };
}
const bodyOf = (fn: ReturnType<typeof vi.fn>, call = -1) => (fn.mock.calls.at(call) as [string, { body: string }])[1].body;

describe("escrever um comentário", () => {
  it("o botão envia, o campo esvazia e o comentário aparece no fim da lista", async () => {
    const { screen, client } = await open([made({ body: "Já existia" })]);
    await screen.getByRole("textbox", { name: "Novo comentário" }).click();
    await userEvent.keyboard("Primeira **ideia**");
    await screen.getByRole("button", { name: "Comentar" }).click();
    await expect.poll(() => client.createTicketComment.mock.calls.length).toBe(1);
    expect(client.createTicketComment.mock.calls[0]?.[0]).toBe("t1");
    expect(bodyOf(client.createTicketComment)).toBe("Primeira **ideia**");
    const items = [...document.querySelectorAll(".ticket-activity-comment")];
    await expect.poll(() => document.querySelectorAll(".ticket-activity-comment").length).toBe(2);
    expect(items.length).toBeGreaterThan(0);
    const last = [...document.querySelectorAll(".ticket-activity-comment")].at(-1)!;
    expect(last.textContent).toContain("Primeira ideia");
    expect(document.querySelector(".ticket-comment-composer .tiptap")?.textContent).toBe("");
    await expect.element(screen.getByRole("button", { name: "Comentar" })).toBeDisabled();
  });

  it("Ctrl+Enter envia; Enter sozinho quebra a linha e não envia", async () => {
    const { screen, client } = await open();
    await screen.getByRole("textbox", { name: "Novo comentário" }).click();
    await userEvent.keyboard("linha um{Enter}linha dois");
    expect(client.createTicketComment).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => client.createTicketComment.mock.calls.length).toBe(1);
    expect(bodyOf(client.createTicketComment)).toContain("linha um");
    expect(bodyOf(client.createTicketComment)).toContain("linha dois");
    expect(bodyOf(client.createTicketComment).trim().split("\n").length).toBeGreaterThan(1);
  });

  it("Cmd+Enter também envia", async () => {
    const { screen, client } = await open();
    await screen.getByRole("textbox", { name: "Novo comentário" }).click();
    await userEvent.keyboard("pelo atalho do Mac{Meta>}{Enter}{/Meta}");
    await expect.poll(() => client.createTicketComment.mock.calls.length).toBe(1);
    expect(bodyOf(client.createTicketComment)).toBe("pelo atalho do Mac");
  });

  it("erro ao enviar mantém o texto e mostra a mensagem junto do campo", async () => {
    const { screen, client } = await open([], { createTicketComment: vi.fn(async () => failed("unavailable")) });
    await screen.getByRole("textbox", { name: "Novo comentário" }).click();
    await userEvent.keyboard("não pode se perder");
    await screen.getByRole("button", { name: "Comentar" }).click();
    await expect.element(document.querySelector(".ticket-comment-composer [role=alert]") as HTMLElement).toBeVisible();
    expect(document.querySelector(".ticket-comment-composer .tiptap")?.textContent).toBe("não pode se perder");
    expect(document.querySelectorAll(".ticket-activity-comment")).toHaveLength(0);
    expect(client.createTicketComment).toHaveBeenCalledTimes(1);
  });

  it("o rascunho não vai a lugar nenhum sozinho: nada é enviado nem guardado enquanto se digita", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    const { screen, client } = await open();
    await screen.getByRole("textbox", { name: "Novo comentário" }).click();
    await userEvent.keyboard("rascunho");
    await screen.getByRole("heading", { level: 1 }).click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(client.createTicketComment).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("Esc no campo não fecha a página, e o menu «/» não oferece pedir ao assistente", async () => {
    const { screen, onClose } = await open();
    await screen.getByRole("textbox", { name: "Novo comentário" }).click();
    await userEvent.keyboard("/");
    await expect.element(screen.getByRole("menu")).toBeVisible();
    expect(document.querySelector("[role=menu]")?.textContent).not.toMatch(/assistente/i);
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("editar um comentário", () => {
  it("Editar abre o corpo no editor; Salvar grava o texto novo e passa a mostrar «editado»", async () => {
    const { screen, client } = await open([made({ id: "c-edit", body: "Texto original" })]);
    await screen.getByRole("button", { name: "Editar" }).click();
    const field = screen.getByRole("textbox", { name: "Editar comentário" });
    await expect.element(field).toHaveFocus();
    await expect.element(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    await userEvent.keyboard("{Control>}{End}{/Control} e mais");
    await screen.getByRole("button", { name: "Salvar" }).click();
    await expect.poll(() => client.updateComment.mock.calls.length).toBe(1);
    expect(client.updateComment).toHaveBeenCalledWith("c-edit", { body: "Texto original e mais" });
    await expect.element(screen.getByText("editado")).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "Editar comentário" })).not.toBeInTheDocument();
  });

  it("Esc cancela a edição sem chamar a API e sem fechar a página", async () => {
    const { screen, client, onClose } = await open([made({ body: "Intacto" })]);
    await screen.getByRole("button", { name: "Editar" }).click();
    await expect.element(screen.getByRole("textbox", { name: "Editar comentário" })).toHaveFocus();
    await userEvent.keyboard(" mudou{Escape}");
    await expect.element(screen.getByRole("textbox", { name: "Editar comentário" })).not.toBeInTheDocument();
    expect(client.updateComment).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".ticket-activity-comment")?.textContent).toContain("Intacto");
  });

  it("Cancelar volta à leitura", async () => {
    const { screen, client } = await open([made({ body: "Intacto" })]);
    await screen.getByRole("button", { name: "Editar" }).click();
    await screen.getByRole("button", { name: "Cancelar" }).click();
    await expect.element(screen.getByRole("textbox", { name: "Editar comentário" })).not.toBeInTheDocument();
    expect(client.updateComment).not.toHaveBeenCalled();
  });
});

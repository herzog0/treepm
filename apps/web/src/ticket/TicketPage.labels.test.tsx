import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Label, TicketSummary } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import type { FakeLabelStep } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0065: o campo "Etiquetas" da página do ticket (pastilhas, seletor com busca e criação, permissões e erros).
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const bug: Label = { id: "l-bug", name: "Bug", color: "rose" };
const debt: Label = { id: "l-debt", name: "Dívida técnica", color: "brown" };
const client1: Label = { id: "l-cli", name: "Cliente X", color: "cyan" };

function setup(options: { role?: "admin" | "reader"; labels?: Label[]; projectLabels?: Label[]; script?: FakeLabelStep[] } = {}) {
  const tickets: TicketSummary[] = [makeTicket("t1", "p1", 1, "Revisar", { key: "ALFA-1", labels: options.labels ?? [bug] })];
  const client = makeTreeClient({ projects: [project], tickets: { p1: tickets }, labels: { p1: options.projectLabels ?? [bug, client1, debt] }, labelScript: options.script ?? [] });
  const me = options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin");
  const noop = vi.fn();
  render(<TicketPage client={client as ApiClient} me={me} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />);
  return { client };
}
const row = async () => (await screen.findByText("Etiquetas", { selector: "dt" })).closest(".ticket-row") as HTMLElement;
const pills = (where: HTMLElement) => [...where.querySelectorAll(".ticket-labels-row .label-pill-name")].map((pill) => pill.textContent);

describe("campo Etiquetas (ADR 0065)", () => {
  it("vem depois de Prazo e mostra as etiquetas como pastilhas com cor e nome", async () => {
    setup({ labels: [bug, debt] });
    const labels = await row();
    const terms = [...document.querySelectorAll(".ticket-fields dt")].map((dt) => dt.textContent);
    expect(terms.indexOf("Etiquetas")).toBe(terms.indexOf("Prazo") + 1);
    expect(pills(labels)).toEqual(["Bug", "Dívida técnica"]);
    expect(labels.querySelector(".label-pill[data-color='rose']")?.getAttribute("title")).toBe("Bug");
  });

  it("quem só lê vê as pastilhas, sem tirar nem adicionar", async () => {
    setup({ role: "reader" });
    const labels = await row();
    expect(pills(labels)).toEqual(["Bug"]);
    expect(within(labels).queryByRole("button")).toBeNull();
  });

  it("quem só lê, sem etiquetas, vê o texto de vazio", async () => {
    setup({ role: "reader", labels: [] });
    expect(within(await row()).getByText("Sem etiquetas")).toBeTruthy();
  });

  it("tira pelo botão com nome acessível e grava uma vez", async () => {
    const { client } = setup();
    const labels = await row();
    await userEvent.click(within(labels).getByRole("button", { name: "Tirar etiqueta Bug" }));
    await waitFor(() => expect(pills(labels)).toEqual([]));
    expect(client.changeTicketLabels).toHaveBeenCalledTimes(1);
    expect(client.changeTicketLabels).toHaveBeenCalledWith("t1", { remove: ["l-bug"] });
  });

  it("o seletor busca nas etiquetas do projeto, marca as que o ticket já tem e não grava a cada tecla", async () => {
    const { client } = setup();
    const labels = await row();
    await userEvent.click(within(labels).getByRole("button", { name: "Adicionar etiqueta" }));
    const input = within(labels).getByRole("combobox");
    await waitFor(() => expect(within(labels).getAllByRole("option").map((option) => option.textContent)).toEqual(["Bug", "Cliente X", "Dívida técnica"]));
    expect(within(labels).getByRole("option", { name: "Bug" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.type(input, "cli");
    expect(within(labels).getAllByRole("option").map((option) => option.textContent)).toEqual(["Cliente X", "Criar «cli»"]);
    expect(client.changeTicketLabels).not.toHaveBeenCalled();
    await userEvent.click(within(labels).getByRole("option", { name: "Cliente X" }));
    await waitFor(() => expect(pills(labels)).toEqual(["Bug", "Cliente X"]));
    expect(client.changeTicketLabels).toHaveBeenCalledTimes(1);
    expect(client.changeTicketLabels).toHaveBeenCalledWith("t1", { add: [{ labelId: "l-cli" }] });
  });

  it("só oferece criar quando nenhuma etiqueta do projeto tem a mesma chave (maiúsculas e espaços não contam)", async () => {
    setup();
    const labels = await row();
    await userEvent.click(within(labels).getByRole("button", { name: "Adicionar etiqueta" }));
    await userEvent.type(within(labels).getByRole("combobox"), "  BUG ");
    await waitFor(() => expect(within(labels).getAllByRole("option").map((option) => option.textContent)).toEqual(["Bug"]));
  });

  it("cria pelo nome digitado com Enter e a pastilha nova aparece", async () => {
    const { client } = setup();
    const labels = await row();
    await userEvent.click(within(labels).getByRole("button", { name: "Adicionar etiqueta" }));
    await userEvent.type(within(labels).getByRole("combobox"), "Urgente{Enter}");
    await waitFor(() => expect(pills(labels)).toEqual(["Bug", "Urgente"]));
    expect(client.changeTicketLabels).toHaveBeenCalledWith("t1", { add: [{ name: "Urgente" }] });
  });

  it.each([
    ["label_limit_ticket", "Um ticket pode ter no máximo 20 etiquetas. Tire uma antes de pôr outra."],
    ["label_limit_project", "O projeto já tem 200 etiquetas, o máximo. Apague uma nas configurações do projeto antes de criar outra."],
  ])("erro %s: volta ao estado anterior e mostra a frase", async (code, text) => {
    setup({ script: [{ error: ["conflict", code] }] });
    const labels = await row();
    await userEvent.click(within(labels).getByRole("button", { name: "Adicionar etiqueta" }));
    await userEvent.type(within(labels).getByRole("combobox"), "Novo{Enter}");
    expect((await within(labels).findByRole("alert")).textContent).toBe(text);
    expect(pills(labels)).toEqual(["Bug"]);
  });

  it("erro genérico: volta ao estado anterior com a mensagem do tipo", async () => {
    setup({ script: [{ error: ["unavailable"] }] });
    const labels = await row();
    await userEvent.click(within(labels).getByRole("button", { name: "Tirar etiqueta Bug" }));
    expect((await within(labels).findByRole("alert")).textContent).not.toBe("");
    expect(pills(labels)).toEqual(["Bug"]);
  });
});

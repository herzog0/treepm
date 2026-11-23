import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ApiClient, TicketSummary } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { failed, makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0047: a linha "Prioridade" da página do ticket, a prioridade dos filhos e a frase do histórico.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Ramo prioritário", { key: "ALFA-1", priority: 5 }),
  makeTicket("t2", "p1", 2, "Filho herdeiro", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("t3", "p1", 3, "Filho com a sua", { key: "ALFA-3", parentId: "t1", priority: -2 }),
  makeTicket("t4", "p1", 4, "Solto", { key: "ALFA-4" }),
];

function setup(options: { role?: "admin" | "reader"; ticketId?: string; entries?: ActivityEntry[] } = {}) {
  const client = makeTreeClient({ projects: [project], tickets: { p1: tickets } });
  if (options.entries) {
    Object.assign(client, { ticketActivity: vi.fn(async () => ok({ entries: options.entries!, before: null, canComment: false })) });
  }
  const me = options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin");
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={me} projects={[project]} ticketId={options.ticketId ?? "t4"} creating={null} {...handlers} />);
  return { client, ...handlers };
}
const row = async () => (await screen.findByText("Prioridade", { selector: "dt" })).closest(".ticket-row") as HTMLElement;

describe("linha Prioridade da página do ticket", () => {
  it("mostra o número e os botões de menos e mais; mais grava priority +1", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const r = await row();
    expect(within(r).getByRole("spinbutton", { name: "Prioridade" })).toHaveValue(0);
    await user.click(within(r).getByRole("button", { name: "Aumentar a prioridade" }));
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t4", { priority: 1 }));
    await waitFor(() => expect(within(r).getByRole("spinbutton", { name: "Prioridade" })).toHaveValue(1));
  });

  it("menos desce (aceita negativo) e os limites desabilitam os botões", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const r = await row();
    await user.click(within(r).getByRole("button", { name: "Diminuir a prioridade" }));
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t4", { priority: -1 }));
  });

  it("botão de mais desabilitado em 999 e de menos em -999", async () => {
    setup({ ticketId: "t4" });
    const r = await row();
    const input = within(r).getByRole("spinbutton", { name: "Prioridade" });
    expect(input).toHaveAttribute("min", "-999");
    expect(input).toHaveAttribute("max", "999");
  });

  it("digitar e Enter grava; Esc desfaz", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const r = await row();
    const input = within(r).getByRole("spinbutton", { name: "Prioridade" });
    await user.clear(input);
    await user.type(input, "42{Enter}");
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t4", { priority: 42 }));
    await user.clear(input);
    await user.type(input, "7");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue(42);
    expect(client.updateTicket).toHaveBeenCalledTimes(1);
  });

  it("valida antes de mandar: fracionário, fora do intervalo e vazio não chamam a API e mostram o erro", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const r = await row();
    const input = within(r).getByRole("spinbutton", { name: "Prioridade" });
    for (const bad of ["1000", "-1000", "1.5"]) {
      await user.clear(input);
      await user.type(input, `${bad}{Enter}`);
      expect(await within(r).findByRole("alert")).toHaveTextContent("inteiro de -999 a 999");
    }
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(await within(r).findByRole("alert")).toBeInTheDocument();
    expect(client.updateTicket).not.toHaveBeenCalled();
  });

  it("erro da API aparece pelo mecanismo da página e o número volta ao que estava", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    Object.assign(client, { updateTicket: vi.fn(async () => failed("unavailable")) });
    const r = await row();
    await user.click(within(r).getByRole("button", { name: "Aumentar a prioridade" }));
    expect(await within(r).findByRole("alert")).toBeInTheDocument();
    expect(within(r).getByRole("spinbutton", { name: "Prioridade" })).toHaveValue(0);
  });

  it("quem só lê vê o número, sem controles", async () => {
    setup({ role: "reader", ticketId: "t1" });
    const r = await row();
    expect(within(r).queryByRole("button")).toBeNull();
    expect(within(r).queryByRole("spinbutton")).toBeNull();
    expect(r).toHaveTextContent("5");
  });

  it("herdada: 0 · vale 5, de ALFA-1, com a chave como link que abre o ticket", async () => {
    const user = userEvent.setup();
    const { onOpenTicket } = setup({ ticketId: "t2" });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("vale 5, de"));
    await user.click(within(r).getByRole("button", { name: "ALFA-1" }));
    expect(onOpenTicket).toHaveBeenCalledWith("t1");
  });

  it("própria diferente de 0 não mostra a frase de herança", async () => {
    setup({ ticketId: "t3" });
    const r = await row();
    expect(within(r).getByRole("spinbutton", { name: "Prioridade" })).toHaveValue(-2);
    expect(r).not.toHaveTextContent("vale");
  });
});

describe("lista de filhos", () => {
  it("mostra a prioridade própria quando diferente de 0, com nome acessível, e a ordem não muda", async () => {
    setup({ ticketId: "t1" });
    const list = await screen.findByRole("list", { name: "Itens" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("ALFA-2");
    expect(items[1]).toHaveTextContent("ALFA-3");
    expect(within(items[0]!).queryByLabelText(/^Prioridade/)).toBeNull();
    expect(within(items[1]!).getByLabelText("Prioridade -2")).toBeInTheDocument();
  });
});

describe("histórico", () => {
  const entry = { id: "e1", type: "priority_changed", occurredAt: new Date().toISOString(), actor: { id: "person-1", displayName: "Ana", avatarUrl: null }, from: 0, to: 5 } as ActivityEntry;
  it("diz que mudou a prioridade de 0 para 5, nos três idiomas", async () => {
    setup({ entries: [entry] });
    expect(await screen.findByText(/mudou a prioridade de/)).toHaveTextContent("Ana mudou a prioridade de 0 para 5");
  });
  it("em inglês", async () => {
    await setTestLanguage("en");
    setup({ entries: [entry] });
    expect(await screen.findByText(/changed the priority from/)).toHaveTextContent("Ana changed the priority from 0 to 5");
    await setTestLanguage("pt-BR");
  });
  it("em espanhol", async () => {
    await setTestLanguage("es-MX");
    setup({ entries: [entry] });
    expect(await screen.findByText(/cambió la prioridad de/)).toHaveTextContent("Ana cambió la prioridad de 0 a 5");
    await setTestLanguage("pt-BR");
  });
});

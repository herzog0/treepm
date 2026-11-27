import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketSummary } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0069, seção 3: o lugar na fila de um "a fazer" tem a mesma cor na página do ticket que no mapa, e vem escrito.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Pode começar", { key: "ALFA-1", status: "todo", place: "free" }),
  makeTicket("t2", "p1", 2, "Na fila", { key: "ALFA-2", status: "todo", place: "waiting" }),
  makeTicket("t3", "p1", 3, "Fazendo", { key: "ALFA-3", status: "in_progress", place: "free" }),
];

function setup(ticketId: string) {
  const client = makeTreeClient({ projects: [project], tickets: { p1: tickets } });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId={ticketId} creating={null} {...handlers} />);
}
const row = async () => (await screen.findByText("Situação", { selector: "dt" })).closest(".ticket-row") as HTMLElement;

describe("linha Situação com o lugar na fila", () => {
  it("escreve o lugar e pinta o marcador com a cor dele", async () => {
    setup("t1");
    const r = await row();
    expect(within(r).getByText("Livre")).toBeInTheDocument();
    expect(r.querySelector(".status-mark")).toHaveAttribute("data-place", "free");
  });

  it("o botão do menu de situação continua com o nome da situação: o lugar fica fora dele", async () => {
    setup("t1");
    expect(await screen.findByRole("button", { name: "A fazer" })).toBeInTheDocument();
  });

  it("vale para esperando também", async () => {
    setup("t2");
    expect(within(await row()).getByText("Esperando")).toBeInTheDocument();
  });

  it("não escreve nada fora de 'a fazer'", async () => {
    setup("t3");
    const r = await row();
    expect(within(r).queryByText("Livre")).not.toBeInTheDocument();
    expect(r.querySelector(".status-mark")).not.toHaveAttribute("data-place");
  });
});

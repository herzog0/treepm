import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketSummary } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0051: o ticket bloqueado mostra "Bloqueado" por escrito na linha de situação, além do marcador vermelho.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Travado", { key: "ALFA-1", status: "in_progress", blocked: true }),
  makeTicket("t2", "p1", 2, "Livre", { key: "ALFA-2", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Pronto", { key: "ALFA-3", status: "done", blocked: true }),
];

function setup(ticketId: string, role: "admin" | "reader") {
  const client = makeTreeClient({ projects: [project], tickets: { p1: tickets } });
  const me = role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin");
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={me} projects={[project]} ticketId={ticketId} creating={null} {...handlers} />);
}
const row = async () => (await screen.findByText("Situação", { selector: "dt" })).closest(".ticket-row") as HTMLElement;

describe("linha Situação de um ticket bloqueado", () => {
  it.each(["admin", "reader"] as const)("escreve Bloqueado e pinta o marcador de vermelho (%s)", async (role) => {
    setup("t1", role);
    const r = await row();
    expect(within(r).getByText("Bloqueado")).toBeInTheDocument();
    expect(within(r).getByText(/Em andamento/)).toBeInTheDocument();
    expect(r.querySelector(".status-mark")).toHaveAttribute("data-blocked", "true");
  });

  it("não escreve nada num ticket livre nem num concluído que tem a marca", async () => {
    setup("t2", "admin");
    expect(within(await row()).queryByText("Bloqueado")).not.toBeInTheDocument();
  });

  it("concluído não é bloqueado, mesmo com blocked no resumo", async () => {
    setup("t3", "reader");
    const r = await row();
    expect(within(r).queryByText("Bloqueado")).not.toBeInTheDocument();
    expect(r.querySelector(".status-mark")).not.toHaveAttribute("data-blocked");
  });
});

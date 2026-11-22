import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0037, fatia 3, em navegador real: o foco e o teclado do seletor de "Depende de".
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Banco de dados", { key: "ALFA-2" }),
  makeTicket("t3", "p1", 3, "Autenticação", { key: "ALFA-3" }),
];
const detail: TicketDetail = {
  ...summaries[0]!, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
};

async function open(add: ApiClient["addTicketDependency"]) {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  Object.assign(client, { getTicket: vi.fn(async () => ok(detail)), addTicketDependency: vi.fn(add) });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(<TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />);
  await expect.element(screen.getByRole("heading", { level: 1 })).toBeVisible();
  await screen.getByRole("button", { name: "Adicionar dependência" }).click();
  return { screen, client, ...handlers };
}

describe("seletor de “Depende de” no navegador", () => {
  it("o foco vai à busca ao abrir; setas e Enter escolhem sem o mouse", async () => {
    const { screen, client } = await open(async () => ok(detail));
    await expect.element(screen.getByRole("textbox", { name: "Buscar ticket" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect.element(screen.getByRole("button", { name: /ALFA-3/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(client.addTicketDependency).toHaveBeenCalledWith("t1", "t3");
  });

  it("Esc fecha só o seletor, devolve o foco a “Adicionar” e não fecha a página", async () => {
    const { screen, onClose } = await open(async () => ok(detail));
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("group", { name: "Escolha o ticket de que este depende" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Adicionar dependência" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("o erro de ciclo aparece na linha e o seletor continua aberto", async () => {
    const { screen } = await open(async () => failed("conflict", "dependency_cycle"));
    await screen.getByRole("button", { name: /ALFA-2/ }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Isso fecharia um ciclo: “ALFA-2” já depende deste ticket");
    await expect.element(screen.getByRole("group", { name: "Escolha o ticket de que este depende" })).toBeVisible();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Reabertura (ADR 0034): a API reabre o ticket concluído que ganha filho aberto, e sobe; a tela mostra sem recarregar a página.
const SLOW = 8000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa")];
const tickets = () => ({
  p1: [
    makeTicket("d1", "p1", 1, "Avô concluído", { key: "ALFA-1", status: "done" }),
    makeTicket("d2", "p1", 2, "Pai concluído", { key: "ALFA-2", parentId: "d1", status: "done" }),
    makeTicket("d3", "p1", 3, "Filho concluído", { key: "ALFA-3", parentId: "d2", status: "done" }),
    makeTicket("s1", "p1", 4, "Solto aberto", { key: "ALFA-4" }),
  ],
});
const client = (): ApiClient => makeTreeClient({ projects, people: [makePerson("person-1", "Ana")], tickets: tickets() });

function Host({ client, initial }: { client: ApiClient; initial: string }) {
  const [open, setOpen] = useState<string | null>(initial);
  return <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />;
}
async function select(name: RegExp) {
  const node = await screen.findByRole("button", { name }, { timeout: SLOW });
  await waitFor(() => expect(node).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
  await userEvent.click(node);
}
const page = () => screen.getByRole("complementary", { name: "Página do ticket" });
const card = () => screen.getByRole("complementary", { name: "Nó selecionado" });
const heading = async (name: string) => screen.findByRole("heading", { level: 1, name }, { timeout: SLOW });
const pressed = (name: string) => within(within(page()).getByRole("group", { name: "Situação" }) ).getByRole("button", { name });

describe("reopening of a concluded parent, on the screen", () => {
  it("creating a ticket from the page of a concluded parent leaves the parent at 'A fazer', without reloading the page", async () => {
    render(<Host client={client()} initial="d3" />);
    await heading("Filho concluído");
    await userEvent.click(within(page()).getByRole("button", { name: "Novo ticket aqui dentro" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Título" }), "Mais um");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    await heading("Mais um");
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-3Filho concluído/ }));
    await heading("Filho concluído");
    await waitFor(() => expect(pressed("A fazer")).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-2Pai concluído/ }));
    await heading("Pai concluído");
    await waitFor(() => expect(pressed("A fazer")).toHaveAttribute("aria-pressed", "true"));
  }, 15000);

  it("moving an open ticket inside a concluded one turns the parent card on the map into the progress card", async () => {
    render(<Host client={client()} initial="s1" />);
    await heading("Solto aberto");
    await select(/ALFA-1 · Avô concluído/);
    expect(within(card()).getByText("Concluído")).toBeInTheDocument();
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Escolher o ticket pai" })).getByRole("button", { name: /ALFA-1Avô concluído/ }));
    await waitFor(() => expect(within(card()).getByText(/\d de \d concluídos/)).toBeInTheDocument(), { timeout: SLOW });
    expect(within(card()).getByText("2 de 3 concluídos")).toBeInTheDocument();
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-1Avô concluído/ }));
    await heading("Avô concluído");
    await waitFor(() => expect(pressed("A fazer")).toHaveAttribute("aria-pressed", "true"));
  }, 15000);

  it("reopening a child reopens the grandparent too", async () => {
    render(<Host client={client()} initial="d3" />);
    await heading("Filho concluído");
    await userEvent.click(within(page()).getByRole("button", { name: "Em andamento" }));
    await waitFor(() => expect(pressed("Em andamento")).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-2Pai concluído/ }));
    await heading("Pai concluído");
    await waitFor(() => expect(pressed("A fazer")).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-1Avô concluído/ }));
    await heading("Avô concluído");
    await waitFor(() => expect(pressed("A fazer")).toHaveAttribute("aria-pressed", "true"));
  }, 15000);
});

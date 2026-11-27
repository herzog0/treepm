import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Reabertura (ADR 0034): a API reabre o ticket concluído que ganha filho aberto, e sobe; a tela mostra sem recarregar a página.
// Prazo dos testes que montam o mapa inteiro: 2-4 s com a máquina em uso normal, e mais de 8 s com ela saturada (TREEPM-101).
const SLOW = 20_000;
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
const page = () => screen.getByRole("complementary", { name: "Página do ticket" });
// O card do avô no mapa (o clique nele abriria o ticket, então o teste só o lê).
const card = () => screen.getByRole("button", { name: /ALFA-1 · Avô concluído/ });
const heading = async (name: string) => screen.findByRole("heading", { level: 1, name }, { timeout: SLOW });
// A situação é a linha "Situação": o botão que abre o menu mostra a atual.
const statusRow = () => within(page()).getByText("Situação").closest("div")!;
const currentStatus = (name: string) => within(statusRow()).getByRole("button", { name });

/** A situação calculada a partir dos itens (ADR 0068): o valor e a linha que diz de onde vem, sem menu. */
const derivedStatus = (name: string) => {
  expect(statusRow()).toHaveTextContent(name);
  expect(within(statusRow()).getByText("Calculada a partir dos itens.")).toBeInTheDocument();
  expect(within(statusRow()).queryByRole("button")).not.toBeInTheDocument();
};

describe("a concluded parent follows its children, on the screen (ADR 0068)", () => {
  it("creating a ticket from the page of a concluded parent leaves the parent at 'A fazer', without reloading the page", async () => {
    render(<Host client={client()} initial="d3" />);
    await heading("Filho concluído");
    await userEvent.click(within(page()).getByRole("button", { name: "Novo ticket aqui dentro" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Título" }), "Mais um");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    await heading("Mais um");
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-3Filho concluído/ }));
    await heading("Filho concluído");
    await waitFor(() => derivedStatus("A fazer"));
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-2Pai concluído/ }));
    await heading("Pai concluído");
    await waitFor(() => derivedStatus("A fazer"));
  }, 15000);

  it("moving an open ticket inside a concluded one turns the parent card on the map into the progress card", async () => {
    render(<Host client={client()} initial="s1" />);
    await heading("Solto aberto");
    await screen.findByRole("button", { name: /ALFA-1 · Avô concluído/ }, { timeout: SLOW });
    // O card do pai traz a situação e os três números (ADR 0069).
    await waitFor(() => expect(within(card()).getByText("Concluído · 2 tickets · 2 prontos · 0 livres")).toBeInTheDocument(), { timeout: SLOW });
    await userEvent.click(within(page()).getByRole("button", { name: "Mudar" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Escolher o ticket pai" })).getByRole("button", { name: /ALFA-1Avô concluído/ }));
    await waitFor(() => expect(within(card()).getByText("3 tickets · 2 prontos · 1 livre")).toBeInTheDocument(), { timeout: SLOW });
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-1Avô concluído/ }));
    await heading("Avô concluído");
    await waitFor(() => derivedStatus("Em andamento"));
  }, 15000);

  it("starting a child again moves the parent and the grandparent to 'Em andamento'", async () => {
    render(<Host client={client()} initial="d3" />);
    await heading("Filho concluído");
    await userEvent.click(currentStatus("Concluído"));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Em andamento" }));
    await waitFor(() => expect(currentStatus("Em andamento")).toHaveAttribute("aria-haspopup", "menu"));
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-2Pai concluído/ }));
    await heading("Pai concluído");
    await waitFor(() => derivedStatus("Em andamento"));
    await userEvent.click(within(page()).getByRole("button", { name: /ALFA-1Avô concluído/ }));
    await heading("Avô concluído");
    await waitFor(() => derivedStatus("Em andamento"));
  }, 15000);
});

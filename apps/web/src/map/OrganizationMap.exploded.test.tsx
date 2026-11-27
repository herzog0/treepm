import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAYOUT_STORAGE_KEY } from "../exploded/viewChoice.js";
import { makePanelMe } from "../panel/testing.js";
import { dependencyProject, dependencyTicketId, dependencyTickets } from "../test/dependencyMap.js";
import { makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// ADR 0070, seção 1: um controle na tela troca entre o mapa e a árvore explodida; o mapa é a visão inicial.
afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function setup() {
  const onOpenTicketChange = vi.fn();
  const client = makeTreeClient({ projects: [dependencyProject], tickets: { loja: dependencyTickets() }, people: [] });
  render(<OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={null} onOpenTicketChange={onOpenTicketChange} />);
  return { onOpenTicketChange };
}
const switcher = async () => within(await screen.findByRole("group", { name: "Visão do projeto" }));

describe("a troca entre o mapa e a árvore explodida", () => {
  it("começa no mapa; a árvore explodida mostra o projeto, guarda a escolha e volta ao mapa", async () => {
    setup();
    const group = await switcher();
    expect(group.getByRole("button", { name: "Mapa" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "Árvore explodida do projeto" })).toBeNull();

    await userEvent.click(group.getByRole("button", { name: "Árvore explodida" }));
    const tree = await screen.findByRole("region", { name: "Árvore explodida do projeto" });
    expect(within(tree).getByRole("button", { name: /Casca do checkout/ })).toBeInTheDocument();
    expect(group.getByRole("button", { name: "Árvore explodida" })).toHaveAttribute("aria-pressed", "true");
    expect(window.location.search).toBe("?layout=tree");
    expect(window.localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe("tree");

    await userEvent.click(group.getByRole("button", { name: "Mapa" }));
    expect(screen.queryByRole("region", { name: "Árvore explodida do projeto" })).toBeNull();
  });

  it("o clique num card da árvore abre o ticket, como no mapa", async () => {
    window.history.replaceState(null, "", "/?layout=tree");
    const { onOpenTicketChange } = setup();
    const tree = await screen.findByRole("region", { name: "Árvore explodida do projeto" });
    await userEvent.click(within(tree).getByRole("button", { name: /Pagamento/ }));
    expect(onOpenTicketChange).toHaveBeenCalledWith(dependencyTicketId("Pagamento"));
  });

  it("o atalho do mapa vale na árvore: Esc tira a seleção", async () => {
    window.history.replaceState(null, "", "/?layout=tree");
    setup();
    const tree = await screen.findByRole("region", { name: "Árvore explodida do projeto" });
    const card = within(tree).getByRole("button", { name: /Carrinho/ });
    await userEvent.click(card);
    expect(within(tree).getByRole("button", { name: /Carrinho/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.keyboard("{Escape}");
    expect(within(tree).getByRole("button", { name: /Carrinho/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("ver só o pai do ticket selecionado leva o foco para ele; o caminho volta ao projeto", async () => {
    window.history.replaceState(null, "", "/?layout=tree");
    setup();
    const tree = await screen.findByRole("region", { name: "Árvore explodida do projeto" });
    // A primeira vista é de perto; o ⌂ mostra a árvore inteira.
    await userEvent.click(screen.getByRole("button", { name: "Ver a árvore inteira" }));
    await waitFor(() => expect(within(tree).getByRole("button", { name: /Etiquetas/ })).toBeInTheDocument());
    await userEvent.click(within(tree).getByRole("button", { name: /Carrinho/ }));
    await userEvent.click(screen.getByRole("button", { name: "Ver só Checkout" }));
    const narrowed = await screen.findByRole("region", { name: "Árvore explodida do projeto" });
    expect(within(narrowed).queryByRole("button", { name: /Etiquetas/ })).toBeNull();
    expect(within(narrowed).getByRole("button", { name: /Termos de uso/ })).toHaveAccessibleName(/Fora do foco/);
    const path = within(screen.getByRole("navigation", { name: "Foco da árvore" }));
    expect(path.getByRole("button", { name: "Checkout" })).toHaveAttribute("aria-current", "location");
    await userEvent.click(path.getByRole("button", { name: "Loja" }));
    await userEvent.click(screen.getByRole("button", { name: "Ver a árvore inteira" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Árvore explodida do projeto" })).getByRole("button", { name: /Etiquetas/ })).toBeInTheDocument());
  });
});

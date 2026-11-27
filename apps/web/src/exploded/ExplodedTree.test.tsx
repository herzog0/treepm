import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildMapItems } from "../map/items.js";
import type { MapNode } from "../map/items.js";
import { dependencyProject, dependencyTicketId, dependencyTickets } from "../test/dependencyMap.js";
import { makeTicket } from "../test/fakes.js";
import { ExplodedTree } from "./ExplodedTree.js";
import type { ExplodedTreeProps } from "./ExplodedTree.js";

// ADR 0070: a árvore explodida mostra os mesmos cards do mapa, uma seta por ticket, e todas as dependências do selecionado.
const org = { orgId: "org", name: "Org", slug: "org" };
const tickets = dependencyTickets();
const nodes = new Map(buildMapItems(org, [dependencyProject], { loja: tickets }).map((node) => [node.id, node] as const)) as ReadonlyMap<string, MapNode>;
const id = dependencyTicketId;

function setup(extra: Partial<ExplodedTreeProps> = {}) {
  const props: ExplodedTreeProps = {
    tickets,
    nodes,
    focus: { projectId: "loja", ticketId: id("Checkout") },
    selectedId: null,
    filled: false,
    onSelect: vi.fn(),
    onClearSelection: vi.fn(),
    onToggleColors: vi.fn(),
    focusPath: [
      { id: "loja", label: "Loja" },
      { id: id("Checkout"), label: "Checkout" },
    ],
    narrowTo: null,
    onFocus: vi.fn(),
    ...extra,
  };
  const view = render(<ExplodedTree {...props} />);
  return { ...view, props };
}
const card = (title: RegExp) => screen.getByRole("button", { name: title });

describe("ExplodedTree", () => {
  it("mostra os tickets sem filhos do foco com o texto do mapa e o pai direto em texto pequeno", () => {
    setup();
    const casca = card(/Casca do checkout/);
    expect(casca).toHaveTextContent("Livre");
    expect(casca).toHaveTextContent("Abre os irmãos");
    expect(within(casca).getByText("Checkout")).toHaveClass("exploded-card-parent");
    expect(card(/Pagamento/)).toHaveTextContent("Esperando");
    expect(screen.queryByRole("button", { name: /LOJA-1 · Checkout/ })).toBeNull();
  });

  it("a dependência que aponta para fora do foco vira um card apagado", () => {
    setup();
    const outside = card(/Termos de uso/);
    expect(outside).toHaveAttribute("data-outside", "true");
    expect(outside).toHaveAccessibleName(/Fora do foco/);
  });

  it("um ticket com filhos dentro do foco também vira card apagado, mas não está fora do foco", () => {
    const own = [
      makeTicket("pai", "loja", 1, "Fundação", { key: "LOJA-1", progress: { done: 0, total: 1, excluded: 0 } }),
      makeTicket("f", "loja", 2, "Base", { key: "LOJA-2", parentId: "pai" }),
      makeTicket("x", "loja", 3, "Depois da fundação", { key: "LOJA-3", dependencies: [{ id: "pai", need: "start" }] }),
    ];
    const ownNodes = new Map(buildMapItems(org, [dependencyProject], { loja: own }).map((node) => [node.id, node] as const));
    setup({ tickets: own, nodes: ownNodes, focus: { projectId: "loja", ticketId: null } });
    const parent = card(/Fundação/);
    expect(parent).toHaveAttribute("data-outside", "true");
    expect(parent).toHaveAccessibleName(/Ticket com filhos/);
    expect(parent).not.toHaveAccessibleName(/Fora do foco/);
  });

  it("uma seta por ticket que pendura em outro", () => {
    const { container } = setup();
    // Carrinho e Cupom penduram na Casca; Pagamento no Carrinho; Resumo no Pagamento.
    expect(container.querySelectorAll(".exploded-hang")).toHaveLength(4);
  });

  it("o clique abre o ticket, como no mapa", async () => {
    const { props } = setup();
    await userEvent.click(card(/Carrinho/));
    expect(props.onSelect).toHaveBeenCalledWith(id("Carrinho"));
  });

  it("selecionar mostra todas as dependências dele, com as cores e o tracejado da ADR 0069", () => {
    const { container } = setup({ selectedId: id("Pagamento") });
    const lines = [...container.querySelectorAll<SVGLineElement>(".map-arrows line")];
    // Espera o Carrinho; libera o Resumo e a Acessibilidade (para entregar). Endereços está fora do foco: sem card, sem seta.
    expect(lines.map((line) => `${line.dataset.kind}:${line.dataset.need}`).sort()).toEqual(["unlocks:deliver", "unlocks:start", "waits:start"]);
    expect(card(/Pagamento/)).toHaveAttribute("aria-pressed", "true");
  });

  it("sem seleção, nenhuma seta de seleção", () => {
    const { container } = setup();
    expect(container.querySelector(".map-arrows")).toBeNull();
  });

  it("foco sem tickets: diz que não há o que mostrar", () => {
    setup({ focus: { projectId: "loja", ticketId: id("Casca do checkout") } });
    expect(screen.getByText("Nada para mostrar: este foco não tem tickets sem filhos.")).toBeInTheDocument();
  });

  it("tem os controles de zoom e de cores do mapa", async () => {
    const { props } = setup();
    expect(screen.getByRole("button", { name: "Reduzir zoom" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ampliar zoom" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cores" }));
    expect(props.onToggleColors).toHaveBeenCalled();
  });

  it("mostra o caminho do foco; cada parte leva o foco para lá", async () => {
    const { props } = setup();
    const path = within(screen.getByRole("navigation", { name: "Foco da árvore" }));
    expect(path.getByRole("button", { name: "Checkout" })).toHaveAttribute("aria-current", "location");
    await userEvent.click(path.getByRole("button", { name: "Loja" }));
    expect(props.onFocus).toHaveBeenCalledWith("loja");
  });

  it("com um ticket selecionado dentro de outro pai, oferece ver só esse pai", async () => {
    const { props } = setup({ narrowTo: { id: "pai-x", label: "Conta" } });
    await userEvent.click(screen.getByRole("button", { name: "Ver só Conta" }));
    expect(props.onFocus).toHaveBeenCalledWith("pai-x");
  });
});

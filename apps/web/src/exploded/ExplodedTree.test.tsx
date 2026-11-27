import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dependencyTicketId, dependencyTickets } from "../test/dependencyMap.js";
import { makeTicket } from "../test/fakes.js";
import { ExplodedTree } from "./ExplodedTree.js";
import type { ExplodedTreeProps } from "./ExplodedTree.js";

// ADR 0070 com a revisão do dono: cards pequenos com código e título, tons de fila, cabeçalhos de passo, manchete do que pegar agora.
const tickets = dependencyTickets();
const id = dependencyTicketId;

function setup(extra: Partial<ExplodedTreeProps> = {}) {
  const props: ExplodedTreeProps = {
    tickets,
    focus: { projectId: "loja", ticketId: id("Checkout") },
    selectedId: null,
    onSelect: vi.fn(),
    onClearSelection: vi.fn(),
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
const card = (name: RegExp) => screen.getByRole("button", { name });

describe("ExplodedTree", () => {
  it("o card tem o código em negrito, o título numa linha e a marca do pai direto", () => {
    setup();
    const casca = card(/LOJA-2 · Casca do checkout/);
    expect(casca.querySelector(".exploded-card-code b")).toHaveTextContent("LOJA-2");
    expect(casca.querySelector(".exploded-card-title")).toHaveTextContent("Casca do checkout");
    expect(casca.querySelector(".exploded-card-parent")).toHaveTextContent("LOJA-1");
    expect(casca).toHaveAccessibleName(/Dentro de Checkout/);
  });

  it("o código entre colchetes no começo do título vira a linha 1", () => {
    const own = [makeTicket("a", "loja", 1, "[ABC-01] Fazer a base", { key: "LOJA-1" })];
    setup({ tickets: own, focus: { projectId: "loja", ticketId: null }, focusPath: [{ id: "loja", label: "Loja" }] });
    const only = card(/LOJA-1/);
    expect(only.querySelector(".exploded-card-code b")).toHaveTextContent("ABC-01");
    expect(only.querySelector(".exploded-card-title")).toHaveTextContent("Fazer a base");
  });

  it("os tons: livre e próximo fortes, esperando calmo", () => {
    setup();
    expect(card(/Casca do checkout/)).toHaveAttribute("data-tone", "free");
    expect(card(/Carrinho/)).toHaveAttribute("data-tone", "next");
    expect(card(/Pagamento/)).toHaveAttribute("data-tone", "waiting");
  });

  it("a manchete diz o que pegar agora e o que abre em seguida, pelas chaves", () => {
    setup();
    expect(screen.getByText("Pegue agora: LOJA-2, LOJA-7 · Abre em seguida: LOJA-3, LOJA-4")).toBeInTheDocument();
  });

  it("um ticket com filhos que entra numa dependência é um nó, com a conta dos de dentro", () => {
    const own = [
      makeTicket("historia", "loja", 1, "História", { key: "LOJA-1", progress: { done: 0, total: 2, excluded: 0 } }),
      makeTicket("s1", "loja", 2, "Sub 1", { key: "LOJA-2", parentId: "historia" }),
      makeTicket("s2", "loja", 3, "Sub 2", { key: "LOJA-3", parentId: "historia" }),
      makeTicket("depois", "loja", 4, "Depois", { key: "LOJA-4", dependencies: [{ id: "historia", need: "start" }] }),
    ];
    setup({ tickets: own, focus: { projectId: "loja", ticketId: null }, focusPath: [{ id: "loja", label: "Loja" }] });
    const story = card(/LOJA-1 · História/);
    expect(story.querySelector(".exploded-card-inside")).toHaveTextContent("+2");
    expect(story).toHaveAccessibleName(/2 itens dentro/);
    expect(screen.queryByRole("button", { name: /Sub 1/ })).toBeNull();
  });

  it("a dependência que aponta para fora do foco vira um card apagado", () => {
    setup();
    const outside = card(/Termos de uso/);
    expect(outside).toHaveAttribute("data-outside", "true");
    expect(outside).toHaveAccessibleName(/Fora do foco/);
  });

  it("uma seta por ticket que pendura em outro, e os cabeçalhos de passo", () => {
    const { container } = setup();
    expect(container.querySelectorAll(".exploded-hang")).toHaveLength(4);
    expect(within(container.querySelector<HTMLElement>(".exploded-steps")!).getByText("Passo 0")).toBeInTheDocument();
  });

  it("o clique abre o ticket, como no mapa", async () => {
    const { props } = setup();
    await userEvent.click(card(/Carrinho/));
    expect(props.onSelect).toHaveBeenCalledWith(id("Carrinho"));
  });

  it("selecionar mostra todas as dependências dele, com as cores e o tracejado da ADR 0069", () => {
    const { container } = setup({ selectedId: id("Pagamento") });
    const lines = [...container.querySelectorAll<SVGLineElement>(".map-arrows line")];
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

  it("os controles: aproximar, afastar e ver a árvore inteira", () => {
    setup();
    const toolbar = within(screen.getByRole("toolbar", { name: "Câmera da árvore" }));
    expect(toolbar.getByRole("button", { name: "Reduzir zoom" })).toBeInTheDocument();
    expect(toolbar.getByRole("button", { name: "Ver a árvore inteira" })).toBeInTheDocument();
    expect(toolbar.getByRole("button", { name: "Ampliar zoom" })).toBeInTheDocument();
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

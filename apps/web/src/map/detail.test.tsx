import { act, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import type { SpatialNodeContent } from "@treepm/react";
import { describe, expect, it, vi } from "vitest";
import { makePerson, makeProject, makeTicket } from "../test/fakes.js";
import { buildMapItems } from "./items.js";
import type { MapNode } from "./items.js";
import { DETAIL_MIN_WIDTH, MapDetailProvider, buildDetailData, createMapScaleStore } from "./detail.js";
import { renderNodeContent } from "./nodeContent.js";

const org = { orgId: "org-1", name: "Equipe Alfa", slug: "alfa" };
const project = makeProject("alfa", "ALFA", "Projeto Alfa");
const people = [makePerson("p-ana", "Ana Souza"), makePerson("p-teo", "Teodoro"), makePerson("p-bia", "Bia")];

const tickets = [
  makeTicket("raiz", "alfa", 1, "Publicar o site", { status: null, progress: { done: 2, total: 5, excluded: 0 }, descriptionExcerpt: "Texto do pai" }),
  makeTicket("a", "alfa", 2, "Escrever", { parentId: "raiz", status: "done" }),
  makeTicket("b", "alfa", 3, "Revisar", { parentId: "raiz", status: "in_review" }),
  makeTicket("c", "alfa", 4, "Montar", { parentId: "raiz", status: "in_progress" }),
  makeTicket("d", "alfa", 5, "Testar", { parentId: "raiz", status: "done" }),
  makeTicket("e", "alfa", 6, "Publicar", { parentId: "raiz", status: "todo" }),
  makeTicket("f", "alfa", 7, "Cancelado", { parentId: "raiz", status: "cancelled" }),
  makeTicket("folha", "alfa", 8, "Ajustar o rodapé", {
    status: "in_progress",
    descriptionExcerpt: "Trocar o texto legal do rodapé e conferir os links.",
    assigneeIds: ["p-ana", "p-teo", "p-fantasma"],
  }),
];
const items = buildMapItems(org, [project], { alfa: tickets });
const nodeOf = (id: string): MapNode => items.find((item) => item.id === id)!;
const data = buildDetailData(items, people);

/** Larguras do layout por nó; a escala da câmera as multiplica. */
const widths: Record<string, number> = { "org-1": 200, alfa: 200 };
const layout = { nodeById: new Map(items.map((item) => [item.id, { width: widths[item.id] ?? 100 }])) };

function setup(scale: number) {
  const store = createMapScaleStore();
  store.update(scale, layout);
  const ui = (id: string, lod: SpatialNodeContent<MapNode>["lod"] = "full", childCount = 0) => (
    <MapDetailProvider store={store} data={data}>
      {renderNodeContent({ node: nodeOf(id), label: nodeOf(id).label, lod, aggregate: false, depth: 1, childCount, descendantCount: 0 })}
    </MapDetailProvider>
  );
  return { store, ui };
}

describe("card em detalhe (ADR 0027)", () => {
  it("uses 300 px of projected width as the threshold", () => {
    expect(DETAIL_MIN_WIDTH).toBe(300);
  });

  it("a leaf ticket shows key, big title, state, description excerpt and people with accessible names", () => {
    const { ui } = setup(3);
    const { container } = render(ui("folha"));
    const card = container.querySelector(".node-detail")!;
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent("ALFA-8");
    expect(within(card as HTMLElement).getByText("Ajustar o rodapé")).toBeInTheDocument();
    expect(card).toHaveTextContent("Em andamento");
    expect(card).toHaveTextContent("Trocar o texto legal do rodapé e conferir os links.");
    expect(container.querySelectorAll("[data-state]")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Ana Souza" })).toHaveTextContent("AS");
    expect(screen.getByRole("img", { name: "Teodoro" })).toHaveTextContent("TE");
    expect(screen.getByRole("img", { name: "Pessoa desconhecida" })).toBeInTheDocument();
  });

  it("a leaf has no children count and no breakdown", () => {
    const { ui } = setup(3);
    const { container } = render(ui("folha"));
    expect(container.querySelector(".node-detail")).not.toHaveTextContent(/subticket/);
    expect(container.querySelector(".node-detail-breakdown")).toBeNull();
  });

  it("a ticket with children shows the direct children count, progress and the leaves by status", () => {
    const { ui } = setup(4);
    const { container } = render(ui("raiz", "full", 6));
    const card = container.querySelector(".node-detail")!;
    expect(card).toHaveTextContent("6 subtickets");
    expect(card).toHaveTextContent("2 de 5 concluídos");
    expect(card).toHaveTextContent("Texto do pai");
    expect(card.querySelector(".node-detail-breakdown")).toHaveTextContent("1 em revisão · 1 em andamento · 1 a fazer");
    expect(container.querySelector("[data-state]")).toHaveAttribute("data-state", "progress");
  });

  it("uses the singular for one subticket", () => {
    const { ui } = setup(4);
    const { container } = render(ui("raiz", "full", 1));
    expect(container.querySelector(".node-detail")).toHaveTextContent("1 subticket");
    expect(container.querySelector(".node-detail")).not.toHaveTextContent("1 subtickets");
  });

  it("omits the description block when the excerpt is empty", () => {
    const { ui } = setup(4);
    const { container } = render(ui("a"));
    expect(container.querySelector(".node-detail-description")).toBeNull();
  });

  it("a project shows key, name and its tickets count, with no description or people", () => {
    const { ui } = setup(2);
    const { container } = render(ui("alfa", "full", 1));
    const card = container.querySelector(".node-detail")!;
    expect(card).toHaveTextContent("ALFA");
    expect(card).toHaveTextContent("1 ticket na raiz");
    expect(within(card as HTMLElement).getByText("Projeto Alfa")).toBeInTheDocument();
    expect(card.querySelector(".node-detail-description, .node-detail-people")).toBeNull();
    expect(container.querySelector("[data-state]")).toBeNull();
  });

  it("the organization shows its projects count", () => {
    const { ui } = setup(2);
    const { container } = render(ui("org-1", "full", 2));
    expect(container.querySelector(".node-detail")).toHaveTextContent("Organização");
    expect(container.querySelector(".node-detail")).toHaveTextContent("2 projetos");
  });

  it("is decided per node: same scale, different layout widths", () => {
    const { ui } = setup(2.5); // alfa: 500 px, folha: 250 px
    const wide = render(ui("alfa", "full", 1)); // 200 × 2,5 = 500
    expect(wide.container.querySelector(".node-detail")).not.toBeNull();
    const narrow = render(ui("folha")); // 100 × 2,5 = 250
    expect(narrow.container.querySelector(".node-detail")).toBeNull();
    expect(narrow.container).toHaveTextContent("Em andamento");
  });

  it("switches exactly at 300 px (299 stays full, 300 is detail)", () => {
    const store = createMapScaleStore();
    const { rerender, container } = render(<MapDetailProvider store={store} data={data}>{renderNodeContent({ node: nodeOf("folha"), label: "x", lod: "full", aggregate: false, depth: 1, childCount: 0, descendantCount: 0 })}</MapDetailProvider>);
    act(() => store.update(2.99, layout));
    expect(container.querySelector(".node-detail")).toBeNull();
    act(() => store.update(3, layout));
    expect(container.querySelector(".node-detail")).not.toBeNull();
    act(() => store.update(2.99, layout));
    expect(container.querySelector(".node-detail")).toBeNull();
    rerender(<MapDetailProvider store={store} data={data}>{null}</MapDetailProvider>);
  });

  it("never shows the detail below the full level, whatever the scale", () => {
    const { ui } = setup(10);
    for (const lod of ["compact", "chip", "dot"] as const) {
      expect(render(ui("folha", lod)).container.querySelector(".node-detail")).toBeNull();
    }
  });

  it("does not re-render the content for zoom changes inside the same level, only when it crosses 300 px", () => {
    const store = createMapScaleStore();
    const onRender = vi.fn();
    store.update(3.2, layout);
    render(
      <MapDetailProvider store={store} data={data}>
        <Profiler id="c" onRender={onRender}>
          {renderNodeContent({ node: nodeOf("folha"), label: "x", lod: "full", aggregate: false, depth: 1, childCount: 0, descendantCount: 0 })}
        </Profiler>
      </MapDetailProvider>,
    );
    onRender.mockClear();
    for (const scale of [3.3, 4, 5.5, 9, 3.01]) act(() => store.update(scale, layout));
    expect(onRender).not.toHaveBeenCalled(); // zoom dentro do detalhe
    act(() => store.update(2.9, layout));
    expect(onRender).toHaveBeenCalledTimes(1); // cruzou 300 px
    onRender.mockClear();
    for (const scale of [2.5, 2.1, 1.4, 2.95]) act(() => store.update(scale, layout));
    expect(onRender).not.toHaveBeenCalled(); // zoom dentro do nível completo
  });
});

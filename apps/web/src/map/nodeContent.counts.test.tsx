import { render } from "@testing-library/react";
import type { SpatialNodeContent } from "@treepm/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n/index.js";
import { makeTicket } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import type { MapNode } from "./items.js";
import { renderNodeContent, ticketAriaLabel } from "./nodeContent.js";

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

const parentTicket = (extra: Parameters<typeof makeTicket>[4] = {}) =>
  makeTicket("t1", "alfa", 3, "Página", { status: "in_progress", place: null, progress: { done: 3, total: 8, excluded: 0 }, ...extra });
const node = (extra: Partial<MapNode> = {}, ticket = parentTicket()): MapNode => ({
  id: ticket.id,
  parentId: "alfa",
  kind: "ticket",
  label: ticket.title,
  color: "#3b8eff",
  key: ticket.key,
  ticket,
  leafCount: 1,
  counts: { tickets: 8, done: 3, free: 1 },
  ...extra,
});
const content = (mapNode: MapNode, lod: SpatialNodeContent<MapNode>["lod"]) =>
  render(<>{renderNodeContent({ node: mapNode, label: mapNode.label, lod, aggregate: false, depth: 1, childCount: 2, descendantCount: 8 })}</>).container;

// ADR 0069, seção 4: todo pai mostra quantos tickets, quantos prontos e quantos livres, da subárvore inteira.
describe("os três números no card do pai", () => {
  it("full: a linha de situação traz os três números no lugar de 'N de M concluídos'", () => {
    const container = content(node(), "full");
    expect(container).toHaveTextContent("8 tickets · 3 prontos · 1 livre");
    expect(container).not.toHaveTextContent("3 de 8 concluídos");
  });

  it("full: num pai com tudo finalizado abaixo, a situação dele vem antes dos números", () => {
    const finished = parentTicket({ status: "done", progress: { done: 8, total: 8, excluded: 0 } });
    expect(content(node({ counts: { tickets: 8, done: 8, free: 0 } }, finished), "full")).toHaveTextContent("Concluído · 8 tickets · 8 prontos · 0 livres");
  });

  it("full: o bloqueado continua escrito antes", () => {
    expect(content(node({}, parentTicket({ blocked: true })), "full")).toHaveTextContent("Bloqueado · 8 tickets · 3 prontos · 1 livre");
  });

  it.each(["compact", "chip"] as const)("%s: a forma curta, com a frase inteira na dica do ponteiro", (lod) => {
    const container = content(node(), lod);
    const counts = container.querySelector(".node-counts")!;
    expect(counts).toHaveTextContent("8 · 3 · 1");
    expect(counts).toHaveAttribute("title", "8 tickets · 3 prontos · 1 livre");
  });

  it("compact: os números ficam na linha de cima, ao lado da chave, que nunca é cortada", () => {
    const row = content(node(), "compact").querySelector(".node-key-row")!;
    expect(row.querySelector(".spatial-key")).toHaveTextContent("ALFA-3");
    expect(row.querySelector(".node-counts")).toHaveTextContent("8 · 3 · 1");
  });

  it("full: a frase pode quebrar a linha em vez de cortar", () => {
    expect(content(node(), "full").querySelector(".node-state .node-counts-long")).toHaveTextContent("8 tickets · 3 prontos · 1 livre");
  });

  it("dot: sem texto, a frase fica na dica do ponteiro", () => {
    const container = content(node(), "dot");
    expect(container).toHaveTextContent("");
    expect(container.querySelector("[title]")).toHaveAttribute("title", "8 tickets · 3 prontos · 1 livre");
  });

  it("um ticket sem filhos não tem números", () => {
    const leaf = makeTicket("t2", "alfa", 4, "Folha", { place: "free" });
    const container = content({ ...node({}, leaf), counts: undefined }, "compact");
    expect(container.querySelector(".node-counts")).toBeNull();
  });

  it.each([
    ["pt-BR", "8 tickets · 3 prontos · 1 livre"],
    ["en", "8 tickets · 3 done · 1 free"],
    ["es-MX", "8 tickets · 3 listos · 1 libre"],
  ] as const)("o rótulo acessível traz os números (%s)", async (language, counts) => {
    await setTestLanguage(language);
    expect(ticketAriaLabel(i18n.getFixedT(language, "map"), node(), false)).toContain(counts);
  });
});

// ADR 0069, seção 2: o habilitador ganha a marca "abre os irmãos".
describe("a marca do habilitador", () => {
  const leaf = makeTicket("t2", "alfa", 4, "Casca", { place: "free" });
  const enabler = (): MapNode => ({ ...node({}, leaf), counts: undefined, enabler: true });

  it.each(["full", "compact"] as const)("%s: escreve 'Abre os irmãos'", (lod) => {
    expect(content(enabler(), lod)).toHaveTextContent("Abre os irmãos");
  });

  it("compact: a marca fica na linha do marcador, que tem espaço, para não cortar no fim do card", () => {
    expect(content(enabler(), "compact").querySelector(".node-state .node-enabler")).toHaveTextContent("Abre os irmãos");
  });

  it("chip: uma marca com a frase na dica do ponteiro", () => {
    expect(content(enabler(), "chip").querySelector(".node-enabler")).toHaveAttribute("title", "Abre os irmãos");
  });

  it("não aparece em quem não é habilitador", () => {
    expect(content({ ...enabler(), enabler: undefined }, "full")).not.toHaveTextContent("Abre os irmãos");
  });

  it.each([
    ["pt-BR", "Abre os irmãos"],
    ["en", "Opens its siblings"],
    ["es-MX", "Abre a sus hermanos"],
  ] as const)("o rótulo acessível diz (%s)", async (language, text) => {
    await setTestLanguage(language);
    expect(ticketAriaLabel(i18n.getFixedT(language, "map"), enabler(), false)).toContain(text);
  });
});

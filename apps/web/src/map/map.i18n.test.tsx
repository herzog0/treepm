import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SpatialNodeContent } from "@treepm/react";
import { describe, expect, it } from "vitest";
import i18n from "../i18n/index.js";
import type { Language } from "../i18n/languages.js";
import { resources } from "../i18n/resources.js";
import { failed, makeClient, makeMe, makePerson, makeProject, makeTicket } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import type { MapNode } from "./items.js";
import { buildMapItems } from "./items.js";
import { MapDetailProvider, buildDetailData, createMapScaleStore } from "./detail.js";
import { initialsOf } from "./DetailCard.js";
import { OrganizationMap } from "./OrganizationMap.js";
import { renderNodeContent } from "./nodeContent.js";

// Prazo dos testes que montam o mapa inteiro: 2-4 s com a máquina em uso normal, e mais de 8 s com ela saturada (TREEPM-101).
const SLOW = 20_000;

/** Textos em português do catálogo `map` que o idioma testado traduziu de outro jeito (e que não são variáveis nem marcação). */
function portugueseNotShared(language: Language): string[] {
  const out: string[] = [];
  const walk = (pt: unknown, other: unknown) => {
    if (typeof pt === "string") {
      if (pt !== other && !pt.includes("{{") && !pt.includes("<")) out.push(pt);
    } else if (typeof pt === "object" && pt !== null) {
      for (const [key, value] of Object.entries(pt)) walk(value, (other as Record<string, unknown> | undefined)?.[key]);
    }
  };
  walk(resources["pt-BR"].map, resources[language].map);
  return out;
}

/** O catálogo `map` é o único que esta área converte: o resto (painel, ticket, assistente) ainda pode estar em português. */
function expectNoMapPortuguese(source: HTMLElement, language: Language) {
  // O painel lateral é de outra área (`panel/`) e pode estar ainda em português; fica fora desta conferência.
  const container = source.cloneNode(true) as HTMLElement;
  for (const panel of container.querySelectorAll("aside.side-panel, [aria-label='Áreas e projetos'][role='complementary'], aside:has(> [role='tablist'])")) panel.remove();
  const visible = `${container.textContent ?? ""}\n${[...container.querySelectorAll("[aria-label],[title]")]
    .map((element) => `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`)
    .join("\n")}`;
  for (const text of portugueseNotShared(language)) expect(visible, `Portuguese text left: "${text}"`).not.toContain(text);
}

const TEXT = {
  en: {
    loading: "Loading map",
    canvas: "Organization map",
    focusPath: "Focus path",
    panelToggle: "Areas and projects",
    zoomOut: "Zoom out",
    reset: "Reset view",
    zoomIn: "Zoom in",
    colors: "Colors",
    help: "Wheel to zoom · drag to pan · combine both · click opens the ticket · C colors · Esc clear",
    selected: "Selected node",
    close: "Close selection",
    explore: "Explore branch",
    createFirst: "Create first project",
    barInput: "Ask for anything",
    createTicket: /^Create ticket «csv»/,
    org: (n: string) => new RegExp(`^Equipe Alfa\\. Organization with ${n}\\.`),
    project: /ALFA · Projeto Alfa\. Project\./,
    ticket: /ALFA-1 · Publicar\. Ticket\./,
    key: "Organization",
    states: { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", cancelled: "Canceled" },
    progress: "1 of 3 done",
    progressCanceled: (n: number) => `1 of 3 done · ${n} canceled`,
    projects: (n: number) => `${n} ${n === 1 ? "project" : "projects"}`,
    items: (n: number) => `${n} ${n === 1 ? "item" : "items"}`,
    itemsAtRoot: (n: number) => `${n} ${n === 1 ? "item" : "items"} at root`,
    groupProjects: "projects grouped",
    unknownPerson: "Unknown person",
    notCreated: "Not created yet",
    draftLabel: "Ticket draft: Corrigir. Not created yet.",
    newDraft: "New ticket",
    leaves: "1 in review · 2 in progress · 3 to do",
    upper: "AS",
  },
  "es-MX": {
    loading: "Cargando mapa",
    canvas: "Mapa de la organización",
    focusPath: "Ruta del enfoque",
    panelToggle: "Áreas y proyectos",
    zoomOut: "Alejar",
    reset: "Restablecer encuadre",
    zoomIn: "Acercar",
    colors: "Colores",
    help: "Rueda para acercar · arrastra para desplazar · combina ambos · clic abre el ticket · C colores · Esc limpiar",
    selected: "Nodo seleccionado",
    close: "Cerrar selección",
    explore: "Explorar rama",
    createFirst: "Crear primer proyecto",
    barInput: "Pide lo que quieras",
    createTicket: /^Crear ticket «csv»/,
    org: (n: string) => new RegExp(`^Equipe Alfa\\. Organización con ${n}\\.`),
    project: /ALFA · Projeto Alfa\. Proyecto\./,
    ticket: /ALFA-1 · Publicar\. Ticket\./,
    key: "Organización",
    states: { todo: "Por hacer", in_progress: "En curso", in_review: "En revisión", done: "Terminado", cancelled: "Cancelado" },
    progress: "1 de 3 terminados",
    progressCanceled: (n: number) => `1 de 3 terminados · ${n} ${n === 1 ? "cancelado" : "cancelados"}`,
    projects: (n: number) => `${n} ${n === 1 ? "proyecto" : "proyectos"}`,
    items: (n: number) => `${n} ${n === 1 ? "elemento" : "elementos"}`,
    itemsAtRoot: (n: number) => `${n} ${n === 1 ? "elemento" : "elementos"} en la raíz`,
    groupProjects: "proyectos agrupados",
    unknownPerson: "Persona desconocida",
    notCreated: "Aún no creado",
    draftLabel: "Borrador de ticket: Corrigir. Aún no creado.",
    newDraft: "Nuevo ticket",
    leaves: "1 en revisión · 2 en curso · 3 por hacer",
    upper: "AS",
  },
} as const;

async function exploreAlfa(text: { selected: string; explore: string }) {
  await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
  await userEvent.click(within(screen.getByRole("complementary", { name: text.selected })).getByRole("button", { name: text.explore }));
}

const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const org = { orgId: "org-1", name: "Equipe Alfa", slug: "alfa" };
const nodeOf = (kind: MapNode["kind"], extra: Partial<MapNode> = {}): MapNode => ({
  id: "n1", parentId: "org-1", kind, label: "Publicar", color: "#8b92a3", key: "ALFA-1", ticket: null, leafCount: 1, ...extra,
});
const cardContent = (node: MapNode, lod: SpatialNodeContent<MapNode>["lod"], extra: Partial<SpatialNodeContent<MapNode>> = {}) =>
  render(<>{renderNodeContent({ node, label: node.label, lod, aggregate: false, depth: 1, childCount: 0, descendantCount: 0, ...extra })}</>).container;

describe.each(["en", "es-MX"] as const)("map in %s", (language) => {
  const text = TEXT[language];

  it("translates the loading state, the canvas labels, the breadcrumb, the toolbar, the help bar and the node names", async () => {
    await setTestLanguage(language);
    const { container } = render(<OrganizationMap client={makeClient({ projects, tickets: { p1: [makeTicket("t1", "p1", 1, "Publicar", { key: "ALFA-1" })] } })} me={makeMe()} />);
    expect(screen.getByRole("status")).toHaveTextContent(text.loading);
    expect(await screen.findByRole("button", { name: text.org("2 " + (language === "en" ? "projects" : "proyectos")) })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: text.canvas })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: text.focusPath })).toHaveTextContent("Equipe Alfa");
    expect(screen.getByRole("button", { name: text.panelToggle })).toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar");
    for (const name of [text.zoomOut, text.reset, text.zoomIn, text.colors]) expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByText(text.help)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.project })).toBeInTheDocument();
    await exploreAlfa(text);
    expect(await screen.findByRole("button", { name: text.ticket }, { timeout: SLOW })).toBeInTheDocument();
    expectNoMapPortuguese(container, language);
  }, SLOW);

  it("translates the selection card and the actions of the map", async () => {
    await setTestLanguage(language);
    const { container } = render(<OrganizationMap client={makeClient({ projects, tickets: { p1: [makeTicket("t1", "p1", 1, "Publicar", { key: "ALFA-1", status: "in_review" })] } })} me={makeMe({ assistant: true })} />);
    await exploreAlfa(text);
    const ticket = await screen.findByRole("button", { name: text.ticket }, { timeout: SLOW });
    await waitFor(() => expect(ticket).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
    // O clique no ticket abre a página; o cartão de seleção é o do projeto, que segue selecionado.
    const card = screen.getByRole("complementary", { name: text.selected });
    expect(within(card).getByRole("button", { name: text.close })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: text.explore })).toBeInTheDocument();
    // Sem botão flutuante (ADR 0036): o pedido de ticket começa pela barra.
    await userEvent.type(screen.getByRole("combobox", { name: text.barInput }), "csv");
    expect(await screen.findByRole("option", { name: text.createTicket })).toBeInTheDocument();
    expectNoMapPortuguese(container, language);
  }, SLOW);

  it.each([0, 1, 2])("counts %i projects in the node name and in the selection card", async (count) => {
    await setTestLanguage(language);
    const list = [projects[0]!, projects[1]!].slice(0, count);
    const { container } = render(<OrganizationMap client={makeClient({ projects: list })} me={makeMe({ clerk: "member" })} />);
    const node = await screen.findByRole("button", { name: text.org(text.projects(count)) });
    await userEvent.click(node);
    expect(within(screen.getByRole("complementary", { name: text.selected })).getByText(text.projects(count))).toBeInTheDocument();
    expectNoMapPortuguese(container, language);
  }, SLOW);

  it("offers 'create first project' to admins in the language", async () => {
    await setTestLanguage(language);
    render(<OrganizationMap client={makeClient()} me={makeMe({ clerk: "admin" })} />);
    expect(await screen.findByRole("button", { name: text.createFirst })).toBeInTheDocument();
  }, SLOW);

  it("translates the load error through the shared API messages", async () => {
    await setTestLanguage(language);
    const client = makeClient({ projects });
    client.listProjects = async () => failed("unavailable");
    render(<OrganizationMap client={client} me={makeMe()} />);
    expect(await screen.findByRole("alert")).not.toHaveTextContent("API indisponível");
  });

  it.each([0, 1, 2])("writes the aria label of merged squares for %i members from the catalog", async (count) => {
    await setTestLanguage(language);
    const t = i18n.getFixedT(language, "map");
    const options = { count, members: "A, B" };
    expect(t("group.projects", options)).toContain(`${count} `);
    expect(t("group.projects", options)).toContain(text.groupProjects.split(" ")[0] === "projects" ? "A, B. Zoom in to reveal." : "A, B. Acerca para revelar.");
    expect(t("group.items", options)).toContain("A, B");
  });

  describe("node content by level of detail", () => {
    it("shows the status names, the progress and the counts on the card", async () => {
      await setTestLanguage(language);
      for (const status of ["todo", "in_progress", "in_review", "done", "cancelled"] as const) {
        const container = cardContent(nodeOf("ticket", { ticket: makeTicket("n1", "alfa", 1, "Publicar", { status }) }), "full");
        expect(container).toHaveTextContent(text.states[status]);
      }
      const parent = makeTicket("n1", "alfa", 1, "Pai", { progress: { done: 1, total: 3, excluded: 0 } });
      expect(cardContent(nodeOf("ticket", { ticket: parent }), "full")).toHaveTextContent(text.progress);
    });

    it.each([0, 1, 2])("counts %i children on organization and project cards", async (count) => {
      await setTestLanguage(language);
      const container = cardContent(nodeOf("organization", { key: null, ticket: null }), "full", { childCount: count, aggregate: true, descendantCount: count });
      expect(container).toHaveTextContent(text.key);
      expect(container).toHaveTextContent(text.projects(count));
      const aggregate = cardContent(nodeOf("project", { key: "ALFA" }), "full", { aggregate: true, descendantCount: count });
      expect(aggregate).toHaveTextContent(text.items(count));
    });

    it("renders the dashed draft card in the language", async () => {
      await setTestLanguage(language);
      const container = cardContent(nodeOf("draft", { key: "Novo", label: "Corrigir" }), "full");
      expect(container).toHaveTextContent(text.notCreated);
    });
  });

  describe("detail card", () => {
    const items = buildMapItems(org, [projects[0]!], {
      p1: [
        makeTicket("raiz", "p1", 1, "Pai", { progress: { done: 1, total: 7, excluded: 2 }, assigneeIds: ["ghost"] }),
        makeTicket("a", "p1", 2, "A", { parentId: "raiz", status: "in_review" }),
        makeTicket("b", "p1", 3, "B", { parentId: "raiz", status: "in_progress" }),
        makeTicket("c", "p1", 4, "C", { parentId: "raiz", status: "in_progress" }),
        makeTicket("d", "p1", 5, "D", { parentId: "raiz", status: "todo" }),
        makeTicket("e", "p1", 6, "E", { parentId: "raiz", status: "todo" }),
        makeTicket("f", "p1", 7, "F", { parentId: "raiz", status: "todo" }),
      ],
    });
    const store = createMapScaleStore();
    store.update(4, { nodeById: new Map(items.map((item) => [item.id, { width: 100 }])) });
    const data = buildDetailData(items, [makePerson("p-ana", "ana souza")]);

    it("translates the progress with canceled, the counts, the leaves summary and the unknown person", async () => {
      await setTestLanguage(language);
      const node = items.find((item) => item.id === "raiz")!;
      const { container } = render(
        <MapDetailProvider store={store} data={data}>
          {renderNodeContent({ node, label: node.label, lod: "full", aggregate: false, depth: 1, childCount: 6, descendantCount: 6 })}
        </MapDetailProvider>,
      );
      expect(container).toHaveTextContent(text.items(6));
      expect(container).toHaveTextContent(text.leaves);
      expect(screen.getByRole("img", { name: text.unknownPerson })).toHaveAttribute("title", text.unknownPerson);
      expectNoMapPortuguese(container, language);
    });

    it("uses the active language to upper-case initials", () => {
      expect(initialsOf("ana souza", language)).toBe(text.upper);
    });
  });

  it("switches language with the map open", async () => {
    await setTestLanguage(language);
    render(<OrganizationMap client={makeClient({ projects })} me={makeMe()} />);
    await screen.findByRole("region", { name: text.canvas });
    await setTestLanguage("pt-BR");
    expect(await screen.findByRole("region", { name: "Mapa da organização" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Equipe Alfa\. Organização com 2 projetos\./ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cores" })).toBeInTheDocument();
    expect(screen.getByText(/Wheel para zoom/)).toBeInTheDocument();
    await setTestLanguage(language);
    expect(await screen.findByRole("region", { name: text.canvas })).toBeInTheDocument();
  }, SLOW);
});

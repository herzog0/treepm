import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import type { Language } from "../i18n/languages.js";
import { makeClient, makeProject } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { makePanelMe } from "../panel/testing.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const LIST = "- Pai\n  - [x] Filho um\n  - [/] Filho dois\n- [r] Solo";

function setup(options: { me?: ReturnType<typeof makePanelMe>; projects?: ReturnType<typeof makeProject>[]; projectId?: string } = {}) {
  const client = makeClient({ projects: options.projects ?? [project] });
  const onExit = vi.fn();
  const view = render(<ImportScreen client={client} me={options.me ?? makePanelMe("admin")} projectId={options.projectId ?? "p1"} onExit={onExit} />);
  return { client, onExit, ...view };
}
async function paste(label: string, text: string) {
  const area = await screen.findByRole("textbox", { name: label });
  await userEvent.click(area);
  await userEvent.paste(text);
  return area;
}

const TEXTS = {
  en: {
    h1: "Import list", intro: /each item becomes a ticket, the indentation says who is whose child/i, list: "List", file: "Choose file", path: "Path", preview: "Preview",
    empty: "The tree appears here while you paste or type the list.", markers: "Markers",
    meanings: ["to do", "in progress", "in review", "done", "canceled"], tree: "Preview of the tree",
    summary: "4 tickets · 2 roots · 3 leaves", summaryOne: "2 tickets · 1 root · 1 leaf", sub2: "2 subitems", sub1: "1 subitem",
    done: "Done", inProgress: "In progress", inReview: "In review", importFour: "Import 4 tickets", importOne: "Import 1 ticket", importPlain: "Import", cancel: "Cancel",
    noPermission: /You do not have permission to import tickets in this project/, archived: /The project is archived and does not accept import/, missing: /Project not found or you have no access/, back: "Back to the map",
    loading: "Loading project…", errors: "List errors", warnings: "List warnings", placeholder: "- First delivery\n  - [x] Completed step\n  - [/] Step in progress\n- [ ] Another delivery",
    zero: ["0 tickets", "0 roots", "0 leaves", "0 subitems"],
  },
  "es-MX": {
    h1: "Importar lista", intro: /cada elemento se convierte en un ticket, la sangría define quién es hijo de quién/i, list: "Lista", file: "Elegir archivo", path: "Ruta", preview: "Vista previa",
    empty: "El árbol aparece aquí mientras pegas o escribes la lista.", markers: "Marcadores",
    meanings: ["por hacer", "en curso", "en revisión", "terminado", "cancelado"], tree: "Vista previa del árbol",
    summary: "4 tickets · 2 raíces · 3 hojas", summaryOne: "2 tickets · 1 raíz · 1 hoja", sub2: "2 subelementos", sub1: "1 subelemento",
    done: "Terminado", inProgress: "En curso", inReview: "En revisión", importFour: "Importar 4 tickets", importOne: "Importar 1 ticket", importPlain: "Importar", cancel: "Cancelar",
    noPermission: /No tienes permiso para importar tickets en este proyecto/, archived: /El proyecto está archivado y no acepta importación/, missing: /Proyecto no encontrado o sin acceso/, back: "Volver al mapa",
    loading: "Cargando proyecto…", errors: "Errores de la lista", warnings: "Avisos de la lista", placeholder: "- Primera entrega\n  - [x] Paso terminado\n  - [/] Paso en curso\n- [ ] Otra entrega",
    zero: ["0 tickets", "0 raíces", "0 hojas", "0 subelementos"],
  },
};

describe.each(["en", "es-MX"] as const)("ImportScreen in %s", (language: Exclude<Language, "pt-BR">) => {
  const text = TEXTS[language];

  it("shows the header, the explanation, the marker legend and the empty preview", async () => {
    await setTestLanguage(language);
    setup();
    expect(await screen.findByRole("heading", { name: text.h1, level: 1 })).toBeInTheDocument();
    expect(screen.getByText(text.intro)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: text.path })).toBeInTheDocument();
    expect(screen.getByText(text.file)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: text.preview, level: 2 })).toBeInTheDocument();
    expect(screen.getByText(text.empty)).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: text.markers });
    text.meanings.forEach((meaning, position) => expect(within(legend).getAllByRole("listitem")[position]).toHaveTextContent(meaning));
    expect(screen.getByRole("textbox", { name: text.list })).toHaveAttribute("placeholder", text.placeholder);
    expect(screen.getByRole("button", { name: text.importPlain })).toBeDisabled();
    expect(screen.getByRole("button", { name: text.cancel })).toBeInTheDocument();
  });

  it("previews the tree with statuses, counts and the import button in the language", async () => {
    await setTestLanguage(language);
    setup();
    await paste(text.list, LIST);
    const tree = screen.getByRole("list", { name: text.tree });
    expect(screen.getByText(text.summary)).toBeInTheDocument();
    expect(within(tree).getByText(text.sub2)).toBeInTheDocument();
    expect(within(tree).getByText("Filho um").closest("li")).toHaveTextContent(text.done);
    expect(within(tree).getByText("Filho dois").closest("li")).toHaveTextContent(text.inProgress);
    expect(within(tree).getByText("Solo").closest("li")).toHaveTextContent(text.inReview);
    expect(screen.getByRole("button", { name: text.importFour })).toBeEnabled();
  });

  it("uses the singular forms for one of each", async () => {
    await setTestLanguage(language);
    setup();
    await paste(text.list, "- Pai\n  - Filho");
    expect(screen.getByText(text.summaryOne)).toBeInTheDocument();
    expect(screen.getByText(text.sub1)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: text.list }));
    await userEvent.paste("- Sozinho");
    expect(screen.getByRole("button", { name: text.importOne })).toBeInTheDocument();
  });

  it("has the plural forms for zero in the catalog", async () => {
    const t = i18n.getFixedT(language, "import");
    expect([t("summary.tickets", { count: 0 }), t("summary.roots", { count: 0 }), t("summary.leaves", { count: 0 }), t("preview.subitems", { count: 0 })]).toEqual(text.zero);
  });

  it("explains each unavailable state in the language", async () => {
    await setTestLanguage(language);
    setup({ me: makePanelMe("member") });
    expect(await screen.findByText(text.noPermission)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.back })).toBeInTheDocument();
  });

  it("explains an archived project and a missing project", async () => {
    await setTestLanguage(language);
    const archived = { ...project, archivedAt: "2026-11-01T00:00:00.000Z" };
    const first = setup({ projects: [archived] });
    expect(await screen.findByText(text.archived)).toBeInTheDocument();
    first.unmount();
    setup({ projectId: "nope" });
    expect(await screen.findByText(text.missing)).toBeInTheDocument();
  });
});

describe("ImportScreen language switch", () => {
  it("re-renders the open screen when the language changes", async () => {
    const { rerender } = setup();
    expect(await screen.findByRole("heading", { name: "Importar lista", level: 1 })).toBeInTheDocument();
    await paste("Lista", LIST);
    expect(screen.getByRole("button", { name: "Importar 4 tickets" })).toBeInTheDocument();
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(screen.getByRole("heading", { name: "Import list", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("4 tickets · 2 roots · 3 leaves")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 4 tickets" })).toBeInTheDocument();
    rerender(<></>);
  });
});

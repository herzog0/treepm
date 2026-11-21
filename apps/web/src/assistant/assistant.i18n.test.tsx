import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, PlacementOutcome } from "../api/client.js";
import { Demo } from "../demo/Demo.js";
import i18n from "../i18n/index.js";
import type { Language } from "../i18n/languages.js";
import { resources } from "../i18n/resources.js";
import type { MapNode } from "../map/items.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { AssistantPanel } from "./AssistantPanel.js";
import type { AssistantPanelProps } from "./AssistantPanel.js";
import type { MapPicker } from "./types.js";

/** Textos em português dos catálogos `assistant` e `demo` que o idioma testado traduziu de outro jeito (e que não são variáveis nem marcação). */
function portugueseNotShared(language: Language): string[] {
  const out: string[] = [];
  const walk = (pt: unknown, other: unknown) => {
    if (typeof pt === "string") {
      if (pt !== other && !pt.includes("{{") && !pt.includes("<")) out.push(pt);
    } else if (typeof pt === "object" && pt !== null) {
      for (const [key, value] of Object.entries(pt)) walk(value, (other as Record<string, unknown> | undefined)?.[key]);
    }
  };
  for (const namespace of ["assistant", "demo"] as const) walk(resources["pt-BR"][namespace], resources[language][namespace]);
  return out;
}

function expectNoPortuguese(container: HTMLElement, language: Language) {
  const visible = `${container.textContent ?? ""}\n${[...container.querySelectorAll("[aria-label],[title],[placeholder]")]
    .map((element) => ["aria-label", "title", "placeholder"].map((attribute) => element.getAttribute(attribute) ?? "").join(" "))
    .join("\n")}`;
  expect(portugueseNotShared(language).length).toBeGreaterThan(20);
  for (const text of portugueseNotShared(language)) expect(visible, `Portuguese text left: "${text}"`).not.toContain(text);
}

const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const beta = makeProject("p2", "BETA", "Projeto Beta");
const tickets = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", status: "done", progress: { done: 1, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1" }),
    makeTicket("t4", "p1", 4, "Relatórios", { key: "ALFA-4" }),
  ],
};
const target = (...ids: string[]) => ({ parentId: ids.at(-1) ?? null, path: ids.map((id) => ({ id, title: tickets.p1.find((t) => t.id === id)!.title })) });

const resumedList = vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }]));
function clientWith(extra: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const client = makeClient({ projects: [alfa, beta] });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c-new", projectId))),
    sendConversationMessage: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string }) => ok(makeConversation(id, "p1", { draft: body }))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: target("t2") }))),
    createTicketFromConversation: vi.fn(),
    removeConversation: vi.fn(async () => ok(undefined)),
    ...extra,
  });
  return client;
}
const resumed = (placement: PlacementOutcome | null, conversation = makeConversation("c1", "p1")) =>
  clientWith({
    listConversations: resumedList,
    getConversation: vi.fn(async () => ok(conversation)),
    ...(placement ? { findPlacement: vi.fn(async () => ok(placement)) } : {}),
  });

function setup(client: ApiClient, extra: Partial<AssistantPanelProps> = {}) {
  const props: AssistantPanelProps = {
    client, projects: [alfa], initialProjectId: "p1", tickets, expanded: true, resume: true, onCollapse: vi.fn(), onProgress: vi.fn(), onCreated: vi.fn(), onManualCreate: vi.fn(),
    onDraftChange: vi.fn(), onChanged: vi.fn(), registerPicker: vi.fn(), ...extra,
  };
  const view = render(<AssistantPanel {...props} />);
  return { props, ...view };
}
const projectNode = (id: string): MapNode => ({ id, parentId: "org", kind: "project", label: id, color: "#fff", key: id, ticket: null, leafCount: 1 });

const TEXT = {
  en: {
    panel: "New ticket with the assistant", title: "New ticket", subtitle: "The assistant knows the tree and remembers earlier conversations", collapse: "Collapse",
    which: "Which project?", loading: "Loading the conversation…",
    hint: "Describe the task. The assistant asks what is missing, writes the ticket and looks for its place in the tree.",
    message: "Message to the assistant", placeholder: "Describe the task or reply to the assistant", send: "Send", reply: "Assistant reply",
    waiting: "The assistant is replying…", retry: "Try again", manual: "Create manually", newConversation: "New conversation", deleteConversation: "Delete conversation",
    draftRegion: "Ticket draft", draft: "Draft", titleField: "Title", description: "Description",
    searching: "Looking for the place… the first search in a project can take a while.", notReady: "The AI still has a question before looking for the place.",
    save: "Save draft", find: "Find the place", anyway: "Search anyway", again: "Search again",
    scope: "Inside ALFA-1", removeScope: "Remove the scope", whole: "Search the whole project",
    over: "The message is over 4,000 characters (4001). Shorten it to send.", within: "3600 of 4,000 characters",
    path: "Path found", pathTitle: "Path, from top to bottom", root: "Project root", newTicket: "New ticket: Corrigir o login", enters: "Goes here, as a child of the previous step.",
    proposalLine: "This ticket seems to form a group with others here.", proposalList: "Tickets that go to the new parent ticket", createGroup: "Create parent ticket and move",
    outOfScope: "This ticket may not fit in “Acesso”.",
    uncertain: "I'm not sure about the place: more than one ticket fits. Choose one of the options below, go up a level or use “Choose on the map”.",
    tooLarge: "The search stopped at “Acesso” because there were too many tickets to compare at once. Check whether the place works or choose another.",
    maxLevels: "The search stopped at “Acesso” on reaching the level limit. Check whether the place works or choose another.",
    others: "Other possible places", use: "Use: Relatórios", reopen: "“ALFA-1” is done and goes back to \"To do\" when it receives this ticket.",
    choosing: "Click a ticket or the project on the map. Esc cancels.", pickNotice: "This conversation is about project Projeto Alfa. Click a ticket or the project itself.",
    create: "Create here", up: "Up one level", choose: "Choose on the map", cancelChoose: "Cancel choosing", unavailable: "The assistant did not respond.",
  },
  "es-MX": {
    panel: "Nuevo ticket con el asistente", title: "Nuevo ticket", subtitle: "El asistente conoce el árbol y recuerda las conversaciones anteriores", collapse: "Contraer",
    which: "¿En qué proyecto?", loading: "Cargando la conversación…",
    hint: "Describe la tarea. El asistente pregunta lo que falte, escribe el ticket y busca su lugar en el árbol.",
    message: "Mensaje para el asistente", placeholder: "Describe la tarea o responde al asistente", send: "Enviar", reply: "Respuesta del asistente",
    waiting: "El asistente está respondiendo…", retry: "Intentar de nuevo", manual: "Crear manualmente", newConversation: "Nueva conversación", deleteConversation: "Eliminar conversación",
    draftRegion: "Borrador del ticket", draft: "Borrador", titleField: "Título", description: "Descripción",
    searching: "Buscando el lugar… la primera búsqueda en un proyecto puede tardar.", notReady: "La IA aún tiene una pregunta antes de buscar el lugar.",
    save: "Guardar borrador", find: "Buscar el lugar", anyway: "Buscar de todos modos", again: "Buscar de nuevo",
    scope: "Dentro de ALFA-1", removeScope: "Quitar el alcance", whole: "Buscar en todo el proyecto",
    over: "El mensaje pasó de 4,000 caracteres (4001). Acórtalo para enviarlo.", within: "3600 de 4,000 caracteres",
    path: "Ruta encontrada", pathTitle: "Ruta, de arriba hacia abajo", root: "Raíz del proyecto", newTicket: "Ticket nuevo: Corrigir o login", enters: "Entra aquí, como hijo del paso anterior.",
    proposalLine: "Este ticket parece formar un grupo con otros de aquí.", proposalList: "Tickets que van al ticket padre nuevo", createGroup: "Crear ticket padre y mover",
    outOfScope: "Este ticket quizá no quepa en «Acesso».",
    uncertain: "No estoy seguro del lugar: sirve más de un ticket. Elige una de las opciones de abajo, sube un nivel o usa «Elegir en el mapa».",
    tooLarge: "La búsqueda se detuvo en «Acesso» porque había demasiados tickets para comparar a la vez. Revisa si el lugar sirve o elige otro.",
    maxLevels: "La búsqueda se detuvo en «Acesso» al llegar al límite de niveles. Revisa si el lugar sirve o elige otro.",
    others: "Otros lugares posibles", use: "Usar: Relatórios", reopen: "«ALFA-1» está terminado y vuelve a \"Por hacer\" al recibir este ticket.",
    choosing: "Haz clic en un ticket o en el proyecto, en el mapa. Esc cancela.", pickNotice: "Esta conversación es del proyecto Projeto Alfa. Haz clic en un ticket o en el propio proyecto.",
    create: "Crear aquí", up: "Subir un nivel", choose: "Elegir en el mapa", cancelChoose: "Cancelar elección", unavailable: "El asistente no respondió.",
  },
} as const;

describe.each(["en", "es-MX"] as const)("assistant panel in %s", (language) => {
  const text = TEXT[language];
  // A folha é a região da conversa; o nome do projeto e as ações ficam na linha de cima da barra, ao lado dela.
  const panel = () => screen.getByRole("region", { name: text.panel }).closest<HTMLElement>(".assistant-sheet")!;
  const card = () => screen.getByRole("region", { name: text.path });
  const find = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

  it("translates the empty state and the header", async () => {
    await setTestLanguage(language);
    setup(clientWith());
    expect(await screen.findByText(text.hint)).toBeInTheDocument();
    expect(within(panel()).getByRole("heading", { level: 2, name: text.title })).toBeInTheDocument();
    expect(panel()).toHaveTextContent("ALFA · Projeto Alfa");
    expect(screen.getByRole("button", { name: text.collapse })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: text.message })).toHaveAttribute("placeholder", text.placeholder);
    expect(screen.getByRole("button", { name: text.send })).toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("translates the header while no project is chosen, the project question and the loading", async () => {
    await setTestLanguage(language);
    setup(clientWith(), { projects: [alfa, beta], initialProjectId: null });
    expect(screen.getByRole("heading", { level: 3, name: text.which })).toBeInTheDocument();
    expect(panel()).toHaveTextContent(text.subtitle);
    await userEvent.click(screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }));
    expect(await screen.findByText(text.hint)).toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("shows the loading line while the conversation is fetched", async () => {
    await setTestLanguage(language);
    let release: () => void = () => undefined;
    setup(clientWith({ listConversations: vi.fn(() => new Promise((resolve) => { release = () => resolve(ok([])); })) }));
    expect(screen.getByRole("status")).toHaveTextContent(text.loading);
    await act(async () => release());
    expect(await screen.findByText(text.hint)).toBeInTheDocument();
  });

  it("translates a conversation with a draft; the AI text and the draft come as they arrived", async () => {
    await setTestLanguage(language);
    setup(resumed(null));
    expect(await screen.findByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument();
    const draft = screen.getByRole("region", { name: text.draftRegion });
    expect(within(draft).getByRole("heading", { name: text.draft })).toBeInTheDocument();
    expect(within(draft).getByRole("textbox", { name: text.titleField })).toHaveValue("Corrigir o login");
    expect(within(draft).getByRole("textbox", { name: text.description })).toHaveTextContent("O login falha no Safari.");
    expect(screen.getByRole("button", { name: text.find })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.newConversation })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.deleteConversation })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: text.reply })).toBeInTheDocument();
    await userEvent.type(within(draft).getByRole("textbox", { name: text.titleField }), "!");
    expect(screen.getByRole("button", { name: text.save })).toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("translates the not-ready state, the search in progress and Search anyway", async () => {
    await setTestLanguage(language);
    let release: (value: unknown) => void = () => undefined;
    const client = resumed(null, makeConversation("c1", "p1", { ready: false }));
    client.findPlacement = vi.fn(() => new Promise((resolve) => { release = resolve; })) as ApiClient["findPlacement"];
    setup(client);
    expect(await screen.findByText(text.notReady)).toBeInTheDocument();
    await find(text.anyway);
    expect(await screen.findByText(text.searching)).toBeInTheDocument();
    await act(async () => release(ok(makePlacement({ destination: target("t2") }))));
    expect(await screen.findByRole("button", { name: text.again })).toBeInTheDocument();
    expect(screen.queryByText(text.notReady)).not.toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("translates the sending state and the character counter", async () => {
    await setTestLanguage(language);
    setup(clientWith({ openConversation: vi.fn(() => new Promise(() => undefined)) }));
    const box = await screen.findByRole("textbox", { name: text.message });
    await userEvent.type(box, "Oi{Enter}");
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(text.waiting);
  });

  it("translates the counter near the limit and over it", async () => {
    await setTestLanguage(language);
    setup(clientWith());
    const box = await screen.findByRole("textbox", { name: text.message });
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(box, "a".repeat(3600));
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(panel()).toHaveTextContent(text.within);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(box, "a".repeat(4001));
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(panel()).toHaveTextContent(text.over);
  });

  it("translates the path found, with the ticket of the draft and the destination", async () => {
    await setTestLanguage(language);
    setup(resumed(makePlacement({ destination: target("t2"), alternatives: [target("t4")] })));
    await find(text.find);
    const path = await screen.findByRole("region", { name: text.path });
    expect(within(path).getByRole("heading", { name: text.pathTitle })).toBeInTheDocument();
    expect(path).toHaveTextContent(text.newTicket);
    expect(path).toHaveTextContent(text.enters);
    expect(path).toHaveTextContent(text.others);
    expect(within(path).getByRole("button", { name: text.use })).toBeInTheDocument();
    expect(within(path).getByRole("button", { name: text.create })).toBeInTheDocument();
    expect(within(path).getByRole("button", { name: text.up })).toBeInTheDocument();
    expect(within(path).getByRole("button", { name: text.choose })).toBeInTheDocument();
    expect(path).toHaveTextContent("Login");
    expectNoPortuguese(panel(), language);
  });

  it("names the project root", async () => {
    await setTestLanguage(language);
    setup(resumed(makePlacement({ destination: { parentId: null, path: [] }, alternatives: [target("t4")] })));
    await find(text.find);
    expect(await screen.findByRole("region", { name: text.path })).toHaveTextContent(text.root);
    await userEvent.click(within(card()).getByRole("button", { name: /^(Use|Usar): / }));
    expect(card()).toHaveTextContent("Relatórios");
    await userEvent.click(within(card()).getByRole("button", { name: text.up }));
    expect(card()).toHaveTextContent(text.root);
    expectNoPortuguese(panel(), language);
  });

  it("translates the warning about a concluded destination that reopens", async () => {
    await setTestLanguage(language);
    setup(resumed(makePlacement({ destination: target("t1") })));
    await find(text.find);
    expect(await screen.findByText(text.reopen)).toBeInTheDocument();
  });

  it("translates the proposal of a new parent ticket; its title, description and tickets come as they arrived", async () => {
    await setTestLanguage(language);
    const proposal = { title: "Redefinição de senha", description: "Fluxos de senha esquecida.", tickets: [{ id: "t3", number: 3, title: "Senha esquecida" }, { id: "t5", number: 5, title: "Reset por SMS" }] };
    setup(resumed(makePlacement({ destination: target("t2"), groupProposal: proposal })));
    await find(text.find);
    const path = await screen.findByRole("region", { name: text.path });
    expect(path).toHaveTextContent(text.proposalLine);
    expect(path).toHaveTextContent("Redefinição de senha");
    expect(within(path).getByRole("list", { name: text.proposalList })).toBeInTheDocument();
    expect(within(path).getByRole("button", { name: text.createGroup })).toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("translates the scope chip and the out-of-scope warning", async () => {
    await setTestLanguage(language);
    setup(resumed(makePlacement({ destination: target("t2"), scope: { id: "t1", title: "Acesso", outOfScope: true } })), { initialScopeId: "t1" });
    expect(await screen.findByText(text.scope)).toBeInTheDocument();
    await find(text.find);
    const path = await screen.findByRole("region", { name: text.path });
    expect(path).toHaveTextContent(text.outOfScope);
    expect(within(path).getByRole("button", { name: text.whole })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.removeScope })).toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("translates the uncertain warning", async () => {
    await setTestLanguage(language);
    setup(resumed(makePlacement({ destination: target("t2"), alternatives: [target("t4")], uncertain: true })));
    await find(text.find);
    expect(await screen.findByText(text.uncertain)).toBeInTheDocument();
  });

  it.each([
    ["candidates_too_large", "tooLarge"],
    ["max_levels", "maxLevels"],
  ] as const)("translates the early stop %s", async (reason, key) => {
    await setTestLanguage(language);
    setup(resumed(makePlacement({ destination: target("t2"), stoppedEarly: { reason, level: 2, parentId: "t1" } })));
    await find(text.find);
    expect(await screen.findByText(text[key])).toBeInTheDocument();
  });

  it("translates Choose on the map, its instruction, the refusal and the cancel button", async () => {
    await setTestLanguage(language);
    const { props } = setup(resumed(makePlacement({ destination: target("t2") })));
    await find(text.find);
    await find(text.choose);
    expect(await screen.findByText(text.choosing)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.cancelChoose })).toBeInTheDocument();
    const picker = vi.mocked(props.registerPicker).mock.calls.filter(([entry]) => entry !== null).at(-1)![0] as MapPicker;
    act(() => picker.pick(projectNode("p9")));
    expect(await screen.findByRole("alert")).toHaveTextContent(text.pickNotice);
    // Escolhendo, a região da folha se recolhe e a instrução ocupa a linha de cima.
    expectNoPortuguese(document.querySelector<HTMLElement>(".assistant-sheet")!, language);
  });

  it("translates a provider error with its two ways out", async () => {
    await setTestLanguage(language);
    setup(clientWith({ openConversation: vi.fn(async () => failed("unavailable", "assistant_unavailable")) }));
    await userEvent.type(await screen.findByRole("textbox", { name: text.message }), "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(text.unavailable);
    expect(screen.getByRole("button", { name: text.retry })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.manual })).toBeInTheDocument();
    expectNoPortuguese(panel(), language);
  });

  it("follows a language change with the panel open", async () => {
    setup(resumed(makePlacement({ destination: target("t2") })));
    await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    expect(await screen.findByRole("region", { name: "Caminho encontrado" })).toBeInTheDocument();
    await setTestLanguage(language);
    await waitFor(() => expect(screen.getByRole("region", { name: text.path })).toBeInTheDocument());
    expect(panel()).toHaveTextContent(text.title);
    expect(screen.getByRole("textbox", { name: text.message })).toHaveAttribute("placeholder", text.placeholder);
    expectNoPortuguese(panel(), language);
    await setTestLanguage("pt-BR");
    expect(await screen.findByRole("region", { name: "Caminho encontrado" })).toBeInTheDocument();
    expect(i18n.language).toBe("pt-BR");
  });
});

const DEMO = {
  en: { canvas: "Spatial navigation demo", toolbar: "Camera and colors", zoomOut: "Zoom out", reset: "Reset view", zoomIn: "Zoom in", colors: "Colors", help: "Wheel to zoom · drag to pan · combine both · click to select · Explore branch to focus · C colors · Esc clear", root: "Constellation", path: "Focus path", metrics: /on stage · 1001 local nodes/, selected: "Selected node", close: "Close selection", explore: "Explore branch", meta: /6 children · 1000 descendants · level 0/ },
  "es-MX": { canvas: "Demostración de navegación espacial", toolbar: "Cámara y colores", zoomOut: "Alejar", reset: "Restablecer encuadre", zoomIn: "Acercar", colors: "Colores", help: "Rueda para acercar · arrastra para desplazar · combina ambos · clic para seleccionar · Explorar rama para enfocar · C colores · Esc limpiar", root: "Constelación", path: "Ruta del enfoque", metrics: /en escena · 1001 nodos locales/, selected: "Nodo seleccionado", close: "Cerrar selección", explore: "Explorar rama", meta: /6 hijos · 1000 descendientes · nivel 0/ },
} as const;

describe.each(["en", "es-MX"] as const)("demo in %s", (language) => {
  const text = DEMO[language];

  it("translates the canvas labels, the breadcrumb, the metrics, the help bar and the demo data", async () => {
    await setTestLanguage(language);
    const { container } = render(<Demo />);
    expect(screen.getByRole("region", { name: text.canvas })).toBeInTheDocument();
    const toolbar = screen.getByRole("toolbar", { name: text.toolbar });
    for (const name of [text.zoomOut, text.reset, text.zoomIn, text.colors]) expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: text.path })).toHaveTextContent(text.root);
    expect(container).toHaveTextContent(text.metrics);
    expect(container).toHaveTextContent(text.help);
    expectNoPortuguese(container, language);
  });

  it("translates the selection card", async () => {
    await setTestLanguage(language);
    const { container } = render(<Demo />);
    await userEvent.click(screen.getAllByRole("button", { name: new RegExp(`node-0000 · ${text.root}`) })[0]!);
    const selection = await screen.findByRole("complementary", { name: text.selected });
    expect(within(selection).getByRole("button", { name: text.close })).toBeInTheDocument();
    expect(within(selection).getByRole("button", { name: text.explore })).toBeInTheDocument();
    expect(selection).toHaveTextContent(text.meta);
    expectNoPortuguese(container, language);
  });
});

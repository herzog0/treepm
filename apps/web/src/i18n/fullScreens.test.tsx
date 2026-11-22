import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, PlacementOutcome, Project, TicketDetail, TicketSummary } from "../api/client.js";
import { AssistantPanel } from "../assistant/AssistantPanel.js";
import { Demo } from "../demo/Demo.js";
import { GithubCallback } from "../github/GithubCallback.js";
import { ImportScreen } from "../import/ImportScreen.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe, makePerson as makePanelPerson } from "../panel/testing.js";
import { SettingsScreen } from "../settings/SettingsScreen.js";
import { TeamsScreen } from "../teams/TeamsScreen.js";
import { TicketPage } from "../ticket/TicketPage.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import {
  makeClient, makeCodeLink, makeConversation, makeGithubRepository, makeInstallation, makePlacement, makeProject, makeTicket, ok,
} from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import type { Language } from "./languages.js";
import { resources } from "./resources.js";

/**
 * Telas inteiras por idioma (ADR 0035): renderiza as telas principais com o cliente falso em `en` e em `es-MX` e falha se
 * sobrar qualquer palavra que só existe no português dos catálogos. Os dados falsos usam palavras neutras (nomes próprios e
 * termos iguais nos três idiomas) para que o conteúdo vindo "da API" não seja confundido com texto da interface.
 */

const WORD = /[\p{L}]+/gu;
const NAMESPACES = Object.keys(resources["pt-BR"]) as (keyof (typeof resources)["pt-BR"])[];

const tokens = (text: string): string[] => (text.replace(/\{\{[^}]*\}\}/g, " ").replace(/<[^>]*>/g, " ").match(WORD) ?? []).map((word) => word.toLowerCase());

function leaves(value: unknown, path: string, out: Map<string, string>) {
  if (typeof value === "string") out.set(path, value);
  else if (typeof value === "object" && value !== null) for (const [key, child] of Object.entries(value)) leaves(child, `${path}.${key}`, out);
}
function catalog(language: Language): Map<string, string> {
  const out = new Map<string, string>();
  for (const namespace of NAMESPACES) leaves(resources[language][namespace], namespace, out);
  return out;
}

/** Palavras (4+ letras) do catálogo `pt-BR` que não aparecem no texto correspondente de `en` nem de `es-MX`, nem em nenhum outro texto desses dois. */
function portugueseOnlyWords(): Set<string> {
  const pt = catalog("pt-BR");
  const en = catalog("en");
  const es = catalog("es-MX");
  const foreign = new Set<string>();
  for (const text of [...en.values(), ...es.values()]) for (const word of tokens(text)) foreign.add(word);
  const only = new Set<string>();
  for (const [key, text] of pt) {
    const here = new Set([...tokens(en.get(key) ?? ""), ...tokens(es.get(key) ?? "")]);
    for (const word of tokens(text)) if (word.length >= 4 && !here.has(word) && !foreign.has(word)) only.add(word);
  }
  return only;
}
const PORTUGUESE_ONLY = portugueseOnlyWords();

/** Tudo o que a pessoa vê ou ouve: o texto, os atributos de acessibilidade e o título da aba. */
function visibleText(root: HTMLElement): string {
  const attributes = [...root.querySelectorAll("[aria-label],[title],[placeholder],[alt]")]
    .map((element) => ["aria-label", "title", "placeholder", "alt"].map((attribute) => element.getAttribute(attribute) ?? "").join(" "))
    .join("\n");
  const fields = [...root.querySelectorAll("input,textarea")].map((element) => (element as HTMLInputElement).placeholder ?? "").join("\n");
  return `${root.textContent ?? ""}\n${attributes}\n${fields}\n${document.title}`;
}

function expectNoPortuguese(screenName: string, root: HTMLElement = document.body) {
  const left = [...new Set(tokens(visibleText(root)))].filter((word) => PORTUGUESE_ONLY.has(word));
  expect(left, `${screenName}: Portuguese words left on screen`).toEqual([]);
}

// ---- dados falsos, em palavras neutras ----

const alpha = makeProject("p1", "ALFA", "Alpha");
const project2 = makeProject("p2", "BETA", "Beta");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Login flow", { key: "ALFA-1", status: "in_review", progress: { done: 1, total: 3, excluded: 1 }, assigneeIds: ["person-1"] }),
  makeTicket("t2", "p1", 2, "Form", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Tests", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Reports", { key: "ALFA-4", status: "done", progress: { done: 1, total: 1, excluded: 0 } }),
];
const people = [makePanelPerson("person-1", "Ana"), makePanelPerson("person-2", "Bruno")];
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Sample text", mentionedBy: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
const byAi = { text: "Sample summary.", source: "assistant" as const, updatedAt: "2026-11-20T12:00:00.000Z" };
const admin = (extra: Partial<Me> = {}): Me => ({ ...makePanelMe("admin"), assistant: { enabled: true }, github: { enabled: true }, ...extra });

const treepm = makeGithubRepository(1, "herzog0/treepm");
const linkedRepo = { ...treepm, id: "link-1", linkedAt: "2026-11-20T12:00:00.000Z" };

function appClient(me: Me = admin()): ApiClient {
  const links = [makeCodeLink("l1", { id: "t2", key: "ALFA-2", title: "Form" }, { state: "open" }), makeCodeLink("l2", { id: "t2", key: "ALFA-2", title: "Form" }, { number: 9, title: "Second", state: "merged" })];
  const client = makeClient({
    me, projects: [alpha, project2], people, tickets: { p1: summaries, p2: [] }, summaries: { texts: { t1: byAi } },
    areas: [{ id: "a1", name: "Design" }],
    github: { installation: makeInstallation(), repositories: [treepm], linked: { p1: [linkedRepo] }, code: { t1: { links, syncedAt: "2026-11-21T11:57:00.000Z" } } },
  });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1", { messages: [
      { id: "m1", author: "person", body: "Login breaks", model: null, createdAt: "2026-11-20T10:00:00.000Z" },
      { id: "m2", author: "assistant", body: "Does it break in every browser?", model: "model", createdAt: "2026-11-20T10:00:05.000Z" },
    ], draft: { title: "Fix login", description: "Login fails." } }), messages: undefined }])),
    getConversation: vi.fn(async () => ok(makeConversation("c1", "p1", { draft: { title: "Fix login", description: "Login fails." }, messages: [
      { id: "m1", author: "person", body: "Login breaks", model: null, createdAt: "2026-11-20T10:00:00.000Z" },
      { id: "m2", author: "assistant", body: "Does it break in every browser?", model: "model", createdAt: "2026-11-20T10:00:05.000Z" },
    ] }))),
  });
  return client;
}

const target = (...ids: string[]) => ({ parentId: ids.at(-1) ?? null, path: ids.map((id) => ({ id, title: summaries.find((t) => t.id === id)!.title })) });

const proposal = { title: "Password reset", description: "Forgotten password and reset flows.", tickets: [{ id: "t2", number: 2, title: "Form" }, { id: "t3", number: 3, title: "Tests" }] };

describe.each(["en", "es-MX"] as const)("full screens in %s", (language) => {
  it("has a Portuguese word list to look for", () => {
    expect(PORTUGUESE_ONLY.size).toBeGreaterThan(200);
    for (const word of ["projeto", "conversa", "carregando"]) expect(PORTUGUESE_ONLY.has(word), word).toBe(true);
    for (const word of ["ticket", "mapa", "para"]) expect(PORTUGUESE_ONLY.has(word), word).toBe(false);
  });

  it("map with the side panel open", async () => {
    await setTestLanguage(language);
    const toggle = resources[language].map.panelToggle;
    render(<OrganizationMap client={appClient()} me={admin()} />);
    await screen.findByRole("button", { name: /ALFA · Alpha/ });
    await userEvent.click(screen.getByRole("button", { name: toggle }));
    await screen.findByRole("tablist");
    await userEvent.click(await screen.findByRole("tab", { name: resources[language].panel.panel.tabs.projects }));
    await screen.findAllByText("Alpha");
    expectNoPortuguese("map + side panel");
  });

  it("map with the request bar and its results sheet", async () => {
    await setTestLanguage(language);
    const { container } = render(<OrganizationMap client={appClient()} me={admin()} />);
    const field = await screen.findByRole("combobox", { name: resources[language].command.bar.input });
    await userEvent.click(field);
    await userEvent.type(field, "Login");
    await screen.findByRole("listbox", { name: resources[language].command.sheet.label });
    expectNoPortuguese("map + request bar", container);
  });

  it("ticket page with items, summary and code", async () => {
    await setTestLanguage(language);
    const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
    const { container } = render(<TicketPage client={appClient()} me={admin()} projects={[alpha as Project]} ticketId="t1" creating={null} {...handlers} />);
    await screen.findByText("Login flow");
    await screen.findByText("Sample summary.");
    await waitFor(() => expect(container.querySelector(".ticket-code, [class*=code]") ?? container).toBeTruthy());
    expectNoPortuguese("ticket page", container);
  });

  it("new manual ticket", async () => {
    await setTestLanguage(language);
    const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
    const { container } = render(<TicketPage client={appClient()} me={admin()} projects={[alpha as Project]} ticketId={null} creating={{ projectId: "p1", parentId: "t1" }} {...handlers} />);
    await screen.findAllByRole("textbox");
    expectNoPortuguese("new manual ticket", container);
  });

  it("assistant panel with the path and the proposal of a parent ticket", async () => {
    await setTestLanguage(language);
    const client = appClient();
    client.findPlacement = vi.fn(async () => ok(makePlacement({ destination: target("t4"), alternatives: [target("t1")], uncertain: true, groupProposal: proposal, scope: { id: "t1", title: "Login flow", outOfScope: true }, stoppedEarly: { reason: "max_levels", level: 2, parentId: "t1" } }) as PlacementOutcome));
    const { container } = render(
      <AssistantPanel client={client} projects={[alpha]} initialProjectId="p1" initialScopeId="t1" tickets={{ p1: summaries }} expanded resume onCollapse={vi.fn()} onProgress={vi.fn()} onCreated={vi.fn()} onManualCreate={vi.fn()} onDraftChange={vi.fn()} onChanged={vi.fn()} registerPicker={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: resources[language].assistant.draft.search }));
    await screen.findByRole("region", { name: resources[language].assistant.path.region });
    await userEvent.click(screen.getByRole("button", { name: resources[language].assistant.pick.choose }));
    expectNoPortuguese("assistant panel", container);
  });

  it("import with the preview, its warnings and its errors", async () => {
    await setTestLanguage(language);
    const client = appClient();
    const { container } = render(<ImportScreen client={client} me={admin()} projectId="p1" onExit={vi.fn()} />);
    const box = await screen.findByRole("textbox");
    fireEvent.change(box, { target: { value: "- Parent\n  - [x] Child\n- [~] Another\nloose line" } });
    await screen.findByRole("list", { name: resources[language].import.preview.errors });
    expectNoPortuguese("import with errors", container);
    fireEvent.change(box, { target: { value: "- [ ] Parent\n  - [x] Child\n- Another" } });
    await screen.findByRole("list", { name: resources[language].import.preview.warnings });
    expectNoPortuguese("import with the preview", container);
  });

  it("teams", async () => {
    await setTestLanguage(language);
    const teams = [{ id: "t-alfa", name: "Alfa", members: [{ personId: "person-1", role: "admin" as const }, { personId: "person-2", role: "member" as const }] }];
    const client = { ...makeClient({ me: admin() }), listTeams: vi.fn(async () => ok(structuredClone(teams))), listPeople: vi.fn(async () => ok(people)) } as ApiClient;
    const { container } = render(<TeamsScreen client={client} me={admin()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Alfa/ }));
    await screen.findAllByRole("region");
    expectNoPortuguese("teams", container);
  });

  it("settings with the GitHub section", async () => {
    await setTestLanguage(language);
    const me = admin();
    const { container } = render(<MemoryPreferencesProvider><SettingsScreen client={appClient(me)} me={me} /></MemoryPreferencesProvider>);
    await screen.findByText(/herzog0/);
    expectNoPortuguese("settings", container);
  });

  it.each([["?setup_action=request"], ["?code=&state="]])("GitHub return screen %s", async (search) => {
    await setTestLanguage(language);
    window.history.replaceState(null, "", `/github/callback${search}`);
    const { container } = render(<GithubCallback client={appClient()} onOpenSettings={vi.fn()} />);
    await screen.findByRole("button");
    expectNoPortuguese("GitHub return", container);
    window.history.replaceState(null, "", "/");
  });

  it("demo", async () => {
    await setTestLanguage(language);
    const { container } = render(<Demo />);
    await act(async () => undefined);
    expectNoPortuguese("demo", container);
  });
});

describe("the check itself", () => {
  it("catches Portuguese left on screen", async () => {
    await setTestLanguage("en");
    const { container } = render(<p>Carregando a conversa do projeto</p>);
    expect(() => expectNoPortuguese("probe", container)).toThrow(/Portuguese words left/);
  });

  it("does not take the content of the data for interface text", async () => {
    await setTestLanguage("en");
    const { container } = render(<p>Login flow · Alpha · herzog0/treepm</p>);
    expect(() => expectNoPortuguese("probe", container)).not.toThrow();
  });
});

void within;

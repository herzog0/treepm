import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { Workspace } from "../Workspace.js";

const SLOW = 8000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login com Google", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", descriptionExcerpt: "Depois do login" }),
  ],
  p2: [makeTicket("t4", "p2", 1, "Login de teste", { key: "BETA-1", status: "done" })],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const adminMe = () => withAssistant(makePanelMe("admin"));

function makeFullClient(extra: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const client = makeClient({ projects, tickets, people: [makePerson("person-1", "Ana")] });
  const all = Object.values(tickets).flat();
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(all.find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c1", projectId))),
    findPlacement: vi.fn(async () => ok(makePlacement())),
    ...extra,
  });
  return client;
}

function Host({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const bar = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" });
const zone = () => document.querySelector<HTMLElement>(".command-zone")!;
async function typed(text: string) {
  const field = await bar();
  await userEvent.click(field);
  await userEvent.type(field, text);
  return field;
}
const optionNames = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");

describe("the request bar", () => {
  it("is on the map with the placeholder, an accessible name and the Ctrl K hint", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await bar();
    expect(field).toHaveAttribute("placeholder", "Peça qualquer coisa");
    expect(field).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region", { name: "Barra de pedidos" })).toHaveTextContent("Ctrl K");
  });

  it("is not on the teams or settings screens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === "/api/me") return Response.json({ person: { id: "p", displayName: "Ana", email: "a@x.com", avatarUrl: null }, organization: { orgId: "org-1", name: "Org", slug: "o" }, roles: { clerk: "admin", teams: [], projects: [] } });
      if (input === "/api/projects" || input === "/api/people") return Response.json([]);
      return Response.json([]);
    });
    const getToken = async () => "t";
    const { rerender } = render(<Workspace orgId="org-1" view="map" getToken={getToken} fetch={fetchImpl} />);
    expect(await bar()).toBeInTheDocument();
    rerender(<Workspace orgId="org-1" view="teams" getToken={getToken} fetch={fetchImpl} />);
    await screen.findByRole("heading", { name: "Times", level: 1 });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    rerender(<Workspace orgId="org-1" view="settings" getToken={getToken} fetch={fetchImpl} />);
    await screen.findByRole("heading", { name: "Configurações", level: 1 });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("the results sheet", () => {
  it("opens under the field with the tickets found, marker, key, title and state, and the first one highlighted", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await typed("login");
    expect(field).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox", { name: "Resultados" });
    expect(field).toHaveAttribute("aria-controls", list.id);
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveTextContent("ALFA-2");
    expect(options[0]).toHaveTextContent("Login com Google");
    expect(options[0]).toHaveTextContent("Em andamento");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(field).toHaveAttribute("aria-activedescendant", options[0]!.id);
    expect(within(list).getByRole("group", { name: "Tickets" })).toBeInTheDocument();
    expect(within(list).getByRole("group", { name: "Ações" })).toBeInTheDocument();
    expect(screen.getByText("↑ ↓ navegar")).toBeInTheDocument();
  }, SLOW);

  it("shows the progress when the ticket has open descendants, and finds by key and by number", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await typed("alfa-1");
    expect(optionNames()[0]).toContain("0 de 1 concluídos");
    await userEvent.clear(field);
    await userEvent.type(field, "1");
    expect(optionNames().filter((name) => /ALFA-1|BETA-1/.test(name))).toHaveLength(2);
  }, SLOW);

  it("moves the highlight with the arrows and keeps aria-activedescendant in step", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await typed("login");
    const options = screen.getAllByRole("option");
    await userEvent.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(field).toHaveAttribute("aria-activedescendant", options[1]!.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
  }, SLOW);

  it("Enter opens the highlighted ticket, folds the sheet and clears the field", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={adminMe()} onChange={onChange} />);
    const field = await typed("login");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("t4");
    expect(field).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveAttribute("aria-expanded", "false");
  }, SLOW);

  it("clicking a ticket opens it the same way", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={adminMe()} onChange={onChange} />);
    await typed("publicar");
    await userEvent.click(screen.getByRole("option", { name: /ALFA-3/ }));
    expect(onChange).toHaveBeenCalledWith("t3");
  }, SLOW);

  it("finds a ticket by the description excerpt", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await typed("depois do");
    expect(optionNames()[0]).toContain("ALFA-3");
  }, SLOW);
});

describe("keyboard", () => {
  it("Ctrl+K and Cmd+K focus the bar from anywhere on the map and stop the browser default", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await bar();
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      (document.activeElement as HTMLElement).blur();
      // O ouvinte de teclado é registrado por um efeito, que pode rodar depois de a barra aparecer na tela: repete a tecla até
      // ele existir, em vez de afirmar na hora (um evento já despachado sem ouvinte não volta).
      await waitFor(() => {
        const event = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...init });
        act(() => { document.body.dispatchEvent(event); });
        expect(event.defaultPrevented).toBe(true);
      });
      await waitFor(() => expect(field).toHaveFocus());
    }
  });

  it("Ctrl+K works with the ticket page open", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={adminMe()} onChange={onChange} />);
    const field = await typed("publicar");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.querySelector(".has-ticket-page")).not.toBeNull());
    (document.activeElement as HTMLElement).blur();
    await waitFor(() => {
      act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })); });
      expect(field).toHaveFocus();
    });
  }, SLOW);

  it("with the focus in the bar, an empty Enter opens nothing, Esc does not clear the selection on the map and c is just a letter", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={adminMe()} onChange={onChange} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    expect(screen.getByRole("complementary", { name: "Nó selecionado" })).toBeInTheDocument();
    const field = await bar();
    await userEvent.click(field);
    const toggle = screen.getByRole("button", { name: "Cores" });
    const before = toggle.getAttribute("aria-pressed");
    await userEvent.keyboard("c");
    expect(field).toHaveValue("c");
    expect(toggle.getAttribute("aria-pressed")).toBe(before);
    await userEvent.clear(field);
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { name: "Nó selecionado" })).toBeInTheDocument();
  }, SLOW);

  it("Esc with the sheet open folds it, clears the field and hands the focus back to the map stage", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await typed("login");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(document.activeElement).toBe(document.querySelector(".spatial-stage"));
  }, SLOW);

  it("Esc with the focus in the empty bar also hands the focus back to the map", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await bar();
    await userEvent.click(field);
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(document.querySelector(".spatial-stage"));
  }, SLOW);

  it("Esc first cancels a pending choice on the map, then folds the conversation sheet, and only then the results sheet", async () => {
    const only = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));
    render(<Host client={makeFullClient()} me={only} />);
    await userEvent.click(await bar());
    await userEvent.click(await screen.findByRole("option", { name: /Nova conversa/ }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "O login quebra{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
    expect(screen.getByText(/Clique em um ticket ou no projeto, no mapa/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(/Clique em um ticket ou no projeto, no mapa/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Novo ticket com o assistente" })).not.toBeInTheDocument();
    const field = await typed("login");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveValue("");
  }, SLOW);

  it("Esc with nothing of the bar in play still closes the ticket page", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={adminMe()} onChange={onChange} />);
    await typed("publicar");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("t3"));
    await waitFor(() => expect(document.querySelector(".has-ticket-page")).not.toBeNull());
    // O ouvinte do Esc é registrado por um efeito da página do ticket: repete a tecla até ele responder.
    await waitFor(() => {
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onChange).toHaveBeenLastCalledWith(null);
    });
  }, SLOW);
});

describe("the create action", () => {
  it("is offered, with its shortcut, when the person can create", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await typed("exportar csv");
    const action = screen.getByRole("option", { name: /Criar ticket «exportar csv»/ });
    expect(action).toHaveTextContent("Ctrl Enter");
    expect(screen.getByRole("listbox")).toContainElement(action);
  }, SLOW);

  // Com o assistente ligado, quem só lê ainda vê a ação "Perguntar ao assistente" (ADR 0037): ver `OrganizationMap.ask.test.tsx`.
  it("is not offered when the person cannot create in any project, but the search stays", async () => {
    const reader = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }]), false);
    render(<Host client={makeFullClient()} me={reader} />);
    await typed("login");
    expect(screen.queryByRole("option", { name: /Criar ticket/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Ações" })).not.toBeInTheDocument();
    expect(optionNames()[0]).toContain("ALFA-2");
  }, SLOW);

  it("with the assistant on, Ctrl+Enter opens the conversation with the text as the first message", async () => {
    const client = makeFullClient();
    const only = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));
    render(<Host client={client} me={only} />);
    const field = await typed("exportar csv");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "exportar csv", scopeId: null }));
    expect(field).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  }, SLOW);

  it("always starts a new conversation, even when an earlier one exists, and sends the text to it", async () => {
    const old = makeConversation("old", "p1");
    const client = makeFullClient({
      listConversations: vi.fn(async () => ok([{ ...old, messages: undefined }])),
      getConversation: vi.fn(async (id: string) => ok(id === "old" ? old : makeConversation(id, "p1"))),
      sendConversationMessage: vi.fn(async () => ok(old)),
      openConversation: vi.fn(async (projectId: string) => ok(makeConversation("new", projectId))),
    });
    const only = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));
    render(<Host client={client} me={only} />);
    await typed("outro assunto");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "outro assunto", scopeId: null }));
    expect(client.sendConversationMessage).not.toHaveBeenCalled();
  }, SLOW);

  it("clicking the action does the same, and the project question comes first when there are several", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={adminMe()} />);
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: /Criar ticket «exportar csv»/ }));
    await userEvent.click(await screen.findByRole("button", { name: "ALFA · Projeto Alfa" }));
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "exportar csv", scopeId: null }));
  }, SLOW);

  it("with the assistant off, opens manual creation with the title filled in", async () => {
    const client = makeFullClient();
    const only = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]), false);
    render(<Host client={client} me={only} />);
    await typed("exportar csv");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(await screen.findByDisplayValue("exportar csv")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Novo ticket com o assistente" })).not.toBeInTheDocument();
  }, SLOW);
});

describe("placement", () => {
  it("tells where the bar sits: free, beside the ticket page, beside the areas panel", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await bar();
    expect(zone()).toHaveAttribute("data-aside", "none");
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    expect(zone()).toHaveAttribute("data-aside", "areas");
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    await userEvent.click(await bar());
    await userEvent.type(await bar(), "publicar{Enter}");
    await waitFor(() => expect(zone()).toHaveAttribute("data-aside", "ticket"));
  }, SLOW);

  it("does not move the camera bar or the selection card", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await bar();
    expect(screen.getByRole("toolbar", { name: "Câmera e cores" }).closest(".command-zone")).toBeNull();
  });
});

describe("other languages", () => {
  it.each([
    ["en", "Request bar", "Ask for anything", "Actions", "Create ticket «export csv»", "↑ ↓ navigate", "In progress"],
    ["es-MX", "Barra de peticiones", "Pide lo que quieras", "Acciones", "Crear ticket «export csv»", "↑ ↓ navegar", "En curso"],
  ] as const)("%s renders the bar and the sheet", async (language, label, placeholder, actions, create, keys, state) => {
    await setTestLanguage(language);
    render(<Host client={makeFullClient()} me={adminMe()} />);
    const field = await screen.findByRole("combobox", { name: placeholder });
    expect(screen.getByRole("region", { name: label })).toBeInTheDocument();
    await userEvent.click(field);
    await userEvent.type(field, "export csv");
    expect(screen.getByRole("group", { name: actions })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: new RegExp(create) })).toBeInTheDocument();
    expect(screen.getByText(keys)).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "google");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(state);
  }, SLOW);
});

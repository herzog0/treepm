import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Prazo dos testes que montam o mapa inteiro: 2-4 s com a máquina em uso normal, e mais de 8 s com ela saturada (TREEPM-101).
const SLOW = 20_000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", status: "todo" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "todo" }),
  ],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const adminMe = () => withAssistant(makePanelMe("admin"));

function makeFullClient(extra: Partial<Record<keyof ApiClient, unknown>> = {}, list = projects): ApiClient {
  const client = makeClient({ projects: list, tickets, people: [makePerson("person-1", "Ana")] });
  const created = makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9", parentId: "t1" });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf([...(tickets.p1 ?? []), created].find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c1", projectId))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] } }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: detailOf(created), children: [], warnings: [] })),
    ...extra,
  });
  return client;
}

function Host({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
/** A conversa começa pela barra (ADR 0036): campo vazio em foco e "Nova conversa". */
async function openFromBar() {
  await userEvent.click(await screen.findByRole("combobox", { name: "Peça qualquer coisa" }));
  await userEvent.click(await screen.findByRole("option", { name: /Nova conversa/ }));
}
const assistant = () => screen.queryByRole("region", { name: "Novo ticket com o assistente" });
const workspace = () => screen.getByRole("region", { name: "Mapa da organização" }).closest(".map-workspace")!;
const offer = async () => { await userEvent.click(await screen.findByRole("combobox", { name: "Peça qualquer coisa" })); };
const message = () => screen.findByRole("textbox", { name: "Mensagem para o assistente" });
/** O nó só aceita clique depois de a câmera terminar de revelá-lo (tabindex 0). */
async function node(name: RegExp) {
  const found = await screen.findByRole("button", { name }, { timeout: SLOW });
  await waitFor(() => expect(found).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
  return found;
}
async function exploreAlfa() {
  await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
  await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
}
/** Abre o painel, conversa uma vez e procura o lugar: o mapa ganha o card tracejado. */
async function placed() {
  await userEvent.type(await message(), "O login quebra{Enter}");
  await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
  await screen.findByRole("region", { name: "Caminho encontrado" });
}

describe("the conversation offer in the bar (it replaces the floating Novo ticket button)", () => {
  it("is offered when the assistant is on and the person can create in a project", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await offer();
    expect(await screen.findByRole("option", { name: /Nova conversa/ })).toBeInTheDocument();
  });

  it("is absent when the API says the assistant is off", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("admin"), false)} />);
    await offer();
    expect(screen.queryByRole("option", { name: /Nova conversa/ })).not.toBeInTheDocument();
  });

  it("is absent when the API has no assistant field (older API)", async () => {
    render(<Host client={makeFullClient()} me={makePanelMe("admin")} />);
    await offer();
    expect(screen.queryByRole("option", { name: /Nova conversa/ })).not.toBeInTheDocument();
  });

  it("is absent when the person cannot create tickets in any non-archived project", async () => {
    const readerOnly = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }]));
    const archived = makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-01-01T00:00:00.000Z" });
    render(<Host client={makeFullClient({}, [projects[0]!, archived])} me={readerOnly} />);
    await offer();
    expect(screen.queryByRole("option", { name: /Nova conversa/ })).not.toBeInTheDocument();
  });

  it("is offered to a contributor of one project", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "contributor" }]))} />);
    await offer();
    expect(await screen.findByRole("option", { name: /Nova conversa/ })).toBeInTheDocument();
  });

  it("no floating button is left on the map, and the first-project button is not there for the people who cannot make one", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await offer();
    expect(screen.queryByRole("button", { name: "Criar primeiro projeto" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".map-new-ticket")).toHaveLength(0);
  });
});

describe("opening the sheet", () => {
  it("goes straight to the conversation when the person can create in a single project", async () => {
    const only = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));
    render(<Host client={makeFullClient()} me={only} />);
    await openFromBar();
    expect(await message()).toBeInTheDocument();
    // O projeto aparece na linha de cima da barra, ao lado da folha.
    expect(screen.getByRole("region", { name: "Barra de pedidos" })).toHaveTextContent("ALFA · Projeto Alfa");
  }, SLOW);

  it("asks the project when there are several and nothing is selected", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await openFromBar();
    expect(await screen.findByRole("heading", { name: "Em qual projeto?" })).toBeInTheDocument();
  }, SLOW);

  it("uses the project of the selected ticket", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={adminMe()} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await openFromBar();
    await waitFor(() => expect(client.listConversations).toHaveBeenCalledWith("p1"));
    expect(screen.queryByRole("heading", { name: "Em qual projeto?" })).not.toBeInTheDocument();
  }, SLOW);

  it("a selected ticket with children is the scope of the conversation, and the scopeId goes with the first message", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={adminMe()} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-1 · Acesso/));
    await openFromBar();
    await userEvent.type(await message(), "O login quebra{Enter}");
    expect(screen.getByText("Dentro de ALFA-1")).toBeInTheDocument();
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "O login quebra", scopeId: "t1" }));
  }, SLOW);

  it("a selected ticket without children is the scope too (ADR 0034)", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={adminMe()} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await openFromBar();
    await userEvent.type(await message(), "O login quebra{Enter}");
    expect(screen.getByText("Dentro de ALFA-3")).toBeInTheDocument();
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "O login quebra", scopeId: "t3" }));
  }, SLOW);

  it("a selected project gives no scope", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await openFromBar();
    await message();
    expect(screen.queryByText(/^Dentro de ALFA-/)).not.toBeInTheDocument();
  }, SLOW);

  it("no selection gives no scope", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await openFromBar();
    await message();
    expect(screen.queryByText(/^Dentro de ALFA-/)).not.toBeInTheDocument();
  }, SLOW);

  it("does not narrow the map: the conversation takes no room beside it", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await openFromBar();
    await message();
    expect(workspace()).not.toHaveClass("has-assistant");
    expect(document.querySelector("aside.assistant-panel")).toBeNull();
  }, SLOW);

  it("folding without creating hides the sheet and brings the field back", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await openFromBar();
    await userEvent.click(await screen.findByRole("button", { name: "Recolher" }));
    expect(assistant()).not.toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Peça qualquer coisa" })).toBeInTheDocument();
  }, SLOW);
});

describe("the conversation beside the other regions", () => {
  const only = () => withAssistant(makePanelMe("admin"));
  it("opening the assistant keeps the ticket page and the open ticket", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={only()} onChange={onChange} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await screen.findByRole("complementary", { name: "Página do ticket" });
    await openFromBar();
    await message();
    expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(null);
  }, SLOW);

  it("opening Áreas e projetos folds the assistant and keeps the conversation", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await openFromBar();
    await userEvent.type(await message(), "O login quebra{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    expect(assistant()).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversa em andamento" })).toBeInTheDocument();
  }, SLOW);

  it("opening the assistant keeps Áreas e projetos", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await userEvent.click(await screen.findByRole("button", { name: "Áreas e projetos" }));
    await openFromBar();
    await message();
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();
  }, SLOW);
});

describe("the dashed card on the map", () => {
  const manager = () => withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));

  it("appears under the destination with the draft title once the path is found", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await openFromBar();
    expect(screen.queryByRole("button", { name: /Rascunho/ })).not.toBeInTheDocument();
    await placed();
    expect(await screen.findByRole("button", { name: /Rascunho do ticket.*Corrigir o login/ }, { timeout: SLOW })).toBeInTheDocument();
  }, SLOW);

  it("is not a ticket: clicking it neither opens a page nor shows the selection card", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={manager()} onChange={onChange} />);
    await openFromBar();
    await placed();
    const ghost = await node(/Rascunho do ticket.*Corrigir o login/);
    await userEvent.click(ghost);
    await userEvent.click(ghost);
    expect(onChange).not.toHaveBeenCalledWith(expect.anything());
    expect(screen.queryByRole("complementary", { name: "Nó selecionado" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Página do ticket" })).not.toBeInTheDocument();
  }, SLOW);

  it("moves with 'Um nível acima' (to the project root) and disappears when the conversation is deleted", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await openFromBar();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Um nível acima" }));
    expect(screen.getByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("Raiz do projeto");
    await userEvent.click(screen.getByRole("button", { name: "Apagar conversa" }));
    await userEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Rascunho do ticket/ })).not.toBeInTheDocument());
  }, SLOW);
});

describe("Escolher no mapa", () => {
  const manager = () => withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }, { projectId: "p2", role: "manager" }]));

  it("the next click on a ticket without children makes that ticket the destination, without opening it or the selection card", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={manager()} onChange={onChange} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-1 · Acesso/));
    await openFromBar();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    const path = screen.getByRole("region", { name: "Caminho encontrado" });
    expect(path).toHaveTextContent("Publicar");
    expect(path).not.toHaveTextContent("Raiz do projeto");
    expect(screen.queryByText(/é um ticket\. O destino passou a ser/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith("t3");
    expect(screen.queryByRole("complementary", { name: "Nó selecionado" })).not.toBeInTheDocument();
  }, SLOW);

  it("a click on the project of the conversation means its root, and does not open the side panel", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    // Selecionar o projeto abre o painel de áreas; o fechamos para ver que o clique da escolha não o abre de novo.
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    await openFromBar();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await userEvent.click(screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }));
    expect(screen.getByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("Raiz do projeto");
    expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
    expect(assistant()).toBeInTheDocument();
  }, SLOW);

  it("a click on another project is refused with a message", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await openFromBar();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await userEvent.click(await node(/BETA · Projeto Beta/));
    expect(await screen.findByRole("alert")).toHaveTextContent("Projeto Alfa");
    // A escolha segue de pé, com o aviso na linha da barra; ao cancelar, a folha volta com o caminho de antes.
    await userEvent.click(screen.getByRole("button", { name: "Cancelar escolha" }));
    expect(screen.getByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("Acesso");
  }, SLOW);

  it("Esc on the map cancels the choice and keeps the panel", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await openFromBar();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    expect(screen.getByText(/Clique em um ticket ou no projeto/)).toBeInTheDocument();
    screen.getByRole("region", { name: "Mapa da organização" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
    expect(assistant()).toBeInTheDocument();
  }, SLOW);
});

describe("creating", () => {
  it("closes the panel, reloads the map and opens the page of the new ticket", async () => {
    const onChange = vi.fn();
    const client = makeFullClient();
    render(<Host client={client} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} onChange={onChange} />);
    await openFromBar();
    await placed();
    const reloads = vi.mocked(client.listTickets).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("t9"));
    expect(assistant()).not.toBeInTheDocument();
    expect(vi.mocked(client.listTickets).mock.calls.length).toBeGreaterThan(reloads);
    expect(await screen.findByRole("heading", { level: 1, name: "Corrigir o login" })).toBeInTheDocument();
  }, SLOW);

  it("keeps the panel and shows the error when the API refuses", async () => {
    const client = makeFullClient({ createTicketFromConversation: vi.fn(async () => failed("conflict", "conversation_closed")) });
    render(<Host client={client} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await openFromBar();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Criar aqui" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("já foi encerrada");
    expect(assistant()).toBeInTheDocument();
  }, SLOW);

  it("the manual creation closes the panel and opens the creation mode of the ticket page", async () => {
    const client = makeFullClient({ openConversation: vi.fn(async () => failed("unavailable", "assistant_unavailable")) });
    render(<Host client={client} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    await openFromBar();
    await userEvent.type(await message(), "x{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Criar manualmente" }));
    expect(assistant()).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
  }, SLOW);

  it("the manual creation opens with the draft of the conversation already filled in", async () => {
    const client = makeFullClient({ sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")), listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])) });
    render(<Host client={client} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]))} />);
    // A conversa anterior volta pela barra: "Continuar conversa".
    await userEvent.click(await screen.findByRole("combobox", { name: "Peça qualquer coisa" }));
    await userEvent.click(await screen.findByRole("option", { name: /Continuar conversa/ }));
    await userEvent.type(await message(), "x{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Criar manualmente" }));
    expect(await screen.findByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
    expect(screen.getByRole("textbox", { name: "Descrição" })).toHaveTextContent("O login falha no Safari.");
  }, SLOW);
});

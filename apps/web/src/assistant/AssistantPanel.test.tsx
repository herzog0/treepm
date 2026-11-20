import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, PlacementOutcome } from "../api/client.js";
import type { MapNode } from "../map/items.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";
import type { AssistantPanelProps } from "./AssistantPanel.js";
import type { MapPicker } from "./types.js";

const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const beta = makeProject("p2", "BETA", "Projeto Beta");
const tickets = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", status: null, progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", status: null, progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t3", "p1", 3, "Senha", { key: "ALFA-3", parentId: "t2", status: "todo" }),
    makeTicket("t4", "p1", 4, "Relatórios", { key: "ALFA-4", status: null, progress: { done: 0, total: 1, excluded: 0 } }),
  ],
};
const target = (...ids: string[]) => ({ parentId: ids.at(-1) ?? null, path: ids.map((id) => ({ id, title: tickets.p1.find((t) => t.id === id)!.title })) });

function clientWith(extra: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const client = makeClient({ projects: [alfa, beta] });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c-new", projectId))),
    sendConversationMessage: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string }) => ok(makeConversation(id, "p1", { draft: body }))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: target("t1", "t2") }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9" }), description: "", createdByPersonId: "x", createdAt: "x", updatedAt: "y" } })),
    removeConversation: vi.fn(async () => ok(undefined)),
    ...extra,
  });
  return client;
}

function setup(client: ApiClient, extra: Partial<AssistantPanelProps> = {}) {
  const props: AssistantPanelProps = {
    client,
    projects: [alfa],
    initialProjectId: "p1",
    tickets,
    onClose: vi.fn(),
    onCreated: vi.fn(),
    onManualCreate: vi.fn(),
    onDraftChange: vi.fn(),
    onChanged: vi.fn(),
    registerPicker: vi.fn(),
    ...extra,
  };
  render(<AssistantPanel {...props} />);
  return props;
}
/** O texto da resposta também vai para a região viva; as buscas de mensagem olham só a lista. */
const thread = () => within(panel().querySelector<HTMLElement>(".assistant-scroll")!);
const panel = () => screen.getByRole("complementary", { name: "Novo ticket com o assistente" });
const box = () => screen.getByRole("textbox", { name: "Mensagem para o assistente" });
const lastPicker = (props: AssistantPanelProps) => vi.mocked(props.registerPicker).mock.calls.filter(([picker]) => picker !== null).at(-1)![0] as MapPicker;
const projectNode = (id: string): MapNode => ({ id, parentId: "org", kind: "project", label: id, color: "#fff", key: id, ticket: null, leafCount: 1 });
const ticketNode = (id: string): MapNode => {
  const ticket = tickets.p1.find((t) => t.id === id) ?? makeTicket(id, "p2", 1, "De outro projeto");
  return { id, parentId: ticket.projectId, kind: "ticket", label: ticket.title, color: "#fff", key: ticket.key, ticket, leafCount: 1 };
};

describe("project and resumed conversation", () => {
  it("asks which project when none was given and there are several", async () => {
    const client = clientWith();
    setup(client, { projects: [alfa, beta], initialProjectId: null });
    expect(await screen.findByRole("heading", { name: "Em qual projeto?" })).toBeInTheDocument();
    expect(client.listConversations).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /BETA · Projeto Beta/ }));
    await waitFor(() => expect(client.listConversations).toHaveBeenCalledWith("p2"));
    expect(box()).toBeInTheDocument();
  });

  it("goes straight to the conversation of the only project", async () => {
    const client = clientWith();
    setup(client);
    await waitFor(() => expect(client.listConversations).toHaveBeenCalledWith("p1"));
    expect(screen.queryByRole("heading", { name: "Em qual projeto?" })).not.toBeInTheDocument();
    expect(box()).toBeInTheDocument();
    expect(panel()).toHaveTextContent("Projeto Alfa");
  });

  it("resumes the most recent open conversation, with its messages and draft", async () => {
    const summary = (id: string, status: "open" | "ticket_created", updatedAt: string) => {
      return { ...makeConversation(id, "p1", { status, updatedAt }), messages: undefined };
    };
    const client = clientWith({
      listConversations: vi.fn(async () => ok([summary("c-old", "open", "2026-11-18T10:00:00.000Z"), summary("c-new", "open", "2026-11-20T10:00:00.000Z"), summary("c-done", "ticket_created", "2026-11-21T10:00:00.000Z")])),
    });
    setup(client);
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    expect(client.getConversation).toHaveBeenCalledWith("c-new");
    expect(screen.getByText("O login quebra no Safari")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
  });

  it("shows a retryable error when the conversations cannot be loaded", async () => {
    const listConversations = vi.fn().mockResolvedValueOnce(failed("unavailable")).mockResolvedValue(ok([]));
    setup(clientWith({ listConversations }));
    expect(await screen.findByRole("alert")).toHaveTextContent("indisponível");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("textbox", { name: "Mensagem para o assistente" })).toBeInTheDocument();
  });
});

describe("sending messages", () => {
  it("opens the conversation with the first message and shows the turn", async () => {
    const client = clientWith();
    setup(client);
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "O login quebra{Enter}");
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "O login quebra" }));
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    expect(box()).toHaveValue("");
  });

  it("sends the next message to the open conversation", async () => {
    const client = clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])) });
    setup(client);
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    await userEvent.type(box(), "Sim, em todas{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalledWith("c1", { message: "Sim, em todas" }));
  });

  it("Shift+Enter breaks the line instead of sending", async () => {
    const client = clientWith();
    setup(client);
    const field = await screen.findByRole("textbox", { name: "Mensagem para o assistente" });
    await userEvent.type(field, "linha 1{Shift>}{Enter}{/Shift}linha 2");
    expect(field).toHaveValue("linha 1\nlinha 2");
    expect(client.openConversation).not.toHaveBeenCalled();
  });

  it("does not send an empty message", async () => {
    const client = clientWith();
    setup(client);
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "   {Enter}");
    expect(client.openConversation).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("warns near 4.000 characters and blocks sending past the limit", async () => {
    const client = clientWith();
    setup(client);
    const field = await screen.findByRole("textbox", { name: "Mensagem para o assistente" });
    await userEvent.click(field);
    await userEvent.paste("a".repeat(4001));
    expect(screen.getByText(/passou de 4\.000 caracteres/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    expect(client.openConversation).not.toHaveBeenCalled();
  });

  it("while waiting, shows the waiting state, refuses another send and keeps the focus in the text field", async () => {
    let finish: (value: unknown) => void = () => undefined;
    const openConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    setup(clientWith({ openConversation }));
    const field = await screen.findByRole("textbox", { name: "Mensagem para o assistente" });
    await userEvent.type(field, "Primeira{Enter}");
    expect(await screen.findByText("O assistente está respondendo…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await userEvent.type(field, "Segunda{Enter}");
    expect(openConversation).toHaveBeenCalledTimes(1);
    expect(field).toHaveFocus();
    await act(async () => finish(ok(makeConversation("c-new", "p1"))));
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    expect(field).toHaveFocus();
  });

  it("announces the new assistant reply politely, and not the resumed history", async () => {
    const client = clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])) });
    setup(client);
    await screen.findByText("O login quebra no Safari");
    const live = screen.getByRole("status", { name: "Resposta do assistente" });
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();
    vi.mocked(client.sendConversationMessage).mockResolvedValueOnce(
      ok(makeConversation("c1", "p1", { messages: [...makeConversation("c1", "p1").messages, { id: "m3", author: "person", body: "Sim", model: null, createdAt: "x" }, { id: "m4", author: "assistant", body: "Obrigado, já escrevi o rascunho.", model: "m", createdAt: "y" }] })),
    );
    await userEvent.type(box(), "Sim{Enter}");
    await waitFor(() => expect(live).toHaveTextContent("Obrigado, já escrevi o rascunho."));
  });
});

describe("failures", () => {
  const unavailable = () => vi.fn().mockResolvedValueOnce(failed("unavailable", "assistant_unavailable")).mockResolvedValue(ok(makeConversation("c-new", "p1")));

  it("assistant_unavailable keeps the typed text, offers Tentar de novo and the manual creation", async () => {
    const openConversation = unavailable();
    const props = setup(clientWith({ openConversation }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "Meu texto{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("O assistente não respondeu");
    expect(box()).toHaveValue("Meu texto");
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(openConversation).toHaveBeenCalledTimes(2));
    expect(openConversation).toHaveBeenLastCalledWith("p1", { message: "Meu texto" });
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onManualCreate).not.toHaveBeenCalled();
  });

  it("offers the manual creation, which hands the project over", async () => {
    const props = setup(clientWith({ openConversation: unavailable() }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "x{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Criar manualmente" }));
    expect(props.onManualCreate).toHaveBeenCalledWith({ projectId: "p1", parentId: null });
  });

  it("the manual creation hands the current draft over, including a hand edit", async () => {
    const client = clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")),
    });
    const props = setup(client);
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.type(title, " (Safari)");
    await userEvent.type(box(), "x{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Criar manualmente" }));
    expect(props.onManualCreate).toHaveBeenCalledWith({ projectId: "p1", parentId: null, draft: { title: "Corrigir o login (Safari)", description: "O login falha no Safari." } });
  });

  it("conversation_changed reloads the conversation and keeps the text", async () => {
    const client = clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(async () => failed("conflict", "conversation_changed")),
    });
    setup(client);
    await screen.findByText("O login quebra no Safari");
    vi.mocked(client.getConversation).mockClear();
    await userEvent.type(box(), "Meu texto{Enter}");
    await waitFor(() => expect(client.getConversation).toHaveBeenCalledWith("c1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A conversa mudou");
    expect(box()).toHaveValue("Meu texto");
  });

  it("conversation_closed explains it and the new-conversation button starts over", async () => {
    const client = clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(async () => failed("conflict", "conversation_closed")),
    });
    setup(client);
    await screen.findByText("O login quebra no Safari");
    await userEvent.type(box(), "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("já foi encerrada");
    await userEvent.click(screen.getByRole("button", { name: "Nova conversa" }));
    expect(screen.queryByText("O login quebra no Safari")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("memory", () => {
  const resumed = () => clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])) });

  it("Nova conversa clears the panel without deleting the old conversation", async () => {
    const client = resumed();
    setup(client);
    await screen.findByText("O login quebra no Safari");
    await userEvent.click(screen.getByRole("button", { name: "Nova conversa" }));
    expect(screen.queryByText("O login quebra no Safari")).not.toBeInTheDocument();
    expect(client.removeConversation).not.toHaveBeenCalled();
    await userEvent.type(box(), "Outro assunto{Enter}");
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "Outro assunto" }));
  });

  it("Apagar conversa needs the second click on the same place", async () => {
    const client = resumed();
    setup(client);
    await screen.findByText("O login quebra no Safari");
    await userEvent.click(screen.getByRole("button", { name: "Apagar conversa" }));
    expect(client.removeConversation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(client.removeConversation).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(screen.queryByText("O login quebra no Safari")).not.toBeInTheDocument());
  });
});

describe("draft", () => {
  const resumed = (extra: Partial<Record<keyof ApiClient, unknown>> = {}) =>
    clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])), ...extra });

  it("Salvar rascunho only appears after a hand edit, and saves title and description", async () => {
    const client = resumed();
    setup(client);
    const title = await screen.findByRole("textbox", { name: "Título" });
    expect(screen.queryByRole("button", { name: "Salvar rascunho" })).not.toBeInTheDocument();
    await userEvent.clear(title);
    await userEvent.type(title, "Login no Safari");
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", { title: "Login no Safari", description: "O login falha no Safari." }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Salvar rascunho" })).not.toBeInTheDocument());
  });

  it("does not allow saving a blank title", async () => {
    setup(resumed());
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.clear(title);
    expect(screen.getByRole("button", { name: "Salvar rascunho" })).toBeDisabled();
  });

  it("offers Procurar o lugar as soon as there is a draft, even when the AI is not ready", async () => {
    setup(resumed({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1", { ready: false }), messages: undefined }])) }));
    expect(await screen.findByRole("button", { name: "Procurar o lugar" })).toBeEnabled();
  });

  it("has no draft section nor search button before there is a draft", async () => {
    setup(clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1", { draft: null }), messages: undefined }])),
      getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { draft: null }))),
    }));
    await screen.findByText("O login quebra no Safari");
    expect(screen.queryByRole("region", { name: "Rascunho do ticket" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Procurar o lugar" })).not.toBeInTheDocument();
  });

  it("draft_required on the search is explained", async () => {
    setup(resumed({ findPlacement: vi.fn(async () => failed("conflict", "draft_required")) }));
    await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("ainda não tem rascunho");
  });
});

describe("path found", () => {
  const resumed = (placement: PlacementOutcome, extra: Partial<Record<keyof ApiClient, unknown>> = {}) =>
    clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      findPlacement: vi.fn(async () => ok(placement)),
      ...extra,
    });
  const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
  const path = () => screen.getByRole("region", { name: "Caminho encontrado" });
  const steps = () => [...path().querySelectorAll(".assistant-steps li")];

  it("shows the path from the top (project, branches) in words, with no probabilities", async () => {
    const props = setup(resumed(makePlacement({ destination: target("t1", "t2") })));
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(steps().map((step) => step.textContent)).toEqual([expect.stringContaining("Projeto Alfa"), expect.stringContaining("Acesso"), expect.stringContaining("Login"), expect.stringContaining("Ticket novo")]);
    expect(path().textContent).not.toMatch(/%|\d,\d|probabilidade/i);
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t2", title: "Corrigir o login" });
  });

  it("a placement at the project root says so and puts the ghost under the project", async () => {
    const props = setup(resumed(makePlacement({ destination: { parentId: null, path: [] } })));
    await search();
    expect(await screen.findByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("Raiz do projeto");
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: null, title: "Corrigir o login" });
  });

  it("choosing an alternative moves the destination and the ghost", async () => {
    const props = setup(resumed(makePlacement({ destination: target("t1", "t2"), alternatives: [target("t4")] })));
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /Usar: Relatórios/ }));
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t4", title: "Corrigir o login" });
    expect(steps().map((item) => item.textContent)).toEqual([expect.stringContaining("Projeto Alfa"), expect.stringContaining("Relatórios"), expect.stringContaining("Ticket novo")]);
    // A antiga escolha vira alternativa.
    expect(screen.getByRole("button", { name: /Usar: Acesso › Login/ })).toBeInTheDocument();
  });

  it("warns when the place is uncertain, in words", async () => {
    setup(resumed(makePlacement({ destination: target("t1"), alternatives: [target("t4")], uncertain: true })));
    await search();
    expect(await screen.findByText(/Não tenho certeza do lugar/)).toBeInTheDocument();
  });

  it.each([
    ["candidates_too_large", /ramos demais/],
    ["max_levels", /limite de níveis/],
  ] as const)("explains the early stop %s", async (reason, message) => {
    setup(resumed(makePlacement({ destination: target("t1"), stoppedEarly: { reason, level: 2, parentId: "t1" } })));
    await search();
    const note = await screen.findByText(message);
    expect(note).toHaveTextContent("Acesso");
  });

  it("Um nível acima moves to the parent, up to the project root", async () => {
    const props = setup(resumed(makePlacement({ destination: target("t1", "t2") })));
    await search();
    const up = await screen.findByRole("button", { name: "Um nível acima" });
    await userEvent.click(up);
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" });
    await userEvent.click(up);
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: null, title: "Corrigir o login" });
    expect(up).toBeDisabled();
  });

  it("hands the primary action from Procurar o lugar to Criar aqui once the path is shown", async () => {
    setup(resumed(makePlacement({ destination: target("t1") })));
    expect(await screen.findByRole("button", { name: "Procurar o lugar" })).toHaveClass("primary");
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(panel().querySelectorAll(".assistant-cards button.primary")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Criar aqui" })).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Procurar de novo" })).not.toHaveClass("primary");
  });

  it("saves a hand edit of the draft before searching", async () => {
    const client = resumed(makePlacement({ destination: target("t1") }));
    setup(client);
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.type(title, " (Safari)");
    await search();
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalled());
    expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", { title: "Corrigir o login (Safari)", description: "O login falha no Safari." });
    const order = [vi.mocked(client.updateConversationDraft).mock.invocationCallOrder[0]!, vi.mocked(client.findPlacement).mock.invocationCallOrder[0]!];
    expect(order[0]).toBeLessThan(order[1]!);
  });

  it("a new assistant turn drops the shown path and the ghost", async () => {
    const client = resumed(makePlacement({ destination: target("t1") }));
    const props = setup(client);
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await userEvent.type(box(), "Mais um detalhe{Enter}");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Caminho encontrado" })).not.toBeInTheDocument());
    expect(props.onDraftChange).toHaveBeenLastCalledWith(null);
  });

  describe("Escolher no mapa", () => {
    it("registers the picker; a ticket of the same project becomes the destination", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t1") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      expect(screen.getByText(/Clique em um ticket ou no projeto/)).toBeInTheDocument();
      act(() => lastPicker(props).pick(ticketNode("t4")));
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t4", title: "Corrigir o login" });
      expect(props.registerPicker).toHaveBeenLastCalledWith(null);
      expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
    });

    it("the project of the conversation means the project root", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t1") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).pick(projectNode("p1")));
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: null, title: "Corrigir o login" });
    });

    it("refuses a ticket or project of another project, with a message, and keeps choosing", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t1") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).pick(ticketNode("x1")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Projeto Alfa");
      act(() => lastPicker(props).pick(projectNode("p2")));
      expect(screen.getByRole("alert")).toHaveTextContent("Projeto Alfa");
      expect(props.onDraftChange).not.toHaveBeenLastCalledWith(expect.objectContaining({ parentId: "x1" }));
      expect(props.registerPicker).not.toHaveBeenLastCalledWith(null);
    });

    it("cancelling (Esc from the map or the button) stops choosing and keeps the destination", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t1") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).cancel());
      expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" });
      await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
      await userEvent.click(screen.getByRole("button", { name: "Cancelar escolha" }));
      expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
    });
  });

  describe("Criar aqui", () => {
    it("creates under the shown destination, reloads the map and hands the new ticket over", async () => {
      const client = resumed(makePlacement({ destination: target("t1", "t2") }));
      const props = setup(client);
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
      await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t2" }));
      await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
      expect(props.onChanged).toHaveBeenCalled();
    });

    it("creates at the project root with parentId null", async () => {
      const client = resumed(makePlacement({ destination: { parentId: null, path: [] } }));
      setup(client);
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
      await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: null }));
    });

    it("shows the API error next to the button and does not hand anything over", async () => {
      const client = resumed(makePlacement({ destination: target("t1") }), { createTicketFromConversation: vi.fn(async () => failed("conflict", "conversation_closed")) });
      const props = setup(client);
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("já foi encerrada");
      expect(path().contains(alert)).toBe(true);
      expect(props.onCreated).not.toHaveBeenCalled();
    });
  });
});

describe("closing", () => {
  it("the close button and Esc close without creating, and Esc does not reach the map", async () => {
    const props = setup(clientWith());
    const onWindowKey = vi.fn();
    window.addEventListener("keydown", onWindowKey);
    await screen.findByRole("textbox", { name: "Mensagem para o assistente" });
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(onWindowKey).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Fechar conversa" }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", onWindowKey);
  });

  it("reports no draft to the map when it closes", async () => {
    const props = setup(clientWith());
    await screen.findByRole("textbox", { name: "Mensagem para o assistente" });
    expect(props.onDraftChange).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.anything() }));
  });

  it("puts the focus in the text field when the panel opens", async () => {
    setup(clientWith());
    expect(await screen.findByRole("textbox", { name: "Mensagem para o assistente" })).toHaveFocus();
  });
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, PlacementOutcome } from "../api/client.js";
import type { MapNode } from "../map/items.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeGroup, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";
import type { AssistantPanelProps } from "./AssistantPanel.js";
import type { MapPicker } from "./types.js";

const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const beta = makeProject("p2", "BETA", "Projeto Beta");
const tickets = {
  p1: [
    makeGroup("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeGroup("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t3", "p1", 3, "Senha", { key: "ALFA-3", parentId: "t2", status: "todo" }),
    makeGroup("t4", "p1", 4, "Relatórios", { key: "ALFA-4", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t5", "p1", 5, "Solto", { key: "ALFA-5" }),
    makeGroup("t6", "p1", 6, "Fase vazia", { key: "ALFA-6" }),
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
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "O login quebra", scopeId: null }));
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    expect(box()).toHaveValue("");
  });

  it("sends the next message to the open conversation", async () => {
    const client = clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])) });
    setup(client);
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    await userEvent.type(box(), "Sim, em todas{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalledWith("c1", { message: "Sim, em todas", scopeId: null }));
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
    expect(openConversation).toHaveBeenLastCalledWith("p1", { message: "Meu texto", scopeId: null });
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
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "Outro assunto", scopeId: null }));
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

  it("offers the search as soon as there is a draft, even when the AI is not ready (as Procurar assim mesmo)", async () => {
    setup(resumed({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1", { ready: false }), messages: undefined }])),
      getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { ready: false }))),
    }));
    expect(await screen.findByRole("button", { name: "Procurar assim mesmo" })).toBeEnabled();
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

  describe("destination that is an empty group", () => {
    it("shows no warning about missing subtickets (ADR 0031 removed it): an empty group is a normal destination", async () => {
      setup(resumed(makePlacement({ destination: target("t6") })));
      await search();
      const card = await screen.findByRole("region", { name: "Caminho encontrado" });
      expect(card).toHaveTextContent("Fase vazia");
      expect(screen.queryByText(/ainda não tem subtickets/)).not.toBeInTheDocument();
      expect(card.querySelector(".assistant-notice")).toBeNull();
    });

    it("shows no warning for a leaf-less alternative either", async () => {
      setup(resumed(makePlacement({ destination: target("t1", "t2"), alternatives: [target("t6")] })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: /Usar: Fase vazia/ }));
      expect(screen.queryByText(/ainda não tem subtickets/)).not.toBeInTheDocument();
    });
  });

  it("warns when the place is uncertain, in words", async () => {
    setup(resumed(makePlacement({ destination: target("t1"), alternatives: [target("t4")], uncertain: true })));
    await search();
    expect(await screen.findByText(/Não tenho certeza do lugar: mais de um agrupador serve/)).toBeInTheDocument();
    expect(screen.queryByText(/ramo/)).not.toBeInTheDocument();
  });

  it.each([
    ["candidates_too_large", /agrupadores demais/],
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
    it("registers the picker; a group of the same project becomes the destination, with no explanation", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t1") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      expect(screen.getByText(/Clique em um agrupador ou no projeto/)).toBeInTheDocument();
      act(() => lastPicker(props).pick(ticketNode("t4")));
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t4", title: "Corrigir o login" });
      expect(props.registerPicker).toHaveBeenLastCalledWith(null);
      expect(screen.queryByText(/Clique em um agrupador ou no projeto/)).not.toBeInTheDocument();
      expect(screen.queryByText(/é um ticket/)).not.toBeInTheDocument();
    });

    it("a ticket picks the group that holds it and the panel says so", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t4") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).pick(ticketNode("t3")));
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t2", title: "Corrigir o login" });
      expect(screen.getByText("«Senha» é um ticket. O destino passou a ser «Login».")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("Acesso");
    });

    it("a ticket at the project root picks the project root and the panel says so", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t4") })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).pick(ticketNode("t5")));
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: null, title: "Corrigir o login" });
      expect(screen.getByText("«Solto» é um ticket. O destino passou a ser a raiz do projeto.")).toBeInTheDocument();
    });

    it("the explanation goes away when the destination changes by another route", async () => {
      const props = setup(resumed(makePlacement({ destination: target("t4"), alternatives: [target("t1")] })));
      await search();
      await userEvent.click(await screen.findByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).pick(ticketNode("t3")));
      expect(screen.getByText(/é um ticket/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Um nível acima" }));
      expect(screen.queryByText(/é um ticket/)).not.toBeInTheDocument();
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
      expect(screen.queryByText(/Clique em um agrupador ou no projeto/)).not.toBeInTheDocument();
      expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" });
      await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
      await userEvent.click(screen.getByRole("button", { name: "Cancelar escolha" }));
      expect(screen.queryByText(/Clique em um agrupador ou no projeto/)).not.toBeInTheDocument();
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

describe("scope from the selection (ADR 0031)", () => {
  const resumed = (placements: PlacementOutcome[], extra: Partial<Record<keyof ApiClient, unknown>> = {}) => {
    const findPlacement = vi.fn();
    for (const placement of placements) findPlacement.mockResolvedValueOnce(ok(placement));
    findPlacement.mockResolvedValue(ok(placements.at(-1)!));
    return clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])), findPlacement, ...extra });
  };
  const line = () => screen.queryByText(/Procurando dentro de/);
  const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
  const scoped = (extra: Partial<PlacementOutcome> = {}) => makePlacement({ destination: target("t1", "t2"), scope: { id: "t1", title: "Acesso", outOfScope: false }, ...extra });
  const whole = () => makePlacement({ destination: target("t4") });

  it("shows the fixed line with the group title and the action, above the draft", async () => {
    setup(resumed([scoped()]), { initialScopeId: "t1" });
    const draft = await screen.findByRole("region", { name: "Rascunho do ticket" });
    expect(line()).toHaveTextContent("Procurando dentro de «Acesso»");
    expect(screen.getByRole("button", { name: "Procurar no projeto inteiro" })).toBeInTheDocument();
    expect(line()!.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the line even before there is a conversation", async () => {
    setup(clientWith(), { initialScopeId: "t1" });
    await screen.findByRole("textbox", { name: "Mensagem para o assistente" });
    expect(line()).toHaveTextContent("«Acesso»");
  });

  it("sends the scope with the search", async () => {
    const client = resumed([scoped()]);
    setup(client, { initialScopeId: "t1" });
    await search();
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledWith("c1", "t1"));
  });

  it("without a scope there is no line and the search sends nothing more", async () => {
    const client = resumed([whole()]);
    setup(client, { initialScopeId: null });
    await search();
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledWith("c1"));
    expect(line()).not.toBeInTheDocument();
  });

  it.each([
    ["a ticket", "t5"],
    ["a group of another project", "t99"],
    ["an unknown id", "nada"],
  ])("a scope that is %s is no scope", async (_name, id) => {
    const client = resumed([whole()]);
    setup(client, { initialScopeId: id });
    await search();
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledWith("c1"));
    expect(line()).not.toBeInTheDocument();
  });

  it("Procurar no projeto inteiro removes the scope; the next search goes without it", async () => {
    const client = resumed([whole()]);
    setup(client, { initialScopeId: "t1" });
    await screen.findByRole("region", { name: "Rascunho do ticket" });
    await userEvent.click(screen.getByRole("button", { name: "Procurar no projeto inteiro" }));
    expect(line()).not.toBeInTheDocument();
    expect(client.findPlacement).not.toHaveBeenCalled();
    await search();
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledWith("c1"));
  });

  it("with a result already on screen, removing the scope searches again without it", async () => {
    const client = resumed([scoped(), whole()]);
    setup(client, { initialScopeId: "t1" });
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await userEvent.click(screen.getByRole("button", { name: "Procurar no projeto inteiro" }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    expect(client.findPlacement).toHaveBeenLastCalledWith("c1");
    expect(line()).not.toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Caminho encontrado" })).getByText("Relatórios")).toBeInTheDocument());
  });

  it("warns when the result is out of scope, with the same action", async () => {
    const client = resumed([scoped({ scope: { id: "t1", title: "Acesso", outOfScope: true } }), whole()]);
    setup(client, { initialScopeId: "t1" });
    await search();
    const card = await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(card).toHaveTextContent("Este ticket talvez não caiba em «Acesso».");
    await userEvent.click(within(card).getByRole("button", { name: "Procurar no projeto inteiro" }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenLastCalledWith("c1"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Caminho encontrado" })).not.toHaveTextContent("talvez não caiba"));
    expect(line()).not.toBeInTheDocument();
  });

  it("no warning when the result fits the scope", async () => {
    setup(resumed([scoped()]), { initialScopeId: "t1" });
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(screen.queryByText(/talvez não caiba/)).not.toBeInTheDocument();
  });

  it("the person can still pick a destination outside the scope: up one level and the map", async () => {
    const props = setup(resumed([scoped({ destination: target("t1") })]), { initialScopeId: "t1" });
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await userEvent.click(screen.getByRole("button", { name: "Um nível acima" }));
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: null, title: "Corrigir o login" });
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    act(() => lastPicker(props).pick(ticketNode("t4")));
    expect(props.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t4", title: "Corrigir o login" });
  });
});

describe("group proposal (ADR 0031)", () => {
  const proposal = {
    title: "Redefinição de senha",
    description: "Fluxos de senha esquecida e de reset.",
    tickets: [
      { id: "t3", number: 3, title: "Senha esquecida" },
      { id: "t5", number: 5, title: "Reset por SMS" },
      { id: "t7", number: 7, title: "Link expirado" },
    ],
  };
  const withProposal = (extra: Partial<PlacementOutcome> = {}) => makePlacement({ destination: target("t1", "t2"), groupProposal: proposal, ...extra });
  const resumed = (placement: PlacementOutcome, extra: Partial<Record<keyof ApiClient, unknown>> = {}) =>
    clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      findPlacement: vi.fn(async () => ok(placement)),
      ...extra,
    });
  const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
  const path = () => screen.getByRole("region", { name: "Caminho encontrado" });
  const box = (name: string) => screen.getByRole("checkbox", { name });
  const shown = async () => {
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
  };

  it("shows the line, the proposed title and description and the tickets, all checked, below the path", async () => {
    setup(resumed(withProposal()));
    await shown();
    expect(path()).toHaveTextContent("Este ticket parece formar um grupo com outros daqui.");
    expect(path()).toHaveTextContent("Redefinição de senha");
    expect(path()).toHaveTextContent("Fluxos de senha esquecida e de reset.");
    for (const title of ["Senha esquecida", "Reset por SMS", "Link expirado"]) expect(box(title)).toBeChecked();
    const steps = path().querySelector(".assistant-steps")!;
    expect(steps.compareDocumentPosition(screen.getByText("Este ticket parece formar um grupo com outros daqui.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps Criar aqui as the primary action with a proposal and moves Criar agrupador e mover into the proposal block, as a secondary action", async () => {
    setup(resumed(withProposal()));
    await shown();
    expect(screen.getByRole("button", { name: "Criar aqui" })).toHaveClass("primary");
    expect(screen.queryByRole("button", { name: "Só criar o ticket" })).not.toBeInTheDocument();
    const block = path().querySelector<HTMLElement>(".assistant-proposal")!;
    const group = screen.getByRole("button", { name: "Criar agrupador e mover" });
    expect(block.contains(group)).toBe(true);
    expect(group).not.toHaveClass("primary");
    expect(block.contains(screen.getByRole("button", { name: "Criar aqui" }))).toBe(false);
    const list = block.querySelector(".proposal-tickets")!;
    expect(list.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Um nível acima" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escolher no mapa" })).toBeInTheDocument();
    expect(panel().querySelectorAll(".assistant-cards button.primary")).toHaveLength(1);
  });

  it("keeps Criar aqui reachable by keyboard right after the alternatives, before Um nível acima", async () => {
    setup(resumed(withProposal({ alternatives: [target("t4")] })));
    await shown();
    const order = Array.from(path().querySelectorAll("button")).map((b) => b.textContent);
    expect(order.indexOf("Criar aqui")).toBeGreaterThan(-1);
    expect(order.indexOf("Criar aqui")).toBeLessThan(order.indexOf("Um nível acima"));
    expect(order.indexOf("Um nível acima")).toBeLessThan(order.indexOf("Escolher no mapa"));
  });

  it("disables both create actions while one is in flight", async () => {
    const createTicketFromConversation = vi.fn(() => new Promise<never>(() => {}));
    setup(resumed(withProposal(), { createTicketFromConversation }));
    await shown();
    await userEvent.click(screen.getByRole("button", { name: "Criar agrupador e mover" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Criar aqui" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Criar agrupador e mover" })).toBeDisabled();
  });

  it("without a proposal nothing changes: Criar aqui stays and no proposal text shows", async () => {
    setup(resumed(makePlacement({ destination: target("t1", "t2"), groupProposalSkipped: "unavailable" })));
    await shown();
    expect(screen.getByRole("button", { name: "Criar aqui" })).toHaveClass("primary");
    expect(path()).not.toHaveTextContent("forma");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("lets the person uncheck a ticket, but the last checked one cannot be unchecked", async () => {
    setup(resumed(withProposal()));
    await shown();
    await userEvent.click(box("Reset por SMS"));
    expect(box("Reset por SMS")).not.toBeChecked();
    await userEvent.click(box("Link expirado"));
    expect(box("Link expirado")).not.toBeChecked();
    expect(box("Senha esquecida")).toBeChecked();
    expect(box("Senha esquecida")).toBeDisabled();
    await userEvent.click(box("Senha esquecida"));
    expect(box("Senha esquecida")).toBeChecked();
    await userEvent.click(box("Reset por SMS"));
    expect(box("Senha esquecida")).toBeEnabled();
  });

  it("confirms with the title, the description and only the checked ids, then closes like Criar aqui", async () => {
    const client = resumed(withProposal());
    const props = setup(client);
    await shown();
    await userEvent.click(box("Reset por SMS"));
    await userEvent.click(screen.getByRole("button", { name: "Criar agrupador e mover" }));
    await waitFor(() =>
      expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", {
        parentId: "t2",
        group: { title: "Redefinição de senha", description: "Fluxos de senha esquecida e de reset.", ticketIds: ["t3", "t7"] },
      }),
    );
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("Criar aqui sends no group even with a proposal", async () => {
    const client = resumed(withProposal());
    const props = setup(client);
    await shown();
    await userEvent.click(screen.getByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t2" }));
    expect(vi.mocked(client.createTicketFromConversation).mock.calls[0]![1]).not.toHaveProperty("group");
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
  });

  it("a proposal at the project root confirms with parentId null", async () => {
    const client = resumed(withProposal({ destination: { parentId: null, path: [] } }));
    setup(client);
    await shown();
    await userEvent.click(screen.getByRole("button", { name: "Criar agrupador e mover" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", expect.objectContaining({ parentId: null })));
  });

  describe("discarding", () => {
    const gone = () => {
      expect(screen.queryByText("Este ticket parece formar um grupo com outros daqui.")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Criar agrupador e mover" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Criar aqui" })).toHaveClass("primary");
    };

    it("choosing an alternative drops the proposal", async () => {
      setup(resumed(withProposal({ alternatives: [target("t4")] })));
      await shown();
      expect(screen.getByText("Este ticket parece formar um grupo com outros daqui.")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Usar: Relatórios/ }));
      gone();
    });

    it("going one level up drops the proposal", async () => {
      setup(resumed(withProposal()));
      await shown();
      expect(screen.getByText("Este ticket parece formar um grupo com outros daqui.")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Um nível acima" }));
      gone();
    });

    it("picking on the map drops the proposal", async () => {
      const props = setup(resumed(withProposal()));
      await shown();
      expect(screen.getByText("Este ticket parece formar um grupo com outros daqui.")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
      act(() => lastPicker(props).pick(projectNode("p1")));
      gone();
    });

    it("searching again drops the old proposal and shows the new result as it comes", async () => {
      const findPlacement = vi.fn().mockResolvedValueOnce(ok(withProposal())).mockResolvedValue(ok(makePlacement({ destination: target("t1", "t2") })));
      setup(resumed(withProposal(), { findPlacement }));
      await shown();
      expect(screen.getByText("Este ticket parece formar um grupo com outros daqui.")).toBeInTheDocument();
      await userEvent.click(await screen.findByRole("button", { name: "Procurar de novo" }));
      await waitFor(() => expect(findPlacement).toHaveBeenCalledTimes(2));
      await waitFor(() => gone());
    });

    it("a new search brings its own proposal, with everything checked again", async () => {
      const second = { ...proposal, title: "Outro grupo", tickets: [{ id: "t5", number: 5, title: "Reset por SMS" }] };
      const findPlacement = vi.fn().mockResolvedValueOnce(ok(withProposal())).mockResolvedValue(ok(withProposal({ groupProposal: second })));
      setup(resumed(withProposal(), { findPlacement }));
      await shown();
      expect(screen.getByText("Este ticket parece formar um grupo com outros daqui.")).toBeInTheDocument();
      await userEvent.click(box("Reset por SMS"));
      await userEvent.click(await screen.findByRole("button", { name: "Procurar de novo" }));
      expect(await screen.findByText("Outro grupo")).toBeInTheDocument();
      expect(box("Reset por SMS")).toBeChecked();
    });
  });

  it("grouping_changed shows the message beside the actions, drops the proposal and keeps the rest of the card", async () => {
    const client = resumed(withProposal({ alternatives: [target("t4")] }), {
      createTicketFromConversation: vi.fn(async () => failed("conflict", "grouping_changed")),
    });
    const props = setup(client);
    await shown();
    await userEvent.click(screen.getByRole("button", { name: "Criar agrupador e mover" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Algum desses tickets mudou de lugar. Procure de novo.");
    expect(path().contains(alert)).toBe(true);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText("Acesso")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Usar: Relatórios/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar aqui" })).toBeInTheDocument();
    expect(props.onCreated).not.toHaveBeenCalled();
  });
});

describe("scope in the conversation (ADR 0033)", () => {
  const resumed = (extra: Partial<Record<keyof ApiClient, unknown>> = {}) =>
    clientWith({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])), ...extra });

  it("opens the conversation with the selected group as the scope", async () => {
    const client = clientWith();
    setup(client, { initialScopeId: "t1" });
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "O login quebra{Enter}");
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "O login quebra", scopeId: "t1" }));
  });

  it("opens the conversation with a null scope when nothing is selected", async () => {
    const client = clientWith();
    setup(client);
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "O login quebra{Enter}");
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "O login quebra", scopeId: null }));
  });

  it("sends the scope with each message of a conversation already open", async () => {
    const client = resumed();
    setup(client, { initialScopeId: "t1" });
    await screen.findByText("O login quebra no Safari");
    await userEvent.type(box(), "Sim, em todas{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalledWith("c1", { message: "Sim, em todas", scopeId: "t1" }));
  });

  it("treats a selection that is not a group of the project as no scope", async () => {
    const client = resumed();
    setup(client, { initialScopeId: "t5" });
    await screen.findByText("O login quebra no Safari");
    await userEvent.type(box(), "Sim{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalledWith("c1", { message: "Sim", scopeId: null }));
  });

  it("after Procurar no projeto inteiro, the next messages go with a null scope", async () => {
    const client = resumed();
    setup(client, { initialScopeId: "t1" });
    await screen.findByText("O login quebra no Safari");
    await userEvent.type(box(), "Primeira{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenLastCalledWith("c1", { message: "Primeira", scopeId: "t1" }));
    await userEvent.click(screen.getByRole("button", { name: "Procurar no projeto inteiro" }));
    await userEvent.type(box(), "Segunda{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenLastCalledWith("c1", { message: "Segunda", scopeId: null }));
  });

  it("retrying after a failure sends the same scope again", async () => {
    const openConversation = vi.fn().mockResolvedValueOnce(failed("unavailable", "assistant_unavailable")).mockResolvedValue(ok(makeConversation("c-new", "p1")));
    setup(clientWith({ openConversation }), { initialScopeId: "t1" });
    await userEvent.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "Meu texto{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(openConversation).toHaveBeenLastCalledWith("p1", { message: "Meu texto", scopeId: "t1" }));
  });
});

describe("the AI is not ready yet (ADR 0033)", () => {
  const withReady = (ready: boolean, extra: Partial<Record<keyof ApiClient, unknown>> = {}) =>
    clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1", { ready }), messages: undefined }])),
      getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { ready }))),
      ...extra,
    });
  const QUESTION = "A IA ainda tem uma pergunta antes de procurar o lugar.";
  const draftCard = async () => within(await screen.findByRole("region", { name: "Rascunho do ticket" }));

  it("with ready false the search stops being the main action, is renamed and a line says why, right above it", async () => {
    setup(withReady(false));
    const card = await draftCard();
    const button = card.getByRole("button", { name: "Procurar assim mesmo" });
    expect(button).not.toHaveClass("primary");
    expect(card.queryByRole("button", { name: "Procurar o lugar" })).not.toBeInTheDocument();
    const line = card.getByText(QUESTION);
    expect(line.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.nextElementSibling).toBe(button.parentElement);
    expect(panel().querySelectorAll("button.primary")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Enviar" })).toBeInTheDocument();
  });

  it("with ready true everything is as before", async () => {
    setup(withReady(true));
    const card = await draftCard();
    expect(card.getByRole("button", { name: "Procurar o lugar" })).toHaveClass("primary");
    expect(card.queryByRole("button", { name: "Procurar assim mesmo" })).not.toBeInTheDocument();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
  });

  it("with ready false the person can still search", async () => {
    const client = withReady(false);
    setup(client);
    await userEvent.click(await screen.findByRole("button", { name: "Procurar assim mesmo" }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledWith("c1"));
    expect(await screen.findByRole("region", { name: "Caminho encontrado" })).toBeInTheDocument();
  });

  it("after a search the button is Procurar de novo and the line is gone, ready or not", async () => {
    setup(withReady(false));
    await userEvent.click(await screen.findByRole("button", { name: "Procurar assim mesmo" }));
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(screen.getByRole("button", { name: "Procurar de novo" })).not.toHaveClass("primary");
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
  });

  it("editing the draft by hand does not change the rule: the last answer's ready holds", async () => {
    const client = withReady(false, { updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string }) => ok(makeConversation(id, "p1", { draft: body, ready: true }))) });
    setup(client);
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.type(title, " no Safari");
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Procurar assim mesmo" })).not.toHaveClass("primary");
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalled());
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Procurar assim mesmo" })).toBeInTheDocument();
  });

  it("a new answer from the assistant with ready true restores the main action", async () => {
    const client = withReady(false, { sendConversationMessage: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { ready: true }))) });
    setup(client);
    await screen.findByText(QUESTION);
    await userEvent.type(box(), "Em todas as versões{Enter}");
    expect(await screen.findByRole("button", { name: "Procurar o lugar" })).toHaveClass("primary");
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
  });

  it("without a draft there is no line", async () => {
    setup(clientWith({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1", { draft: null, ready: false }), messages: undefined }])),
      getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { draft: null, ready: false }))),
    }));
    await screen.findByText("O login quebra no Safari");
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
  });
});

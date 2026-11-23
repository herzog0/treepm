import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { failed, makeMe } from "../test/fakes.js";
import { ALFA2, renderChats } from "./chatTesting.js";
import type { ChatSetup } from "./chatTesting.js";

/** Abre o painel e o chat do ticket (por padrão ALFA-1, de que a pessoa é responsável). */
async function openChat(setup: ChatSetup = {}, ticketKey = "ALFA-1") {
  const user = userEvent.setup();
  const view = renderChats(setup);
  await user.click(await screen.findByRole("button", { name: /^Chats/ }));
  await user.click(await screen.findByRole("button", { name: new RegExp(ticketKey) }));
  await screen.findByRole("tab", { name: "Conversa" });
  return { user, ...view };
}
const field = () => screen.getByRole("textbox", { name: "Mensagem" });
const log = () => screen.getByRole("log", { name: "Mensagens" });

describe("a ticket's chat", () => {
  it("shows the key and title as a button that opens the ticket, with Conversa and Menções tabs", async () => {
    const { user, onShowTicket } = await openChat();
    await user.click(screen.getByRole("button", { name: "Abrir o ticket ALFA-1, Corrigir o login" }));
    expect(onShowTicket).toHaveBeenCalledWith("t1");
    expect(screen.getByRole("tab", { name: "Conversa" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Menções" })).toHaveAttribute("aria-selected", "false");
  });

  it("states what the assistant sees and that it does not run or change anything", async () => {
    await openChat();
    expect(screen.getByText("O assistente vê o texto do ticket e esta conversa. Ele não executa nem altera nada.")).toBeInTheDocument();
  });

  it("lists the conversation with the newest at the bottom and loads the earlier ones with the opaque cursor", async () => {
    const { chat, client, user } = await openChat();
    chat.seedConversation("t1", Array.from({ length: 20 }, (_, index) => ({ person: `pergunta ${index + 1}`, assistant: `resposta ${index + 1}` })));
    await user.click(screen.getByRole("button", { name: "Voltar para a lista de chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    await screen.findByText("resposta 20");
    const texts = within(log()).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(texts.at(-1)).toContain("resposta 20");
    expect(screen.queryByText("pergunta 1")).toBeNull();
    const before = vi.mocked(client.getTicketChat).mock.calls.at(-1)![1];
    expect(before).toEqual({ limit: 30 });
    await user.click(screen.getByRole("button", { name: "Carregar mensagens anteriores" }));
    expect(await screen.findByText("pergunta 1")).toBeInTheDocument();
    const second = vi.mocked(client.getTicketChat).mock.calls.at(-1)![1] as { before: string };
    expect(second.before).toMatch(/^c\d+$/);
    expect(screen.queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();
  });

  it("sends with Enter, breaks the line with Shift+Enter and does not send an empty message", async () => {
    const { chat, user } = await openChat();
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(chat.conversationOf("t1")).toHaveLength(0);
    await user.type(field(), "primeira linha{Shift>}{Enter}{/Shift}segunda");
    expect(field()).toHaveValue("primeira linha\nsegunda");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(chat.conversationOf("t1")[0]).toEqual({ authorId: "person-1", body: "primeira linha\nsegunda" });
    expect(field()).toHaveValue("");
  });

  it("does not send with Enter while an IME composition is going on", async () => {
    const { chat } = await openChat();
    fireEvent.change(field(), { target: { value: "かな" } });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(chat.conversationOf("t1")).toHaveLength(0);
  });

  it("shows the counter near the limit and blocks over it", async () => {
    const { client, user } = await openChat();
    fireEvent.change(field(), { target: { value: "a".repeat(3700) } });
    expect(screen.getByText("3.700 de 4.000")).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "a".repeat(4001) } });
    expect(screen.getByText("4.001 de 4.000: passou do limite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("talking to the assistant", () => {
  function deferred() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { gate, release };
  }

  it("shows the message at once, a skeleton in place of the reply, and then the reply", async () => {
    const { client, user } = await openChat();
    const { gate, release } = deferred();
    const real = vi.mocked(client.sendChatMessage).getMockImplementation()!;
    vi.mocked(client.sendChatMessage).mockImplementation(async (...args) => { await gate; return real(...args); });
    await user.type(field(), "Como começo?{Enter}");
    expect(within(log()).getByText("Como começo?")).toBeInTheDocument();
    expect(document.querySelector(".assistant-skeleton")).not.toBeNull();
    expect(screen.getByText("O assistente está respondendo…")).toBeInTheDocument();
    release();
    expect(await screen.findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(document.querySelector(".assistant-skeleton")).toBeNull();
  });

  it("announces the reply politely and reads the reply of the assistant in the restricted markdown", async () => {
    const { user } = await openChat({ reply: () => "# Passos\n\n- um\n- **dois**" });
    await user.type(field(), "Plano?{Enter}");
    expect(await screen.findByRole("heading", { name: "Passos" })).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status", { name: "Resposta do assistente" })).toHaveTextContent("Passos");
  });

  it("keeps the message as unanswered with Tentar de novo when the provider fails, and sends it again", async () => {
    const { client, user } = await openChat();
    const real = vi.mocked(client.sendChatMessage).getMockImplementation()!;
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(failed("unavailable", "assistant_unavailable"));
    await user.type(field(), "Me ajuda{Enter}");
    expect(await screen.findByText("Não respondida")).toBeInTheDocument();
    expect(within(log()).getByText("Me ajuda")).toBeInTheDocument();
    vi.mocked(client.sendChatMessage).mockImplementation(real);
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(screen.queryByText("Não respondida")).toBeNull();
    expect(within(log()).getAllByText("Me ajuda")).toHaveLength(1);
  });

  it.each([
    ["chat_busy", "conflict", /Já há uma mensagem sua esperando/],
    ["chat_changed", "conflict", /A conversa mudou em outro aparelho/],
  ] as const)("on %s reloads the conversation, warns and keeps what was typed", async (code, kind, phrase) => {
    const { chat, client, user } = await openChat();
    chat.seedConversation("t1", [{ person: "antes", assistant: "ok" }]);
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(failed(kind, code));
    const loads = vi.mocked(client.getTicketChat).mock.calls.length;
    await user.type(field(), "texto que não pode se perder{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(phrase);
    expect(field()).toHaveValue("texto que não pode se perder");
    expect(vi.mocked(client.getTicketChat).mock.calls.length).toBeGreaterThan(loads);
    expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("Não respondida")).toBeNull();
  });

  it("without the organization's consent shows the usual phrase, blocks the assistant but keeps threads working", async () => {
    const { chat, user } = await openChat({ assistant: "no_consent", me: makeMe({ assistant: true, consent: false }) });
    expect(screen.getByRole("alert")).toHaveTextContent("A IA está desligada nesta organização. Um administrador precisa ativá-la em Configurações. As threads com outras pessoas continuam funcionando.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Crie o ticket manualmente");
    await user.type(field(), "Oi assistente");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Mencionar" }));
    await user.click(await screen.findByRole("button", { name: "Bia" }));
    expect(field()).toHaveValue("Oi assistente");
    await user.click(screen.getByRole("button", { name: "Abrir thread (não vai ao assistente)" }));
    expect(await screen.findByText("você, para Bia")).toBeInTheDocument();
    expect(chat.conversationOf("t1")).toHaveLength(0);
  });

  it("learns that the consent is missing from the server's answer and shows the phrase", async () => {
    const { user } = await openChat({ assistant: "no_consent" });
    await user.type(field(), "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("As threads com outras pessoas continuam funcionando.");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("without a provider on the server says so and still lets people open threads", async () => {
    const { user } = await openChat({ assistant: "not_configured" });
    await user.type(field(), "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("A IA não está configurada neste servidor");
    expect(screen.getByRole("button", { name: "Mencionar" })).toBeEnabled();
  });

  it("clears only the conversation with the assistant, after a confirmation that says threads stay", async () => {
    const { chat, user } = await openChat();
    chat.seedConversation("t1", [{ person: "pergunta antiga", assistant: "resposta antiga" }]);
    chat.receiveThread("t1", { from: "person-2", body: "uma thread" });
    await user.click(screen.getByRole("button", { name: "Voltar para a lista de chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    await screen.findByText("resposta antiga");
    await user.click(screen.getByRole("button", { name: "Opções do chat" }));
    await user.click(screen.getByRole("button", { name: "Limpar a minha conversa" }));
    expect(screen.getByText("Apaga só a sua conversa com o assistente. As threads ficam.")).toBeInTheDocument();
    expect(chat.conversationOf("t1")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /^Confirmar/ }));
    await waitFor(() => expect(chat.conversationOf("t1")).toHaveLength(0));
    expect(screen.queryByText("resposta antiga")).toBeNull();
    expect(screen.getByText("uma thread")).toBeInTheDocument();
  });
});

describe("mentions and threads", () => {
  async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole("button", { name: "Mencionar" }));
    await user.click(await screen.findByRole("button", { name }));
  }

  it("offers only active people who see the ticket, never oneself, and turns the choice into a removable pill", async () => {
    const { user } = await openChat();
    await user.click(screen.getByRole("button", { name: "Mencionar" }));
    const picker = await screen.findByRole("dialog", { name: "Mencionar pessoas" });
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["Bia", "Caio"]);
    await user.click(within(picker).getByRole("button", { name: "Bia" }));
    expect(screen.queryByRole("dialog", { name: "Mencionar pessoas" })).toBeNull();
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remover menção a Bia" }));
    expect(screen.queryByRole("button", { name: "Remover menção a Bia" })).toBeNull();
  });

  it("in a private project only people who see it are offered", async () => {
    const { makeProject } = await import("../test/fakes.js");
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }, { personId: "person-3", role: "reader" }] });
    const { user } = await openChat({ projects: [project] });
    await user.click(screen.getByRole("button", { name: "Mencionar" }));
    const picker = await screen.findByRole("dialog", { name: "Mencionar pessoas" });
    expect(within(picker).getAllByRole("button").map((button) => button.textContent)).toEqual(["Caio"]);
  });

  it("opens the same picker with @ and takes the @ out of the text", async () => {
    const { user } = await openChat();
    await user.type(field(), "olá @");
    expect(await screen.findByRole("dialog", { name: "Mencionar pessoas" })).toBeInTheDocument();
    expect(field()).toHaveValue("olá ");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Mencionar pessoas" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Chats" })).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("with a mention the button says it opens a thread that does not go to the assistant, and sends the ids", async () => {
    const { chat, client, user } = await openChat();
    await user.type(field(), "Bia, pode olhar?");
    await pick(user, "Bia");
    await user.click(screen.getByRole("button", { name: "Abrir thread (não vai ao assistente)" }));
    expect(client.sendChatMessage).toHaveBeenCalledWith("t1", { body: "Bia, pode olhar?", mentions: ["person-2"] }, expect.anything());
    expect(await screen.findByText("você, para Bia")).toBeInTheDocument();
    expect(chat.conversationOf("t1")).toHaveLength(0);
    expect(screen.queryByText("Resposta do assistente.")).toBeNull();
    expect(field()).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Remover menção/ })).toBeNull();
  });

  it("never searches the text for names: a pasted \"@Bia\" stays text and goes to the assistant without mentions", async () => {
    const { client, user } = await openChat();
    fireEvent.change(field(), { target: { value: "@Bia oi" } });
    await user.click(field());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    expect(vi.mocked(client.sendChatMessage).mock.calls[0]![1]).toEqual({ body: "@Bia oi" });
  });

  it("flags the people the API refused and keeps the text", async () => {
    const { client, user } = await openChat();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(failed("unavailable", "mention_not_allowed", undefined));
    await user.type(field(), "Oi");
    await pick(user, "Caio");
    await user.click(screen.getByRole("button", { name: "Abrir thread (não vai ao assistente)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Alguém mencionado não enxerga este ticket");
    expect(field()).toHaveValue("Oi");
    expect(screen.getByRole("button", { name: "Remover menção a Caio" })).toBeInTheDocument();
  });

  it("opens a thread: the root, the replies and a field to reply that can mention more people", async () => {
    const { chat, client, user } = await openChat();
    chat.receiveThread("t1", { from: "person-2", body: "Raiz da thread", replies: [{ from: "person-3", body: "Primeira resposta" }] });
    await user.click(screen.getByRole("button", { name: "Voltar para a lista de chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByText("de Bia, numa thread")).toBeInTheDocument();
    expect(screen.getByText("1 resposta")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await screen.findByText("Primeira resposta")).toBeInTheDocument();
    expect(screen.getByText("Raiz da thread")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Responder na thread" }), "Eu respondo{Enter}");
    expect(await screen.findByText("Eu respondo")).toBeInTheDocument();
    expect(client.replyChatThread).toHaveBeenCalledWith("m1", { body: "Eu respondo" });
    await user.click(screen.getByRole("button", { name: "Voltar à conversa" }));
    expect(await screen.findByText("2 respostas")).toBeInTheDocument();
  });

  it("always shows the thread messages as plain text with line breaks, never as the assistant's markdown", async () => {
    const { chat, user } = await openChat();
    chat.receiveThread("t1", { from: "person-2", body: "# não é título\n**nem negrito**" });
    await user.click(screen.getByRole("button", { name: "Voltar para a lista de chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    const root = await screen.findByText(/não é título/);
    expect(root.textContent).toBe("# não é título\n**nem negrito**");
    expect(document.querySelector(".chat-thread-root h1, .chat-thread-root strong")).toBeNull();
  });
});

describe("who sees what: assigned to me × started by me", () => {
  async function open(assignedToMe: boolean, startedByMe: boolean) {
    const user = userEvent.setup();
    const ticket = { ...ALFA2, assignedToMe };
    const view = renderChats({ tickets: [ticket] });
    if (startedByMe) view.chat.receiveThread("t2", { from: "person-1", body: "minha thread", to: ["person-2"] });
    else view.chat.receiveThread("t2", { from: "person-2", body: "thread do outro" });
    await user.click(await screen.findByRole("button", { name: /^Chats/ }));
    await user.click(await screen.findByRole("button", { name: /ALFA-2/ }));
    await screen.findByRole("tab", { name: "Conversa" });
    return { user, ...view };
  }
  const inConversation = (text: string) => screen.queryByText(text) !== null;

  it("assigned, started by the other: in the conversation and in Menções", async () => {
    const { user } = await open(true, false);
    expect(inConversation("thread do outro")).toBe(true);
    await user.click(screen.getByRole("tab", { name: /^Menções/ }));
    expect(inConversation("thread do outro")).toBe(true);
  });

  it("assigned, started by me: in the conversation only", async () => {
    const { user } = await open(true, true);
    expect(inConversation("minha thread")).toBe(true);
    await user.click(screen.getByRole("tab", { name: /^Menções/ }));
    expect(inConversation("minha thread")).toBe(false);
  });

  it("not assigned, started by me: still in the conversation (never lost)", async () => {
    const { user } = await open(false, true);
    expect(inConversation("minha thread")).toBe(true);
    await user.click(screen.getByRole("tab", { name: /^Menções/ }));
    expect(inConversation("minha thread")).toBe(false);
  });

  it("not assigned, started by the other and no conversation: Menções is the main tab and the conversation does not repeat it", async () => {
    const { user } = await open(false, false);
    expect(screen.getByRole("tab", { name: /^Menções/ })).toHaveAttribute("aria-selected", "true");
    expect(inConversation("thread do outro")).toBe(true);
    await user.click(screen.getByRole("tab", { name: "Conversa" }));
    expect(inConversation("thread do outro")).toBe(false);
  });
});

describe("what was read", () => {
  /** Painel e chat abertos depois de `seed` mexer no chat em memória. */
  async function openSeeded(seed: (chat: ReturnType<typeof renderChats>["chat"]) => void, setup: ChatSetup = {}) {
    const user = userEvent.setup();
    const view = renderChats(setup);
    seed(view.chat);
    await user.click(await screen.findByRole("button", { name: /^Chats/ }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    await screen.findByRole("tab", { name: "Conversa" });
    return { user, ...view };
  }

  it("marks the conversation as read up to the newest message shown, once the end of the list is visible", async () => {
    const { client } = await openSeeded((chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]));
    await waitFor(() => expect(client.markChatRead).toHaveBeenCalledWith("t1", { upTo: "c2" }));
    expect(client.markChatRead).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Chats" })).toBeInTheDocument());
  });

  it("does not mark anything while the end of the list is out of sight, and marks when the person scrolls to it", async () => {
    const top = vi.spyOn(Element.prototype, "scrollTop", "get").mockReturnValue(0);
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
    const { client } = await openSeeded((chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]));
    await screen.findByText("olá");
    expect(client.markChatRead).not.toHaveBeenCalled();
    top.mockReturnValue(1700);
    fireEvent.scroll(log());
    await waitFor(() => expect(client.markChatRead).toHaveBeenCalledWith("t1", { upTo: "c2" }));
  });

  it("opening a thread marks it as read up to its newest reply, and the button count goes down", async () => {
    const { chat, client, user } = await openSeeded((chat) => {
      chat.receiveThread("t1", { from: "person-2", body: "Raiz", replies: [{ from: "person-2", body: "Resposta" }] });
    });
    expect(screen.getByRole("button", { name: "Chats, não lidas: 1" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Abrir thread" }));
    await screen.findByText("Resposta");
    await waitFor(() => expect(client.markChatRead).toHaveBeenCalledWith("t1", { upTo: "c2" }));
    void chat;
    await waitFor(() => expect(screen.getByRole("button", { name: "Chats" })).toBeInTheDocument());
  });
});

describe("rendering text safely", () => {
  const hostile = [
    "![x](http://evil.example/leak?q=1)",
    "![ref][r]",
    "<img src=\"http://evil.example/p.png\" onerror=\"alert(1)\"><iframe src=\"http://evil.example\"></iframe><script>alert(1)</script>",
    "[clique](javascript:alert(1))",
    "[ok](https://exemplo.com/p)",
    "",
    "[r]: http://evil.example/ref.png",
  ].join("\n");

  it("shows the assistant's reply without images, raw HTML or dangerous links, and fetches nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { user } = await openChat({ reply: () => hostile });
    await user.type(field(), "Mostre{Enter}");
    await screen.findByText(/clique/);
    await waitFor(() => expect(document.querySelector(".chat-assistant .tiptap")).not.toBeNull());
    const scope = log();
    expect(scope.querySelector("img, iframe, script, object, embed, link, video, audio, source")).toBeNull();
    for (const link of scope.querySelectorAll("a")) {
      const href = link.getAttribute("href") ?? "";
      expect(href === "" || /^https?:\/\//.test(href), href).toBe(true);
      expect(link).toHaveAttribute("target", "_blank");
      const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
    expect(scope.querySelector('a[href^="javascript"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows a person's message as plain text, turning only http(s) addresses into links", async () => {
    const { chat, user } = await openChat();
    chat.receiveThread("t1", { from: "person-2", body: "veja https://exemplo.com/a?b=1, e javascript:alert(1) e <b>x</b> ![i](http://e.example/i.png)" });
    await user.click(screen.getByRole("button", { name: "Voltar para a lista de chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    const root = await screen.findByText(/veja/);
    const links = [...root.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://exemplo.com/a?b=1", "http://e.example/i.png"]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(root.querySelector("img, b")).toBeNull();
    expect(root).toHaveTextContent("<b>x</b>");
  });

  it("uses no remote image for people: initials only", async () => {
    const { chat, user } = await openChat();
    chat.receiveThread("t1", { from: "person-2", body: "oi" });
    await user.click(screen.getByRole("button", { name: "Voltar para a lista de chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    await screen.findByText("oi");
    expect(screen.getByRole("complementary", { name: "Chats" }).querySelector("img")).toBeNull();
  });
});

describe("archived project and languages", () => {
  it("is read-only in an archived project: says so and does not send", async () => {
    const { client, user } = await openChat({ tickets: [{ ...ALFA2, assignedToMe: true, archived: true }] }, "ALFA-2");
    expect(screen.getByText("O projeto está arquivado e só aceita leitura.")).toBeInTheDocument();
    await user.type(field(), "Oi{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it("renders in English and in Mexican Spanish", async () => {
    const { setTestLanguage } = await import("../test/i18n.js");
    await setTestLanguage("en");
    const user = userEvent.setup();
    renderChats();
    await user.click(await screen.findByRole("button", { name: "Chats" }));
    expect(await screen.findByRole("heading", { name: "My chats" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByRole("tab", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Mentions" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it.each([
    ["en", "AI is off for this organization. An administrator needs to turn it on in Settings. Threads with other people keep working."],
    ["es-MX", "La IA está desactivada en esta organización. Un administrador debe activarla en Configuración. Los hilos con otras personas siguen funcionando."],
  ])("says in %s that threads keep working when the organization has not accepted", async (language, phrase) => {
    const { setTestLanguage } = await import("../test/i18n.js");
    await setTestLanguage(language as "en" | "es-MX");
    const user = userEvent.setup();
    renderChats({ assistant: "no_consent", me: makeMe({ assistant: true, consent: false }) });
    await user.click(await screen.findByRole("button", { name: /^Chats/ }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(phrase);
  });

  it("renders in Mexican Spanish", async () => {
    const { setTestLanguage } = await import("../test/i18n.js");
    await setTestLanguage("es-MX");
    const user = userEvent.setup();
    renderChats();
    await user.click(await screen.findByRole("button", { name: "Chats" }));
    expect(await screen.findByRole("heading", { name: "Mis chats" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByRole("tab", { name: "Conversación" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toBeInTheDocument();
  });
});

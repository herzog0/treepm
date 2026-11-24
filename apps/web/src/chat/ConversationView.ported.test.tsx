import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failed, makeMe, makeProject } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ALFA2, renderChats } from "./chatTesting.js";
import { linkOf, mention } from "./mentionTesting.js";
import type { ChatSetup } from "./chatTesting.js";
import { composerNow, composerShown, fillComposer, typeInComposer } from "./composerTesting.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Chats = ReturnType<typeof renderChats>;

/** Monta a barra e abre a conversa do ticket pela linha dela (por padrão ALFA-1, de que a pessoa é responsável). */
async function openChat(setup: ChatSetup = {}, ticketKey = "ALFA-1", fieldName: string = "Mensagem") {
  const user = userEvent.setup();
  const view = renderChats(setup);
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${ticketKey}`) }));
  await screen.findByRole("combobox", { name: fieldName });
  return { user, ...view };
}
const field = () => composerNow("Mensagem").dom;
const log = () => screen.getByRole("log", { name: "Mensagens" });
const panel = () => screen.getByRole("complementary", { name: "Conversa" });
const readCalls = (client: Chats["client"]) => [...vi.mocked(client.getTicketConversationView).mock.calls, ...vi.mocked(client.getConversationView).mock.calls];

describe("writing in the open conversation", () => {
  it("sends with Enter, breaks the line with Shift+Enter and does not send an empty message", async () => {
    const { chat, client, user } = await openChat();
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(chat.conversationOf("t1")).toHaveLength(0);
    typeInComposer("primeira linha{Shift>}{Enter}{/Shift}segunda");
    expect(composerShown()).toBe("primeira linha\nsegunda");
    await user.keyboard("{Enter}");
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(chat.conversationOf("t1")[0]).toEqual({ authorId: "person-1", body: "primeira linha\nsegunda" });
    expect(composerShown()).toBe("");
  });

  it("does not send with Enter while an IME composition is going on", async () => {
    const { client } = await openChat();
    fillComposer("かな");
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(client.openTicketConversation).not.toHaveBeenCalled();
  });

  it("shows the counter near the limit and blocks over it", async () => {
    const { client, user } = await openChat();
    fillComposer("a".repeat(3700));
    expect(screen.getByText("3.700 de 4.000")).toBeInTheDocument();
    fillComposer("a".repeat(4001));
    expect(screen.getByText("4.001 de 4.000: passou do limite")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await user.click(field());
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it("states what the assistant sees and that it does not run or change anything", async () => {
    await openChat();
    expect(screen.getByText("O assistente vê este ticket e consulta os outros que você enxerga. Ele não cria nem altera nada.")).toBeInTheDocument();
  });

  it("shows the message at once, a skeleton in place of the reply, and then the reply", async () => {
    const { client } = await openChat();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = vi.mocked(client.sendChatMessage).getMockImplementation()!;
    vi.mocked(client.sendChatMessage).mockImplementation(async (...args) => { await gate; return real(...args); });
    typeInComposer("Como começo?{Enter}");
    expect(within(log()).getByText("Como começo?")).toBeInTheDocument();
    expect(document.querySelector(".assistant-skeleton")).not.toBeNull();
    expect(screen.getByText("O assistente está respondendo…")).toBeInTheDocument();
    release();
    expect(await within(log()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(document.querySelector(".assistant-skeleton")).toBeNull();
  });

  it("announces the reply politely and reads the reply of the assistant in the restricted markdown", async () => {
    await openChat({ reply: () => "# Passos\n\n- um\n- **dois**" });
    typeInComposer("Plano?{Enter}");
    expect(await screen.findByRole("heading", { name: "Passos" })).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status", { name: "Resposta do assistente" })).toHaveTextContent("Passos");
  });
});

describe("mentions", () => {
  it("offers only active people, never oneself, and turns the choice into a removable pill", async () => {
    const { user } = await openChat();
    typeInComposer("@");
    const picker = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(within(picker).getAllByRole("option").map((option) => option.querySelector(".mention-option-title")?.textContent)).toEqual(["Bia", "Caio"]);
    await user.click(within(picker).getByRole("option", { name: "Bia" }));
    expect(screen.queryByRole("listbox", { name: "Pessoas" })).toBeNull();
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remover menção a Bia" }));
    expect(screen.queryByRole("button", { name: "Remover menção a Bia" })).toBeNull();
  });

  it("in a private project only people who see it can be chosen; the others show dimmed, with the reason", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }, { personId: "person-3", role: "reader" }] });
    await openChat({ projects: [project] });
    typeInComposer("@");
    const picker = await screen.findByRole("listbox", { name: "Pessoas" });
    const chosen = within(picker).getAllByRole("option").filter((option) => option.getAttribute("aria-disabled") !== "true");
    expect(chosen.map((option) => option.querySelector(".mention-option-title")?.textContent)).toEqual(["Caio"]);
    expect(within(picker).getByRole("option", { name: /Bia/ })).toHaveTextContent("Não enxerga o projeto deste ticket");
  });

  it("opens the picker with @ and keeps what is typed in the field; Esc closes only the picker and leaves the text", async () => {
    const { user } = await openChat();
    typeInComposer("olá @");
    expect(await screen.findByRole("listbox", { name: "Pessoas" })).toBeInTheDocument();
    expect(composerShown()).toBe("olá @");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Pessoas" })).toBeNull();
    expect(composerShown()).toBe("olá @");
    expect(panel()).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("with a mention the button opens a thread that does not go to the assistant, and sends the ids", async () => {
    const { chat, client, user } = await openChat();
    typeInComposer("Bia, pode olhar?");
    await mention("Bia");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledWith(chat.principalOf("t1")!, { body: `Bia, pode olhar? ${linkOf("person-2", "Bia")}`, mentions: ["person-2"] }, expect.anything()));
    expect(await within(panel()).findByRole("button", { name: /Thread com Bia/ })).toBeInTheDocument();
    expect(chat.conversationOf("t1").filter((message) => message.authorId === null)).toHaveLength(0);
    expect(screen.queryByText("Resposta do assistente.")).toBeNull();
    expect(composerShown()).toBe("");
    expect(screen.queryByRole("button", { name: /Remover menção/ })).toBeNull();
  });

  it("never searches the text for names: a pasted \"@Bia\" stays text and goes to the assistant without mentions", async () => {
    const { client, user } = await openChat();
    fillComposer("@Bia oi");
    expect(screen.queryByRole("listbox", { name: "Pessoas" })).toBeNull();
    expect(composerShown()).toBe("@Bia oi");
    await user.click(field());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    expect(vi.mocked(client.sendChatMessage).mock.calls[0]![1]).toEqual({ body: "@Bia oi" });
  });

  it("flags the people the API refused and keeps the text", async () => {
    const { client, user } = await openChat();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(failed("unavailable", "mention_not_allowed", undefined));
    typeInComposer("Oi");
    await mention("Caio");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Alguém marcado não pode participar desta conversa");
    expect(composerShown()).toBe("Oi @Caio ");
    expect(screen.getByRole("button", { name: "Remover menção a Caio" })).toBeInTheDocument();
  });
});

describe("failures talking to the assistant", () => {
  it("keeps the message as unanswered with Tentar de novo when the provider fails, and sends it again", async () => {
    const { client, user } = await openChat();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(failed("unavailable", "assistant_unavailable"));
    typeInComposer("Me ajuda{Enter}");
    expect(await screen.findByText("Não respondida")).toBeInTheDocument();
    expect(within(log()).getByText("Me ajuda")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await within(log()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(screen.queryByText("Não respondida")).toBeNull();
    expect(within(log()).getAllByText("Me ajuda")).toHaveLength(1);
  });

  it.each([
    ["chat_busy", "conflict", /Já há uma mensagem sua esperando/],
    ["chat_changed", "conflict", /A conversa mudou em outro aparelho/],
  ] as const)("on %s reloads the conversation, warns and keeps what was typed", async (code, kind, phrase) => {
    const { client } = await openChat({ seed: (chat) => chat.seedConversation("t1", [{ person: "antes", assistant: "ok" }]) });
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(failed(kind, code));
    const loads = readCalls(client).length;
    typeInComposer("texto que não pode se perder{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(phrase);
    expect(composerShown()).toBe("texto que não pode se perder");
    await waitFor(() => expect(readCalls(client).length).toBeGreaterThan(loads));
    expect(await within(log()).findByText("ok")).toBeInTheDocument();
    expect(screen.queryByText("Não respondida")).toBeNull();
  });

  it("without the organization's consent shows the usual phrase, blocks the assistant but keeps threads working", async () => {
    const { chat, user } = await openChat({ assistant: "no_consent", me: makeMe({ assistant: true, consent: false }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("A IA está desligada nesta organização. Um administrador precisa ativá-la em Configurações. As threads com outras pessoas continuam funcionando.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Crie o ticket manualmente");
    typeInComposer("Oi assistente");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await mention("Bia");
    expect(composerShown()).toBe("Oi assistente @Bia ");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await within(panel()).findByRole("button", { name: /Thread com Bia/ })).toBeInTheDocument();
    expect(chat.conversationOf("t1").filter((message) => message.authorId === null)).toHaveLength(0);
  });

  it("learns that the consent is missing from the server's answer and shows the phrase", async () => {
    await openChat({ assistant: "no_consent" });
    typeInComposer("Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("As threads com outras pessoas continuam funcionando.");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    expect(composerShown()).toBe("Oi");
  });

  it("without a provider on the server says so and still lets people open threads", async () => {
    await openChat({ assistant: "not_configured" });
    typeInComposer("Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("A IA não está configurada neste servidor");
    typeInComposer(" @");
    expect(await screen.findByRole("listbox", { name: "Pessoas" })).toBeInTheDocument();
  });

  it("clears only the conversation with the assistant, after a confirmation that says threads stay", async () => {
    const { chat, user } = await openChat({
      seed: (c) => {
        c.seedConversation("t1", [{ person: "pergunta antiga", assistant: "resposta antiga" }]);
        c.receiveThread("t1", { from: "person-2", body: "uma thread" });
      },
    });
    await within(log()).findByText("resposta antiga");
    await user.click(screen.getByRole("button", { name: "Opções do chat" }));
    await user.click(screen.getByRole("button", { name: "Limpar a minha conversa" }));
    expect(screen.getByText("Apaga só a sua conversa com o assistente. As threads ficam.")).toBeInTheDocument();
    expect(chat.conversationOf("t1")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /^Confirmar/ }));
    await waitFor(() => expect(chat.conversationOf("t1")).toHaveLength(0));
    await waitFor(() => expect(within(log()).queryByText("resposta antiga")).toBeNull());
    expect(within(panel()).getByText("uma thread")).toBeInTheDocument();
  });
});

describe("reading", () => {
  it("lists the conversation with the newest at the bottom and loads the earlier ones with the opaque cursor", async () => {
    const { client, user } = await openChat({ seed: (chat) => chat.seedConversation("t1", Array.from({ length: 20 }, (_, index) => ({ person: `pergunta ${index + 1}`, assistant: `resposta ${index + 1}` }))) });
    await within(log()).findByText("resposta 20");
    const texts = within(log()).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(texts.at(-1)).toContain("resposta 20");
    expect(screen.queryByText("pergunta 1")).toBeNull();
    expect(readCalls(client).at(-1)![1]).toEqual({ limit: 30 });
    await user.click(screen.getByRole("button", { name: "Carregar mensagens anteriores" }));
    expect(await within(log()).findByText("pergunta 1")).toBeInTheDocument();
    const second = readCalls(client).at(-1)![1] as { before: string };
    expect(second.before).toMatch(/^c\d+$/);
    expect(screen.queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();
  });

  it("marks the conversation as read up to the newest message shown, once the end of the list is visible", async () => {
    const { chat, client } = await openChat({ seed: (c) => c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    await within(log()).findByText("olá");
    await waitFor(() => expect(client.markConversationRead).toHaveBeenCalledWith(chat.principalOf("t1")!, { upTo: "c2" }));
    expect(client.markConversationRead).toHaveBeenCalledTimes(1);
  });

  it("does not mark anything while the end of the list is out of sight, and marks when the person scrolls to it", async () => {
    const top = vi.spyOn(Element.prototype, "scrollTop", "get").mockReturnValue(0);
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2000);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
    const { chat, client } = await openChat({ seed: (c) => c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    await within(log()).findByText("olá");
    expect(client.markConversationRead).not.toHaveBeenCalled();
    top.mockReturnValue(1700);
    fireEvent.scroll(log());
    await waitFor(() => expect(client.markConversationRead).toHaveBeenCalledWith(chat.principalOf("t1")!, { upTo: "c2" }));
  });

  it("opening a thread marks it as read up to its newest reply", async () => {
    const user = userEvent.setup();
    const { client } = renderChats({ seed: (chat) => chat.receiveThread("t1", { from: "person-2", body: "Raiz", replies: [{ from: "person-2", body: "Resposta" }] }) });
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await within(panel()).findByText("Resposta");
    await waitFor(() => expect(client.markConversationRead).toHaveBeenCalledWith(expect.any(String), { upTo: "c2" }));
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
    await openChat({ reply: () => hostile });
    typeInComposer("Mostre{Enter}");
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
    await openChat({ seed: (chat) => chat.seedConversation("t1", [{ person: "veja https://exemplo.com/a?b=1, e javascript:alert(1) e <b>x</b> ![i](http://e.example/i.png)", assistant: "ok" }]) });
    const root = await within(log()).findByText(/veja/);
    const links = [...root.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://exemplo.com/a?b=1", "http://e.example/i.png"]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(root.querySelector("img, b")).toBeNull();
    expect(root).toHaveTextContent("<b>x</b>");
  });

  it("shows a person's message with markdown characters as literal text, never as the assistant's markdown", async () => {
    await openChat({ seed: (chat) => chat.seedConversation("t1", [{ person: "# não é título\n**nem negrito**", assistant: "ok" }]) });
    const root = await within(log()).findByText(/não é título/);
    expect(root.textContent).toBe("# não é título\n**nem negrito**");
    expect(within(log()).queryByRole("heading")).toBeNull();
    expect(log().querySelector("strong")).toBeNull();
  });

  it("uses no remote image for people: initials only", async () => {
    await openChat({ seed: (chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    await within(log()).findByText("olá");
    expect(panel().querySelector("img")).toBeNull();
  });
});

describe("archived project and languages", () => {
  it("is read-only in an archived project: says so, turns the field, mention and send off, and does not send", async () => {
    const { client } = await openChat({ tickets: [{ ...ALFA2, assignedToMe: true, archived: true }] }, "ALFA-2");
    expect(await screen.findByText("O projeto está arquivado e só aceita leitura.")).toBeInTheDocument();
    expect(field()).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
    // O campo é só de leitura: o `@` não escreve nada nem abre a lista (e o campo diz que não está expandido).
    typeInComposer("@");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(composerShown()).toBe("");
    typeInComposer("Oi{Enter}");
    expect(composerShown()).toBe("");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it("renders in English", async () => {
    await setTestLanguage("en");
    const user = userEvent.setup();
    const { client } = renderChats({ seed: (chat) => chat.seedConversation("t1", Array.from({ length: 20 }, (_, index) => ({ person: `q ${index + 1}`, assistant: `a ${index + 1}` }))) });
    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await screen.findByRole("complementary", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByText("The assistant sees this ticket and looks up the others you can see. It doesn't create or change anything.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    expect(readCalls(client).at(-1)![1]).toMatchObject({ before: expect.stringMatching(/^c\d+$/) });
    typeInComposer("@", composerNow("Message"));
    expect(await screen.findByRole("listbox", { name: "People" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mention" })).toBeNull();
  });

  it("renders in Mexican Spanish and keeps the word thread", async () => {
    await setTestLanguage("es-MX");
    const user = userEvent.setup();
    renderChats({ seed: (chat) => chat.receiveThread("t1", { from: "person-2", body: "Hola" }) });
    expect(await screen.findByRole("heading", { name: "Conversaciones" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const view = await screen.findByRole("complementary", { name: "Conversación" });
    expect(screen.getByRole("combobox", { name: "Mensaje" })).toBeInTheDocument();
    typeInComposer("@", composerNow("Mensaje"));
    expect(await screen.findByRole("listbox", { name: "Personas" })).toBeInTheDocument();
    expect(await within(view).findByRole("button", { name: /Thread con Bia/ })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/hilo/i);
  });

  it.each([
    ["en", "AI is off for this organization. An administrator needs to turn it on in Settings. Threads with other people keep working."],
    ["es-MX", "La IA está desactivada en esta organización. Un administrador debe activarla en Configuración. Los threads con otras personas siguen funcionando."],
  ] as const)("says in %s that threads keep working when the organization has not accepted", async (language, phrase) => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    renderChats({ assistant: "no_consent", me: makeMe({ assistant: true, consent: false }) });
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(phrase);
  });

  it.each([
    ["en", "AI is not configured on this server."],
    ["es-MX", "La IA no está configurada en este servidor."],
  ] as const)("says in %s that there is no provider", async (language, phrase) => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    renderChats({ assistant: "not_configured" });
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const input = await screen.findByRole("combobox", { name: language === "en" ? "Message" : "Mensaje" });
    await user.type(input, "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(phrase);
  });
});

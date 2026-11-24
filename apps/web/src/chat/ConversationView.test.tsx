import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderChats } from "./chatTesting.js";
import { mention } from "./mentionTesting.js";

const panel = () => screen.findByRole("complementary", { name: "Conversa" });
const write = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const field = await screen.findByRole("combobox", { name: /^(Mensagem|Responder na thread)$/ });
  await user.type(field, text);
};

describe("the open conversation", () => {
  it("reads a row with no conversation without creating anything, and the first send creates it once and then sends", async () => {
    const { client, chat } = renderChats();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await write(user, "Oi assistente");
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(await within(await panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
    expect(client.sendChatMessage).toHaveBeenCalledWith(chat.principalOf("t1")!, { body: "Oi assistente" }, expect.anything());
    // A barra ganha a conversa sem recarregar a página: a linha passa a ter prévia.
    await waitFor(() => expect(screen.getByRole("button", { name: /^ALFA-1/ })).toHaveTextContent("Resposta do assistente."));
    await write(user, "Outra");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(2));
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
  });

  it("the general chat is created on the first send, not on click", async () => {
    const { client } = renderChats();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await write(user, "Oi");
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(client.getConversationView).not.toHaveBeenCalled();
    expect(within(await panel()).getByText("O assistente consulta os tickets dos projetos que você enxerga. Ele não cria nem altera nada.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(await within(await panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(client.openGeneralConversation).toHaveBeenCalledTimes(1);
  });

  it("says the message opens a thread only when someone is marked, and sends the marked ids", async () => {
    const { client } = renderChats({ seed: (chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await write(user, "Bia, olha");
    expect(screen.queryByText(/abre uma thread com/)).toBeNull();
    await mention(user, "Bia");
    await mention(user, "Caio");
    expect(screen.getByText("Esta mensagem abre uma thread com Bia e Caio. Quem já está nesta conversa também participa.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledWith(expect.any(String), { body: "Bia, olha", mentions: ["person-2", "person-3"] }, expect.anything()));
    // O cartão da thread aparece na própria mensagem, com o rodapé que a abre.
    const card = await within(await panel()).findByRole("button", { name: /Thread com Bia \+1/ });
    expect(card).toHaveTextContent(/0 resposta/);
  });

  it("opens a thread from its card, shows the trail and goes back through it", async () => {
    const { chat } = renderChats({
      seed: (c) => {
        const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        c.openThreadIn(main, { from: "person-1", body: "Bia, olha isto", to: ["person-2"], replies: [{ from: "person-2", body: "Já vi" }] });
      },
    });
    void chat;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const card = await within(await panel()).findByRole("button", { name: /Thread com Bia.*1 resposta/ });
    await user.click(card);
    const view = await panel();
    expect(await within(view).findByText("Já vi")).toBeInTheDocument();
    const trail = within(view).getByRole("navigation", { name: "Onde você está" });
    expect(within(trail).getByRole("button", { name: "ALFA-1" })).toBeInTheDocument();
    expect(within(trail).getByText("Thread com Bia")).toHaveAttribute("aria-current", "page");
    expect(within(view).queryByRole("button", { name: "Limpar a minha conversa" })).toBeNull();
    await user.click(within(trail).getByRole("button", { name: "ALFA-1" }));
    expect(await within(await panel()).findByText("olá")).toBeInTheDocument();
  });

  it("turns the people selector off, with the reason, when the conversation is at the last level", async () => {
    renderChats({
      seed: (c) => {
        let parent = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        for (let depth = 1; depth <= 9; depth++) parent = c.openThreadIn(parent, { from: "person-1", body: `nível ${depth}`, to: ["person-2"] });
      },
    });
    const user = userEvent.setup();
    const rows = await screen.findAllByRole("button", { name: /Thread com Bia/ });
    await user.click(rows.at(-1)!);
    expect(await within(await panel()).findByText("Esta conversa está no último nível: não dá para abrir outra thread aqui dentro.")).toBeInTheDocument();
    await user.type(await screen.findByRole("combobox", { name: "Responder na thread" }), "@");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the guest only his thread under the ticket: no link above, no 'back', nothing that hints at what is above", async () => {
    renderChats({
      as: "person-3",
      seed: (c) => {
        const main = c.seedConversation("t1", [{ person: "segredo do dono", assistant: "resposta secreta" }]);
        const first = c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        c.openThreadIn(first, { from: "person-2", body: "Caio, e você?", to: ["person-3"], replies: [{ from: "person-3", body: "Posso sim" }] });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com/ }));
    const view = await panel();
    expect(await within(view).findByText("Posso sim")).toBeInTheDocument();
    const trail = within(view).getByRole("navigation", { name: "Onde você está" });
    expect(within(trail).queryAllByRole("button")).toHaveLength(0);
    expect(within(trail).getAllByRole("listitem")).toHaveLength(1);
    expect(within(view).getAllByRole("log").length).toBe(1);
    expect(document.body).not.toHaveTextContent(/segredo|secreta|Bia, olha/);
    expect(within(view).getAllByRole("listitem").filter((li) => li.classList.contains("chat-message")).map((li) => li.querySelector(".chat-text")?.textContent)).toEqual(["Caio, e você?", "Posso sim"]);
  });

  it("lets only who opened the thread include people, with the warning, and refuses with the right text", async () => {
    renderChats({
      seed: (c) => {
        const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await user.click(await screen.findByRole("button", { name: "Incluir pessoas" }));
    const dialog = await screen.findByRole("dialog", { name: "Incluir pessoas na thread" });
    expect(within(dialog).getByText("Quem entra vê o histórico desta thread e das threads dentro dela.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Caio" }));
    await user.click(within(dialog).getByRole("button", { name: "Incluir" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Incluir pessoas na thread" })).toBeNull());
    expect(await within(await panel()).findByText("Caio")).toBeInTheDocument();
  });

  it("does not offer to include people to someone who did not open the thread", async () => {
    renderChats({ seed: (c) => c.receiveThread("t1", { from: "person-2", body: "Ana, olha", replies: [{ from: "person-2", body: "oi" }] }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await within(await panel()).findByText("oi");
    expect(screen.queryByRole("button", { name: "Incluir pessoas" })).toBeNull();
  });

  it("in the general chat a mention opens the thread there and sends no ticket with it (the # is what takes a message to a ticket)", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedGeneral([{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await write(user, "Bia, olha o login");
    expect(screen.queryByRole("button", { name: "Sobre o ticket…" })).toBeNull();
    await mention(user, "Bia");
    expect(screen.queryByRole("button", { name: "Sobre o ticket…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledWith(expect.any(String), { body: "Bia, olha o login", mentions: ["person-2"] }, expect.anything()));
  });
});

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderChats } from "./chatTesting.js";

// `main.tsx` monta a aplicação em StrictMode: em desenvolvimento cada efeito roda montar, limpar, montar.
describe("Chats under StrictMode", () => {
  it("loads the messages of a chat instead of staying on the loading text", async () => {
    const { chat } = renderChats({ strict: true });
    chat.seedConversation("t1", [{ person: "Pergunta de Ana", assistant: "Resposta do assistente" }]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    const panel = await screen.findByRole("complementary", { name: "Conversa" });
    expect(await within(panel).findByText("Pergunta de Ana")).toBeInTheDocument();
    expect(within(panel).getByText("Resposta do assistente")).toBeInTheDocument();
  });

  it("loads the messages of a thread opened from a mention", async () => {
    renderChats({ strict: true, seed: (chat) => chat.receiveThread("t1", { from: "person-2", body: "Raiz da thread", replies: [{ from: "person-2", body: "Primeira resposta" }] }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    const panel = await screen.findByRole("complementary", { name: "Conversa" });
    expect(await within(panel).findByText("Raiz da thread")).toBeInTheDocument();
    expect(await within(panel).findByText("Primeira resposta")).toBeInTheDocument();
  });
});

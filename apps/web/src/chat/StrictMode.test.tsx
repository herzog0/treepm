import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderChats } from "./chatTesting.js";

// `main.tsx` monta a aplicação em StrictMode: em desenvolvimento cada efeito roda montar, limpar, montar.
describe("Chats under StrictMode", () => {
  it("loads the messages of a chat instead of staying on the loading text", async () => {
    const { chat } = renderChats({ strict: true });
    chat.seedConversation("t1", [{ person: "Pergunta de Ana", assistant: "Resposta do assistente" }]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Chats/ }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByText("Pergunta de Ana")).toBeInTheDocument();
    expect(screen.getByText("Resposta do assistente")).toBeInTheDocument();
  });

  it("loads the messages of a thread opened from a mention", async () => {
    const { chat } = renderChats({ strict: true });
    chat.receiveThread("t1", { from: "person-2", body: "Raiz da thread", replies: [{ from: "person-2", body: "Primeira resposta" }] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Chats/ }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    await user.click(await screen.findByRole("button", { name: "Abrir thread" }));
    expect(await screen.findByText("Raiz da thread")).toBeInTheDocument();
    expect(await screen.findByText("Primeira resposta")).toBeInTheDocument();
  });
});

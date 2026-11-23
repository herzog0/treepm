import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";

async function openPanel(setup: Parameters<typeof renderChats>[0] = {}) {
  const user = userEvent.setup();
  const view = renderChats(setup);
  await user.click(await screen.findByRole("button", { name: /^Chats/ }));
  return { user, ...view };
}

describe("My chats list", () => {
  it("says where the chats appear when there is none", async () => {
    await openPanel({ tickets: [ALFA2] });
    expect(await screen.findByText("Os chats dos tickets de que você é responsável aparecem aqui.")).toBeInTheDocument();
  });

  it("shows one row per chat with the key, the title and the unread mark", async () => {
    const { chat } = renderChats({ tickets: [ALFA1, ALFA2] });
    chat.receiveThread("t2", { from: "person-2", body: "Olha isto", replies: [{ from: "person-2", body: "e isto" }] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Chats/ }));
    const rows = await screen.findAllByRole("button", { name: /ALFA-/ });
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => /ALFA-2/.test(row.textContent ?? ""))!;
    expect(second).toHaveTextContent("Publicar a versão");
    expect(within(second).getByText("2 não lidas")).toBeInTheDocument();
    const first = rows.find((row) => /ALFA-1/.test(row.textContent ?? ""))!;
    expect(first).toHaveTextContent("Responsável");
    expect(within(first).queryByText(/não lida/)).toBeNull();
  });

  it("opens the chat of the row", async () => {
    const { user } = await openPanel();
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByRole("tab", { name: "Conversa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voltar para a lista de chats" })).toBeInTheDocument();
  });

  it("moves between the rows with the arrow keys", async () => {
    const { chat, user } = await openPanel();
    chat.seedConversation("t2", [{ person: "oi", assistant: "olá" }]);
    await user.click(screen.getByRole("button", { name: "Fechar o painel de chats" }));
    await user.click(screen.getByRole("button", { name: /^Chats/ }));
    const rows = await screen.findAllByRole("button", { name: /ALFA-/ });
    rows[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rows[0]).toHaveFocus();
  });

  it("tells that the list could not be loaded and loads it again", async () => {
    const { client, user } = await openPanel();
    vi.mocked(client.listChats).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } });
    await user.click(screen.getByRole("button", { name: "Fechar o painel de chats" }));
    await user.click(screen.getByRole("button", { name: /^Chats/ }));
    expect(await screen.findByText("Não foi possível carregar os chats.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByRole("button", { name: /ALFA-1/ })).toBeInTheDocument();
  });
});

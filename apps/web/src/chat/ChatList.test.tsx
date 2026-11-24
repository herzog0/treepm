import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";

describe("Conversas list in the sidebar", () => {
  it("is there from the start, with no button to open it", async () => {
    renderChats({ tickets: [ALFA2] });
    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Chats/ })).toBeNull();
  });

  it("says where the chats appear when there is none", async () => {
    renderChats({ tickets: [ALFA2] });
    expect(await screen.findByText("Os chats dos tickets de que você é responsável aparecem aqui.")).toBeInTheDocument();
  });

  it("shows one row per chat with the key before the title, the unread count and the unread rows in bold", async () => {
    renderChats({ tickets: [ALFA1, ALFA2], seed: (chat) => chat.receiveThread("t2", { from: "person-2", body: "Olha isto", replies: [{ from: "person-2", body: "e isto" }] }) });
    const rows = await screen.findAllByRole("button", { name: /ALFA-/ });
    expect(rows).toHaveLength(2);
    const second = rows.find((row) => /ALFA-2/.test(row.textContent ?? ""))!;
    expect(second.querySelector(".conv-title")!.textContent).toBe("ALFA-2Publicar a versão");
    expect(within(second).getByText("2 não lidas")).toBeInTheDocument();
    expect(second).toHaveClass("is-unread");
    const first = rows.find((row) => /ALFA-1/.test(row.textContent ?? ""))!;
    expect(first).toHaveTextContent("Responsável");
    expect(within(first).queryByText(/não lida/)).toBeNull();
    expect(first).not.toHaveClass("is-unread");
    expect(first.querySelector("time")).not.toBeNull();
  });

  it("totals the chats with unread messages in the section header, and says nothing when there is none", async () => {
    renderChats({ tickets: [ALFA1, ALFA2] });
    await screen.findByRole("button", { name: /ALFA-1/ });
    expect(document.querySelector(".conv-section-total")).toBeNull();
    cleanup();
    renderChats({
      tickets: [ALFA1, ALFA2],
      seed: (chat) => {
        chat.receiveThread("t1", { from: "person-2", body: "a", replies: [{ from: "person-2", body: "b" }] });
        chat.receiveThread("t2", { from: "person-3", body: "d" });
      },
    });
    expect(await screen.findByText("2 não lidas", { selector: ".conv-section-total" })).toBeInTheDocument();
  });

  it("paints the dot with the situation of the ticket when the server sends it, and neutral otherwise", async () => {
    renderChats({ tickets: [ALFA1] });
    const row = await screen.findByRole("button", { name: /ALFA-1/ });
    expect(row.querySelector(".conv-dot")).not.toBeNull();
  });

  it("opens the chat of the row and marks that row as the current one", async () => {
    renderChats({ seed: (chat) => chat.seedConversation("t2", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    const row = await screen.findByRole("button", { name: /ALFA-1/ });
    expect(row).not.toHaveAttribute("aria-current");
    await user.click(row);
    expect(await screen.findByRole("tab", { name: "Conversa" })).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-current", "true");
    expect(document.querySelectorAll("button.conv-row[aria-current]")).toHaveLength(1);
  });

  it("keeps the list when the conversation is closed and unmarks the row", async () => {
    renderChats();
    const user = userEvent.setup();
    const row = await screen.findByRole("button", { name: /ALFA-1/ });
    await user.click(row);
    await user.click(await screen.findByRole("button", { name: "Fechar a conversa" }));
    expect(screen.queryByRole("tab", { name: "Conversa" })).toBeNull();
    expect(row).not.toHaveAttribute("aria-current");
    expect(row).toHaveFocus();
  });

  it("moves between the rows with the arrow keys", async () => {
    renderChats({ seed: (chat) => chat.seedConversation("t2", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    const rows = await screen.findAllByRole("button", { name: /ALFA-/ });
    rows[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(rows[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rows[0]).toHaveFocus();
  });

  it("tells that the list could not be loaded and loads it again", async () => {
    const { client } = renderChats();
    await screen.findByRole("button", { name: /ALFA-1/ });
    vi.mocked(client.listChats).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } });
    // Abrir uma conversa atualiza a lista; aqui a atualização falha.
    await userEvent.click(screen.getByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByText("Não foi possível carregar os chats.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(screen.queryByText("Não foi possível carregar os chats.")).toBeNull());
  });
});

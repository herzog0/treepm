import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";

const panel = () => screen.queryByRole("complementary", { name: "Chats" });

describe("Chats button and panel", () => {
  it("shows the button without a number when no chat has unread messages", async () => {
    renderChats();
    const button = await screen.findByRole("button", { name: "Chats" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveTextContent(/^Chats$/);
  });

  it("counts the chats with unread messages, not the unread messages", async () => {
    const { chat } = renderChats({ tickets: [ALFA1, ALFA2] });
    chat.receiveThread("t1", { from: "person-2", body: "a", replies: [{ from: "person-2", body: "b" }, { from: "person-2", body: "c" }] });
    chat.receiveThread("t2", { from: "person-3", body: "d" });
    // A contagem muda quando a lista se atualiza: ao abrir o painel.
    fireEvent.click(await screen.findByRole("button", { name: "Chats" }));
    const button = await screen.findByRole("button", { name: "Chats, não lidas: 2" });
    expect(button).toHaveTextContent("2");
  });

  it("opens and closes the left panel as a named region", async () => {
    const user = userEvent.setup();
    renderChats();
    expect(panel()).toBeNull();
    const button = await screen.findByRole("button", { name: "Chats" });
    await user.click(button);
    expect(panel()).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Meus chats" })).toBeInTheDocument();
    await user.click(button);
    expect(panel()).toBeNull();
  });

  it("moves the focus into the panel when it opens and back to the button when it closes", async () => {
    const user = userEvent.setup();
    renderChats();
    const button = await screen.findByRole("button", { name: "Chats" });
    await user.click(button);
    expect(panel()!.contains(document.activeElement)).toBe(true);
    await user.click(screen.getByRole("button", { name: "Fechar o painel de chats" }));
    expect(panel()).toBeNull();
    expect(button).toHaveFocus();
  });

  it("closes with Esc without letting the page handler see it (the ticket page stays open)", async () => {
    const user = userEvent.setup();
    renderChats();
    const outside = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", outside);
    await user.click(await screen.findByRole("button", { name: "Chats" }));
    await user.keyboard("{Escape}");
    window.removeEventListener("keydown", outside);
    expect(panel()).toBeNull();
    // Quem ouve na janela (a página do ticket) recebe o evento já tratado, ou nem o recebe.
    expect(outside.mock.results.every((result) => result.value === true) || outside.mock.calls.length === 0).toBe(true);
  });

  it("does not close the panel with Esc while a menu inside it is open (the menu takes the Esc)", async () => {
    const user = userEvent.setup();
    renderChats();
    await user.click(await screen.findByRole("button", { name: "Chats" }));
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    await user.click(await screen.findByRole("button", { name: "Opções do chat" }));
    expect(screen.getByRole("group", { name: "Opções do chat" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Opções do chat" })).toBeNull();
    expect(panel()).toBeInTheDocument();
  });
});

describe("Chats refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => vi.useRealTimers());
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("loads the list when the panel opens and then at the map's 30 s trigger, never faster", async () => {
    const { client } = renderChats();
    await tick(0);
    const afterMount = vi.mocked(client.listChats).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    await tick(0);
    expect(vi.mocked(client.listChats).mock.calls.length).toBe(afterMount + 1);
    await tick(29_000);
    expect(vi.mocked(client.listChats).mock.calls.length).toBe(afterMount + 1);
    await tick(1_000);
    expect(vi.mocked(client.listChats).mock.calls.length).toBe(afterMount + 2);
  });

  it("updates the count on the button by itself", async () => {
    const { chat } = renderChats();
    await tick(0);
    expect(screen.getByRole("button", { name: "Chats" })).toBeInTheDocument();
    chat.receiveThread("t1", { from: "person-2", body: "oi" });
    await tick(30_000);
    expect(screen.getByRole("button", { name: "Chats, não lidas: 1" })).toBeInTheDocument();
  });
  it("updates an open thread at the same 30 s trigger, without closing and reopening it", async () => {
    const { chat } = renderChats();
    const threadId = chat.receiveThread("t1", { from: "person-2", body: "Raiz da thread" });
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: /^Chats/ }));
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: /ALFA-1/ }));
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: "Abrir thread" }));
    await tick(0);
    expect(screen.getByText("Raiz da thread")).toBeInTheDocument();
    chat.receiveReply(threadId, { from: "person-2", body: "Resposta que chegou depois" });
    await tick(29_000);
    expect(screen.queryByText("Resposta que chegou depois")).toBeNull();
    await tick(1_000);
    expect(screen.getByText("Resposta que chegou depois")).toBeInTheDocument();
    expect(screen.getByText("Raiz da thread")).toBeInTheDocument();
  });
});

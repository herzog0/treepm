import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";

const rowsOf = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")];
const level = (row: HTMLElement) => row.style.getPropertyValue("--conv-level");

describe("the conversations tree in the sidebar", () => {
  it("is there from the start, with no button to open it, and the general chat comes first", async () => {
    renderChats({ tickets: [ALFA2] });
    expect(await screen.findByRole("heading", { name: "Conversas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Chats/ })).toBeNull();
    const rows = rowsOf();
    expect(rows[0]).toHaveTextContent("Meu chat");
    expect(rows[0]).toHaveTextContent("Só você e o assistente");
  });

  it("shows one row per ticket with the key before the title, the unread count and the unread rows in bold", async () => {
    renderChats({ tickets: [ALFA1, ALFA2], seed: (chat) => chat.receiveThread("t2", { from: "person-2", body: "Olha isto", replies: [{ from: "person-2", body: "e isto" }] }) });
    const second = await screen.findByRole("button", { name: /ALFA-2/ });
    expect(second.querySelector(".conv-title")!.textContent).toBe("ALFA-2 Publicar a versão");
    const thread = await screen.findByRole("button", { name: /Thread com Bia/ });
    expect(within(thread).getByText("2 não lidas")).toBeInTheDocument();
    expect(thread).toHaveClass("is-unread");
    const first = screen.getByRole("button", { name: /ALFA-1/ });
    expect(within(first).getByRole("img", { name: "Você é responsável" })).toBeInTheDocument();
    expect(first).not.toHaveTextContent("Responsável");
    expect(first).not.toHaveClass("is-unread");
    expect(thread.querySelector("time")).not.toBeNull();
  });

  it("nests a thread under the conversation it was opened in, and a thread inside a thread one level lower", async () => {
    renderChats({
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        const first = chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        chat.openThreadIn(first, { from: "person-2", body: "Caio, e você?", to: ["person-3"] });
      },
    });
    const ticket = await screen.findByRole("button", { name: /ALFA-1/ });
    const first = await screen.findByRole("button", { name: /Thread com Bia(?! \+)/ });
    const second = await screen.findByRole("button", { name: /Thread com Bia \+1/ });
    expect(level(ticket)).toBe("0");
    expect(level(first)).toBe("1");
    expect(level(second)).toBe("2");
    // A thread de dentro mora na lista da thread de cima, que mora na lista do ticket.
    expect(second.closest("ul")!.closest("li")!.querySelector(":scope > button")).toBe(first);
    expect(first.closest("ul")!.closest("li")!.querySelector(":scope > button")).toBe(ticket);
  });

  it("stops growing the indentation after the fifth level (the tree can be deeper than ten)", async () => {
    renderChats({
      seed: (chat) => {
        let parent = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        for (let depth = 1; depth <= 8; depth++) parent = chat.openThreadIn(parent, { from: "person-1", body: `nível ${depth}`, to: ["person-2"] });
      },
    });
    await screen.findByRole("button", { name: /ALFA-1/ });
    await screen.findAllByRole("button", { name: /Thread com Bia/ });
    const levels = rowsOf().filter((row) => /Thread/.test(row.textContent ?? "")).map(level);
    expect(levels).toEqual(["1", "2", "3", "4", "5", "5", "5", "5"]);
  });

  it("paints the dot with the situation of the ticket", async () => {
    renderChats({ tickets: [{ ...ALFA1, status: "in_progress" }, { ...ALFA2, assignedToMe: true, status: "todo", blocked: true }] });
    const doing = (await screen.findByRole("button", { name: /ALFA-1/ })).querySelector<HTMLElement>(".conv-dot")!;
    const blocked = screen.getByRole("button", { name: /ALFA-2/ }).querySelector<HTMLElement>(".conv-dot")!;
    expect(doing.style.background).toBe("var(--tp-doing)");
    expect(blocked.style.background).toBe("var(--tp-blocked)");
  });

  it("marks the same color on the thread row as on its card (stable by the thread id)", async () => {
    renderChats({ seed: (chat) => chat.receiveThread("t2", { from: "person-2", body: "Olha isto" }) });
    const row = await screen.findByRole("button", { name: /Thread com Bia/ });
    expect(row.querySelector<HTMLElement>(".conv-thread-mark")!.style.background).toMatch(/^var\(--tp-thread-[1-6]\)$/);
  });

  it("totals the conversations with unread messages in the section header, and says nothing when there is none", async () => {
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

  it("opens the conversation of the row and marks that row as the current one", async () => {
    renderChats({ seed: (chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    const row = await screen.findByRole("button", { name: /ALFA-1/ });
    expect(row).not.toHaveAttribute("aria-current");
    await user.click(row);
    expect(await screen.findByRole("complementary", { name: "Conversa" })).toBeVisible();
    expect(row).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Meu chat/ })).not.toHaveAttribute("aria-current");
  });

  it("clicking a row that has no conversation yet only reads: no conversation is created, nothing is marked as read", async () => {
    const { client } = renderChats();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(await screen.findByRole("complementary", { name: "Conversa" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Meu chat/ }));
    expect(client.getTicketConversationView).toHaveBeenCalled();
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(client.markConversationRead).not.toHaveBeenCalled();
    expect(client.clearConversationMessages).not.toHaveBeenCalled();
  });

  it("moves between all the rows with the arrows, and Enter opens the focused row", async () => {
    renderChats({ seed: (chat) => chat.receiveThread("t2", { from: "person-2", body: "Olha isto" }) });
    const user = userEvent.setup();
    const [general] = [await screen.findByRole("button", { name: /Meu chat/ })];
    await screen.findByRole("button", { name: /Thread com Bia/ });
    general.focus();
    await user.keyboard("{ArrowDown}");
    expect(rowsOf()[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(rowsOf()[3]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(rowsOf()[2]).toHaveFocus();
    rowsOf()[2]!.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("complementary", { name: "Conversa" })).toBeVisible();
    expect(rowsOf()[2]).toHaveAttribute("aria-current", "true");
  });

  it("shows a guest only the thread he was marked in, under the ticket, with nothing about what is above", async () => {
    renderChats({
      as: "person-3",
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "segredo do dono", assistant: "resposta secreta" }]);
        const first = chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        chat.openThreadIn(first, { from: "person-2", body: "Caio, e você?", to: ["person-3"], replies: [{ from: "person-2", body: "resposta do Bia" }] });
      },
    });
    const thread = await screen.findByRole("button", { name: /Thread com/ });
    const rows = rowsOf().map((row) => row.textContent);
    expect(rows).toHaveLength(3); // chat geral, o ticket e a thread dele
    expect(level(thread)).toBe("1");
    expect(thread).toHaveTextContent("resposta do Bia");
    const ticket = screen.getByRole("button", { name: /ALFA-1/ });
    expect(ticket).toHaveTextContent(/^ALFA-1 Corrigir o login/);
    expect(ticket).not.toHaveTextContent(/segredo|secreta|Bia, olha/);
    expect(document.body).not.toHaveTextContent(/segredo|secreta|Bia, olha/);
  });
});

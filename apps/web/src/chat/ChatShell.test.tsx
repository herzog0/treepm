import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeClient, makePerson } from "../test/fakes.js";
import { createFakeChat } from "../test/chatFakes.js";
import { Sidebar } from "../nav/Sidebar.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

const sidebar = (
  <Sidebar view="map" onNavigate={vi.fn()} onNewTicket={vi.fn()} onSearch={vi.fn()} organization={<span>Org</span>} account={<span>Conta</span>} />
);

describe("app shell (ADR 0055)", () => {
  it("has no header: the fixed sidebar and the screen are the whole shell", () => {
    const { container } = render(<ChatShell sidebar={sidebar}><main>Conteúdo da tela</main></ChatShell>);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector(".tenant-header")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Barra lateral" })).toBeInTheDocument();
    expect(screen.getByText("Conteúdo da tela")).toBeInTheDocument();
  });

  it("opening a conversation gives the shell the split layout (the map shrinks) and closing gives the width back", async () => {
    const user = userEvent.setup();
    const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true }], people: [makePerson("person-1", "Ana")] });
    const { container } = render(
      <ChatsProvider client={makeClient({ chat })} onShowTicket={vi.fn()}>
        <ChatShell sidebar={sidebar}><main>Conteúdo da tela</main></ChatShell>
      </ChatsProvider>,
    );
    const shell = container.querySelector(".tenant-shell")!;
    expect(shell).not.toHaveClass("has-chat-panel");
    await user.click(await screen.findByRole("button", { name: /ALFA-1/ }));
    expect(shell).toHaveClass("has-chat-panel");
    expect(screen.getByRole("complementary", { name: "Conversa do ticket" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Fechar a conversa" }));
    expect(shell).not.toHaveClass("has-chat-panel");
    expect(screen.getByText("Conteúdo da tela")).toBeInTheDocument();
  });

  it("on a narrow screen the sidebar opens from the button of the top strip and closes on Esc", async () => {
    const user = userEvent.setup();
    const { container } = render(<ChatShell sidebar={sidebar}><main>Conteúdo</main></ChatShell>);
    const shell = container.querySelector(".tenant-shell")!;
    const button = screen.getByRole("button", { name: "Abrir o menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(shell).toHaveClass("has-drawer");
    expect(screen.getByRole("button", { name: "Fechar o menu" })).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(shell).not.toHaveClass("has-drawer");
  });

  it("closes the drawer when a destination is chosen", async () => {
    const user = userEvent.setup();
    const { container } = render(<ChatShell sidebar={sidebar}><main>Conteúdo</main></ChatShell>);
    await user.click(screen.getByRole("button", { name: "Abrir o menu" }));
    await user.click(screen.getByRole("button", { name: "Novo ticket" }));
    expect(container.querySelector(".tenant-shell")).not.toHaveClass("has-drawer");
  });
});

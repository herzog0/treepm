import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeClient } from "../test/fakes.js";
import { TenantHeader } from "../nav/TenantHeader.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

describe("chat shell and header", () => {
  it("the header is the old one (no Chats button) without the provider", () => {
    render(<TenantHeader view="map" onNavigate={vi.fn()}><span /></TenantHeader>);
    expect(screen.queryByRole("button", { name: /^Chats/ })).toBeNull();
  });

  it("the Chats button sits in the header, and opening the panel gives the shell the split layout (the map shrinks)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ChatsProvider client={makeClient()} onShowTicket={vi.fn()}>
        <ChatShell header={<TenantHeader view="map" onNavigate={vi.fn()}><span /></TenantHeader>}><main>Conteúdo da tela</main></ChatShell>
      </ChatsProvider>,
    );
    const shell = container.querySelector(".tenant-shell")!;
    expect(shell.querySelector(".tenant-header .tenant-chats")).not.toBeNull();
    expect(shell).not.toHaveClass("has-chat-panel");
    await user.click(screen.getByRole("button", { name: "Chats" }));
    expect(shell).toHaveClass("has-chat-panel");
    expect(screen.getByRole("complementary", { name: "Chats" })).toBeInTheDocument();
    expect(screen.getByText("Conteúdo da tela")).toBeInTheDocument();
  });
});

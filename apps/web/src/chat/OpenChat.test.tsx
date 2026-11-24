import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TicketPage } from "../ticket/TicketPage.js";
import { createFakeChat, makeMe, makePerson, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { ChatPanel } from "./ChatPanel.js";
import { ChatsProvider } from "./ChatsContext.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const ticket = makeTicket("t1", "p1", 1, "Corrigir o login", { key: "ALFA-1" });
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia")];

function setup(withProvider: boolean) {
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1" }], people });
  const client = makeTreeClient({ me: makeMe({ assistant: true }), projects: [project], tickets: { p1: [ticket] }, people, chat });
  const page = (
    <TicketPage client={client} me={makeMe({ assistant: true })} projects={[project]} ticketId="t1" creating={null} onOpenTicket={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} onRemoved={vi.fn()} onShowOnMap={vi.fn()} onStartCreate={vi.fn()} onCancelCreate={vi.fn()} onCreated={vi.fn()} />
  );
  render(withProvider ? <ChatsProvider client={client} onShowTicket={vi.fn()}>{page}<ChatPanel /></ChatsProvider> : page);
  return { client };
}

describe("Abrir chat on the ticket page", () => {
  it("opens the conversation column on that ticket's chat", async () => {
    const user = userEvent.setup();
    setup(true);
    await user.click(await screen.findByRole("button", { name: "Abrir chat" }));
    const panel = await screen.findByRole("complementary", { name: "Conversa" });
    expect(await screen.findByRole("combobox", { name: "Mensagem" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("ALFA-1");
  });

  it("is not there without the chats provider (the page is the same as before)", async () => {
    setup(false);
    await screen.findByRole("heading", { name: /Corrigir o login/ }).catch(() => undefined);
    expect(screen.queryByRole("button", { name: "Abrir chat" })).toBeNull();
  });
});

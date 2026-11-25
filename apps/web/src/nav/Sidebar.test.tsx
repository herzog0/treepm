import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatsProvider } from "../chat/ChatsContext.js";
import { createFakeChat } from "../test/chatFakes.js";
import { makeClient, makePerson } from "../test/fakes.js";
import { Sidebar } from "./Sidebar.js";
import type { View } from "./navigation.js";

function setup(view: View = "map", props: { withChats?: boolean } = {}) {
  const onNavigate = vi.fn();
  const onNewTicket = vi.fn();
  const onSearch = vi.fn();
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true }], people: [makePerson("person-1", "Ana")] });
  const sidebar = (
    <Sidebar view={view} onNavigate={onNavigate} onNewTicket={onNewTicket} onSearch={onSearch} organization={<button type="button">Organização de Teste</button>} account={<button type="button">Conta</button>} />
  );
  render(props.withChats === false ? sidebar : <ChatsProvider client={makeClient({ chat })} onShowTicket={vi.fn()}>{sidebar}</ChatsProvider>);
  return { onNavigate, onNewTicket, onSearch };
}

describe("fixed sidebar (ADR 0055)", () => {
  it("is one labelled navigation landmark, with the organization first and the person and settings last", () => {
    setup();
    const bar = screen.getByRole("navigation", { name: "Barra lateral" });
    const order = [...bar.querySelectorAll("button, a")].map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(order[0]).toBe("Organização de Teste");
    expect(order[1]).toBe("Novo ticket");
    expect(order[2]).toMatch(/^Buscar/);
    expect(order.slice(-2)).toEqual(["Conta", "Configurações"]);
  });

  it("offers Mapa, Ideias and Times as destinations and marks the current one", () => {
    setup("ideas");
    const sections = screen.getByRole("navigation", { name: "Seções" });
    expect(within(sections).getAllByRole("link").map((link) => link.textContent)).toEqual(["Mapa", "Ideias", "Times"]);
    expect(within(sections).getByRole("link", { name: "Ideias" })).toHaveAttribute("aria-current", "page");
    expect(within(sections).getByRole("link", { name: "Mapa" })).not.toHaveAttribute("aria-current");
  });

  it("treats the import screen as part of the map", () => {
    setup("import");
    expect(screen.getByRole("link", { name: "Mapa" })).toHaveAttribute("aria-current", "page");
  });

  it("puts Configurações in the footer with aria-current when it is the open screen", async () => {
    const { onNavigate } = setup("settings");
    const link = screen.getByRole("link", { name: "Configurações" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveAttribute("href", "/?view=settings");
    await userEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });

  it("runs the new ticket and the search actions", async () => {
    const { onNewTicket, onSearch } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Novo ticket" }));
    expect(onNewTicket).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /^Buscar/ }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("shows the conversations list without any click, and leaves it out without the chats provider", async () => {
    setup();
    expect(await screen.findByRole("button", { name: /^ALFA-1/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Conversas" })).toBeInTheDocument();
  });

  it("works without the chats provider (no conversations section)", () => {
    setup("map", { withChats: false });
    expect(screen.queryByRole("heading", { name: "Conversas" })).toBeNull();
    expect(screen.getByRole("link", { name: "Times" })).toBeInTheDocument();
  });
});

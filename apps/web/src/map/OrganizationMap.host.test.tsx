import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { ChatsProvider, useChats } from "../chat/ChatsContext.js";
import type { MapHost } from "../chat/ChatsContext.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import type { CommandRequest } from "./commandRequest.js";
import { OrganizationMap } from "./OrganizationMap.js";

// O mapa como hospedeiro da thread de criação (ADR 0056): ele empresta o projeto e o ticket abertos, recebe o card tracejado, roteia o
// clique de "Escolher no mapa", recarrega e abre a criação manual. A thread em si mora na coluna da conversa (`CreationThread.host.test.tsx`).
const SLOW = 20_000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", status: "todo" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "todo" }),
  ],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const me = (): Me => ({ ...makePanelMe("member", [{ projectId: "p1", role: "manager" }, { projectId: "p2", role: "manager" }]), assistant: { enabled: true } });

let host: MapHost | null = null;
let creationMode = false;
function Probe() {
  const chats = useChats();
  host = chats?.mapHost ?? null;
  creationMode = chats?.creationMode ?? false;
  return null;
}
function App({ client, onChange, onShowTicket, commandRequest }: { client: ApiClient; onChange?: (id: string | null) => void; onShowTicket?: (id: string) => void; commandRequest?: CommandRequest }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ChatsProvider client={client} onShowTicket={onShowTicket ?? (() => undefined)}>
      <OrganizationMap client={client} me={me()} commandRequest={commandRequest ?? null} onCommandHandled={() => undefined} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />
      <Probe />
    </ChatsProvider>
  );
}
function makeFullClient(): ApiClient {
  const client = makeClient({ projects, tickets, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, { getTicket: vi.fn(async (id: string) => ok(detailOf(tickets.p1!.find((entry) => entry.id === id)!))) });
  return client;
}
const theHost = async (): Promise<MapHost> => {
  await waitFor(() => expect(host).not.toBeNull(), { timeout: SLOW });
  return host!;
};
async function node(name: RegExp) {
  const found = await screen.findByRole("button", { name }, { timeout: SLOW });
  await waitFor(() => expect(found).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
  return found;
}
async function exploreAlfa() {
  await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
  await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
}

describe("o mapa hospeda a thread de criação", () => {
  it("empresta os projetos em que a pessoa cria e o projeto e o escopo do ticket selecionado", async () => {
    render(<App client={makeFullClient()} />);
    const h = await theHost();
    expect(h.creatable.map((project) => project.id)).toEqual(["p1", "p2"]);
    // Sem seleção e com vários projetos: nenhum projeto aberto, nenhum escopo.
    expect(h.projectId()).toBeNull();
    expect(h.scopeTicketId()).toBeNull();
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-1 · Acesso/));
    // Um ticket selecionado (com ou sem filhos, ADR 0034) é o escopo, e o projeto dele é o aberto.
    await waitFor(() => expect(host!.scopeTicketId()).toBe("t1"));
    expect(host!.projectId()).toBe("p1");
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await waitFor(() => expect(host!.scopeTicketId()).toBe("t3"));
  }, SLOW);

  it("um projeto selecionado dá o projeto e nenhum escopo", async () => {
    render(<App client={makeFullClient()} />);
    await userEvent.click(await screen.findByRole("button", { name: /BETA · Projeto Beta/ }));
    const h = await theHost();
    await waitFor(() => expect(h.projectId()).toBe("p2"));
    expect(h.scopeTicketId()).toBeNull();
  }, SLOW);

  it("o card tracejado aparece sob o destino, não é ticket e some quando o rascunho some", async () => {
    const onChange = vi.fn();
    render(<App client={makeFullClient()} onChange={onChange} />);
    const h = await theHost();
    await exploreAlfa();
    expect(screen.queryByRole("button", { name: /Rascunho/ })).not.toBeInTheDocument();
    act(() => h.onDraftChange({ projectId: "p1", parentId: "t1", title: "Corrigir o login" }));
    const ghost = await node(/Rascunho do ticket.*Corrigir o login/);
    await userEvent.click(ghost);
    await userEvent.click(ghost);
    expect(onChange).not.toHaveBeenCalledWith(expect.anything());
    expect(screen.queryByRole("complementary", { name: "Página do ticket" })).not.toBeInTheDocument();
    act(() => h.onDraftChange({ projectId: "p1", parentId: null, title: "Corrigir o login" }));
    await screen.findByRole("button", { name: /Rascunho do ticket.*Corrigir o login/ });
    act(() => h.onDraftChange(null));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Rascunho do ticket/ })).not.toBeInTheDocument());
  }, SLOW);

  describe("Escolher no mapa", () => {
    it("o clique em um ticket vai à thread, sem abrir o ticket nem o cartão de seleção", async () => {
      const onChange = vi.fn();
      render(<App client={makeFullClient()} onChange={onChange} />);
      const h = await theHost();
      await exploreAlfa();
      await userEvent.click(await node(/ALFA-1 · Acesso/));
      const pick = vi.fn();
      act(() => h.registerPicker({ pick, cancel: vi.fn() }));
      await userEvent.click(await node(/ALFA-3 · Publicar/));
      expect(pick).toHaveBeenCalledWith(expect.objectContaining({ kind: "ticket", id: "t3" }));
      expect(onChange).not.toHaveBeenCalledWith("t3");
    }, SLOW);

    it("o clique em um projeto vai à thread e não abre o painel de áreas", async () => {
      render(<App client={makeFullClient()} />);
      const h = await theHost();
      await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
      await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
      const pick = vi.fn();
      act(() => h.registerPicker({ pick, cancel: vi.fn() }));
      await userEvent.click(screen.getByRole("button", { name: /BETA · Projeto Beta/ }));
      expect(pick).toHaveBeenCalledWith(expect.objectContaining({ kind: "project", id: "p2" }));
      expect(screen.queryByRole("complementary", { name: "Áreas e projetos" })).not.toBeInTheDocument();
    }, SLOW);

    it("Esc no mapa cancela a escolha", async () => {
      render(<App client={makeFullClient()} />);
      const h = await theHost();
      const cancel = vi.fn();
      act(() => h.registerPicker({ pick: vi.fn(), cancel }));
      screen.getByRole("region", { name: "Mapa da organização" }).focus();
      await userEvent.keyboard("{Escape}");
      expect(cancel).toHaveBeenCalledTimes(1);
    }, SLOW);
  });

  it("onChanged recarrega os tickets do mapa", async () => {
    const client = makeFullClient();
    render(<App client={client} />);
    const h = await theHost();
    await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }, { timeout: SLOW });
    const reloads = vi.mocked(client.listTickets).mock.calls.length;
    act(() => h.onChanged());
    await waitFor(() => expect(vi.mocked(client.listTickets).mock.calls.length).toBeGreaterThan(reloads));
  }, SLOW);

  it("a criação manual abre o modo de criação da página do ticket, com o rascunho preenchido", async () => {
    render(<App client={makeFullClient()} />);
    const h = await theHost();
    act(() => h.onManualCreate({ projectId: "p1", parentId: null, draft: { title: "Corrigir o login", description: "O login falha no Safari." } }));
    expect(await screen.findByRole("textbox", { name: "Título" }, { timeout: SLOW })).toHaveValue("Corrigir o login");
    expect(screen.getByRole("textbox", { name: "Descrição" })).toHaveTextContent("O login falha no Safari.");
  }, SLOW);

  it("'Novo ticket' da barra lateral põe o campo do Meu chat no modo de novo ticket (com o assistente ligado)", async () => {
    render(<App client={makeFullClient()} commandRequest={{ kind: "new", id: 1 }} />);
    await waitFor(() => expect(creationMode).toBe(true), { timeout: SLOW });
  }, SLOW);
});

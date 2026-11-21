import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, PlacementOutcome, TicketDetail, TicketSummary } from "./api/client.js";
import { AssistantPanel } from "./assistant/AssistantPanel.js";
import { ImportScreen } from "./import/ImportScreen.js";
import { ProjectsSection } from "./panel/ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson } from "./panel/testing.js";
import { TicketPage } from "./ticket/TicketPage.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "./test/fakes.js";

/** ADR 0034: não existe mais agrupador; nenhum texto, nome acessível ou dica das telas principais usa a palavra. */
const WORD = /agrupador/i;

/** Todos os textos que a pessoa lê ou ouve: o conteúdo e os atributos de nome, descrição e dica. */
function renderedTexts(): string[] {
  const texts: string[] = [document.body.textContent ?? ""];
  for (const element of document.body.querySelectorAll("*")) {
    for (const name of ["aria-label", "title", "placeholder", "aria-description", "alt"]) {
      const value = element.getAttribute(name);
      if (value) texts.push(value);
    }
  }
  return texts;
}
const expectNoWord = () => {
  const found = renderedTexts().filter((text) => WORD.test(text));
  expect(found, `texto com "agrupador": ${found.join(" | ").slice(0, 300)}`).toEqual([]);
};

const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 2, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("t3", "p1", 3, "Senha", { key: "ALFA-3", parentId: "t1" }),
  makeTicket("t4", "p1", 4, "Solto", { key: "ALFA-4" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
const people = [makePerson("person-1", "Ana")];

function pageClient(): ApiClient {
  const client = makeClient({ me: { ...makePanelMe("admin"), assistant: { enabled: true } }, projects: [alfa], people, tickets: { p1: tickets }, summaries: { texts: {} } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(tickets.find((entry) => entry.id === id)!))),
    updateTicket: vi.fn(async () => failed("conflict", "ticket_has_open_children")),
    removeTicket: vi.fn(async () => failed("conflict", "ticket_has_children")),
    createTicket: vi.fn(async () => failed("conflict", "project_archived")),
  });
  return client;
}
function showPage(ticketId: string | null, creating: { projectId: string; parentId: string | null } | null = null) {
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const me = { ...makePanelMe("admin"), assistant: { enabled: true } };
  render(<TicketPage client={pageClient()} me={me} projects={[alfa]} ticketId={ticketId} creating={creating} {...handlers} />);
}

describe("no screen says 'agrupador' (ADR 0034)", () => {
  it("ticket page with children, including the open-items refusal, the parent picker and the removal error", async () => {
    showPage("t1");
    await screen.findByRole("heading", { level: 1, name: "Acesso" });
    await screen.findByRole("region", { name: "O que entra aqui" });
    expectNoWord();
    await userEvent.click(screen.getByRole("button", { name: "Concluído" }));
    await screen.findByRole("alert");
    expectNoWord();
    await userEvent.click(screen.getByRole("button", { name: "Mudar" }));
    expectNoWord();
  });

  it("ticket page without children, with the empty items state and the removal error", async () => {
    showPage("t4");
    await screen.findByRole("heading", { level: 1, name: "Solto" });
    expect(screen.getByText("Nenhum ticket aqui dentro.")).toBeInTheDocument();
    expectNoWord();
    await userEvent.click(screen.getByRole("button", { name: "Remover ticket" }));
    expectNoWord();
  });

  it("ticket page of a ticket inside another, and the creation form inside a ticket and at the root", async () => {
    showPage("t2");
    await screen.findByRole("heading", { level: 1, name: "Login" });
    expectNoWord();
  });

  it("creation form", async () => {
    showPage(null, { projectId: "p1", parentId: "t1" });
    await screen.findByRole("heading", { level: 1, name: "Novo ticket" });
    expectNoWord();
  });

  it("project detail, with the assistant on and off", async () => {
    for (const assistantAvailable of [true, false]) {
      const { unmount } = render(<ProjectsSection client={makePanelClient({ projects: [alfa], people })} me={makePanelMe("admin")} projects={[alfa]} selectedProject={alfa} onChanged={vi.fn()} onCreateTicket={vi.fn()} onImportProject={vi.fn()} assistantAvailable={assistantAvailable} />);
      await screen.findByRole("heading", { name: "Projeto Alfa" });
      expectNoWord();
      unmount();
    }
  });

  it("import screen", async () => {
    const client = makeClient({ me: makePanelMe("admin"), projects: [alfa] });
    render(<ImportScreen client={client} me={makePanelMe("admin")} projectId="p1" onExit={vi.fn()} />);
    await screen.findByText("Importar lista");
    expectNoWord();
  });

  it("assistant panel with a new parent proposal, an uncertain result, an early stop, an out-of-scope warning and 'Escolher no mapa'", async () => {
    const proposal = { title: "Redefinição de senha", description: "Fluxos de senha.", tickets: [{ id: "t3", number: 3, title: "Senha" }, { id: "t4", number: 4, title: "Solto" }] };
    const outcome: PlacementOutcome = makePlacement({
      destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] },
      alternatives: [{ parentId: "t4", path: [{ id: "t4", title: "Solto" }] }],
      uncertain: true,
      stoppedEarly: { reason: "candidates_too_large", level: 1, parentId: "t1" },
      scope: { id: "t1", title: "Acesso", outOfScope: true },
      groupProposal: proposal,
    });
    const client = makeClient({ projects: [alfa] });
    Object.assign(client, {
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
      findPlacement: vi.fn(async () => ok(outcome)),
    });
    render(<AssistantPanel client={client} projects={[alfa]} initialProjectId="p1" initialScopeId="t1" tickets={{ p1: tickets }} onClose={vi.fn()} onCreated={vi.fn()} onManualCreate={vi.fn()} onDraftChange={vi.fn()} onChanged={vi.fn()} registerPicker={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(screen.getByRole("button", { name: "Criar ticket pai e mover" })).toBeInTheDocument();
    expectNoWord();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    expectNoWord();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", status: "todo" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "todo" }),
  ],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const adminMe = () => withAssistant(makePanelMe("admin"));

function makeFullClient(extra: Partial<Record<keyof ApiClient, unknown>> = {}, list = projects): ApiClient {
  const client = makeClient({ projects: list, tickets, people: [makePerson("person-1", "Ana")] });
  const created = makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9", parentId: "t1" });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf([...(tickets.p1 ?? []), created].find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c1", projectId))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] } }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: detailOf(created), children: [], warnings: [] })),
    ...extra,
  });
  return client;
}

function Host({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const typed = async (text: string) => userEvent.type(await screen.findByRole("combobox", { name: "Peça qualquer coisa" }), text);

// A oferta de criar ticket na barra de pedidos (ADR 0036, ADR 0056): "Criar ticket «texto»" aparece quando a pessoa pode criar em algum projeto.
describe("the create-ticket offer in the bar (it replaces the floating Novo ticket button)", () => {
  it("is offered when the assistant is on and the person can create in a project", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await typed("exportar csv");
    expect(await screen.findByRole("option", { name: /Criar ticket «exportar csv»/ })).toBeInTheDocument();
  });

  it("is offered to a contributor of one project", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "contributor" }]))} />);
    await typed("exportar csv");
    expect(await screen.findByRole("option", { name: /Criar ticket «exportar csv»/ })).toBeInTheDocument();
  });

  it("is absent when the person cannot create tickets in any non-archived project", async () => {
    const readerOnly = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }]));
    const archived = makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-01-01T00:00:00.000Z" });
    render(<Host client={makeFullClient({}, [projects[0]!, archived])} me={readerOnly} />);
    await typed("exportar csv");
    expect(screen.queryByRole("option", { name: /Criar ticket/ })).not.toBeInTheDocument();
  });

  it("the old 'Nova conversa' option is gone, and no floating button is left on the map", async () => {
    render(<Host client={makeFullClient()} me={adminMe()} />);
    await userEvent.click(await screen.findByRole("combobox", { name: "Peça qualquer coisa" }));
    expect(screen.queryByRole("option", { name: /Nova conversa|Continuar conversa/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar primeiro projeto" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".map-new-ticket")).toHaveLength(0);
  });
});

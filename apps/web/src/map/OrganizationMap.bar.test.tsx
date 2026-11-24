import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

/** O que a barra de pedidos faz com o pedido de criar ticket (ADR 0036, ADR 0056): com o assistente vira uma thread no Meu chat; sem ele, a criação manual. */
// Prazo dos testes que montam o mapa inteiro: 2-4 s com a máquina em uso normal, e mais de 8 s com ela saturada (TREEPM-101).
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
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const manager = () => withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));

function makeFullClient(extra: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const client = makeClient({ projects, tickets, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(tickets.p1!.find((entry) => entry.id === id)!))),
    ...extra,
  });
  return client;
}

function Host({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const bar = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" });
/** Digita na barra e aperta Ctrl+Enter: "Criar ticket «texto»". */
async function createFromBar(text: string) {
  const field = await bar();
  await userEvent.click(field);
  await userEvent.type(field, text);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
}

describe("the request for a ticket in the bar", () => {
  it("without the assistant, 'Criar ticket' still opens manual creation and the bar offers no conversation", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]), false)} />);
    await createFromBar("exportar csv");
    expect(await screen.findByDisplayValue("exportar csv")).toBeInTheDocument();
    await userEvent.click(await bar());
    expect(screen.queryByRole("option", { name: /Nova conversa/ })).not.toBeInTheDocument();
  }, SLOW);

  it("offers nothing to create to a person who cannot create anywhere", async () => {
    const reader = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }]));
    render(<Host client={makeFullClient()} me={reader} />);
    await userEvent.click(await bar());
    // Nenhuma ação de criar: só "Abrir o Meu chat" (ADR 0056) e a navegação "Próximo ticket para trabalhar" (ADR 0047), que quem só lê também usa.
    expect(screen.queryByRole("option", { name: /conversa/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Abrir o Meu chat", "Próximo ticket para trabalhar"]);
  }, SLOW);

  it("does not highlight anything by default, so Enter on an empty field does not start a request by accident", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await bar());
    expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-selected") !== "true")).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("textbox", { name: "Título" })).not.toBeInTheDocument();
  }, SLOW);
});

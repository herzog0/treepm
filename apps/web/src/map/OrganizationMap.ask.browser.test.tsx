import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// ADR 0037, fatia 5, em navegador real: a resposta com menções passa pelo editor de leitura de verdade.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Login com Google", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Publicar o aplicativo", { key: "ALFA-3", status: "todo" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const me = (): Me => ({ ...makePanelMe("member", [{ projectId: "p1", role: "reader" }]), assistant: { enabled: true } });

function makeAskClient(answer: string): ApiClient {
  const client = makeClient({ projects: [project], tickets: { p1: tickets }, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(tickets.find((entry) => entry.id === id)!))),
    askProject: vi.fn(async () => ok({ text: answer, model: "claude-opus-5-5" })),
  });
  return client;
}

describe("a pergunta no navegador", () => {
  it("clicar numa menção da resposta abre o ticket e recolhe a folha, que segue em andamento", async () => {
    await page.viewport(1280, 800);
    const onChange = vi.fn();
    const screen = await render(<main className="tenant-map" style={{ position: "fixed", inset: 0 }}><OrganizationMap client={makeAskClient("Faltam dois itens: ALFA-2 e ALFA-3.")} me={me()} openTicketId={null} onOpenTicketChange={onChange} /></main>);
    const field = screen.getByRole("combobox", { name: "Peça qualquer coisa" });
    await field.click();
    await userEvent.keyboard("o que falta?");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    const mention = screen.getByRole("link", { name: /ALFA-3/ });
    await expect.element(mention).toBeVisible();
    // Uma peça só, mesmo dentro da folha estreita.
    expect(mention.element().getClientRects()).toHaveLength(1);
    await mention.click();
    expect(onChange).toHaveBeenCalledWith("t3");
    await expect.element(screen.getByRole("region", { name: "Pergunta sobre o projeto" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Pergunta em andamento" })).toBeVisible();
  });
});

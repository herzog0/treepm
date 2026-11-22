import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ActivityEntry, ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0040, fatia 1, em navegador real: "Mostrar anteriores" põe as entradas acima sem tirar da tela o que a pessoa lê.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" })];
const detail: TicketDetail = {
  ...summaries[0]!, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
};
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const title = (n: number): ActivityEntry => ({ id: `e${n}`, type: "title_changed", occurredAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), actor: ana, from: `v${n - 1}`, to: `v${n}` });
/** Do mais novo para o mais antigo, como a API entrega: a página 1 tem 41..60; a 2, 21..40; a 3, 1..20. */
const slice = (high: number, low: number): ActivityEntry[] => Array.from({ length: high - low + 1 }, (_, i) => title(high - i));

describe("Mostrar anteriores no navegador", () => {
  it("mantém na tela o texto que estava sendo lido", async () => {
    const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
    Object.assign(client, {
      getTicket: vi.fn(async () => ok(detail)),
      ticketActivity: vi.fn(async (_id: string, query: { before?: string } = {}) =>
        ok(query.before === undefined ? { entries: slice(60, 41), before: "c1", canComment: false } : { entries: slice(40, 21), before: null, canComment: false })),
    });
    const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
    const screen = await render(
      <div style={{ position: "relative", width: 700, height: 500 }}>
        <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />
      </div>,
    );
    await expect.element(screen.getByRole("button", { name: "Mostrar anteriores" })).toBeVisible();
    const reading = [...document.querySelectorAll<HTMLElement>(".ticket-activity-item")].find((row) => row.textContent?.includes("«v45»"))!;
    reading.scrollIntoView({ block: "start" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // O clique do teste rola até o botão, que está acima do que se lê; a posição que vale é a de quando o clique chega à página.
    let topBefore = Number.NaN;
    const button = document.querySelector<HTMLElement>(".ticket-activity-older button")!;
    button.addEventListener("click", () => { topBefore = reading.getBoundingClientRect().top; }, { capture: true });
    await screen.getByRole("button", { name: "Mostrar anteriores" }).click();
    await expect.element(screen.getByText(/«v20» para «v21»/)).toBeInTheDocument();
    expect(document.querySelectorAll(".ticket-activity-item")).toHaveLength(40);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Number.isNaN(topBefore)).toBe(false);
    expect(reading.getBoundingClientRect().top).toBeCloseTo(topBefore, 0);
  });
});

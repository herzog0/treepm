import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ActivityEntry, ApiClient } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makePerson, makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { ClockContext } from "./clock.js";
import { TicketPage } from "./TicketPage.js";

// Capturas da conferência visual do prazo (ADR 0064, fatia 1; TREEPM-467): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-P3/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-P3/${name}.png`, save: true });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await page.viewport(1440, 900);
});
afterEach(async () => {
  await page.viewport(1440, 900);
});

const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const today = () => new Date(2026, 10, 26, 15, 0);
const timeline: ActivityEntry[] = [
  { id: "a4", occurredAt: "2026-11-25T14:00:00.000Z", actor: ana, type: "due_date_changed", from: "2026-12-12", to: null },
  { id: "a3", occurredAt: "2026-11-24T11:00:00.000Z", actor: ana, type: "due_date_changed", from: "2026-12-01", to: "2026-12-12" },
  { id: "a2", occurredAt: "2026-11-23T10:00:00.000Z", actor: ana, type: "due_date_changed", from: null, to: "2026-12-01" },
  { id: "a1", occurredAt: "2026-11-20T09:00:00.000Z", actor: ana, type: "created" },
];

async function mount(dueDate: string | null, options: { status?: "todo" | "in_progress"; timeline?: boolean } = {}) {
  const project = makeProject("p1", "ENG", "Engenharia");
  const ticket = makeTicket("t1", "p1", 123, "Revisar a paleta do mapa", { key: "ENG-123", dueDate, status: options.status ?? "in_progress", priority: 2, assigneeIds: ["person-1"] });
  const client = makeTreeClient({ projects: [project], tickets: { p1: [ticket] }, people: [makePerson("person-1", "Ana")] });
  if (options.timeline) Object.assign(client, { ticketActivity: async () => ok({ entries: timeline, before: null, canComment: true }) });
  const noop = () => undefined;
  const screen = await render(
    <ClockContext.Provider value={today}>
      <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />
    </ClockContext.Provider>,
  );
  await expect.element(screen.getByText("Prazo", { exact: true })).toBeVisible();
  await settle(600);
  return screen;
}

describe.skipIf(!DIR)("capturas do prazo na página do ticket (ADR 0064, fatia 1)", () => {
  it("1 · prazo em dia", async () => {
    await mount("2026-12-12");
    await shot("1-prazo-em-dia");
  });

  it("2 · prazo atrasado", async () => {
    await mount("2026-11-20");
    await shot("2-prazo-atrasado");
  });

  it("3 · sem prazo", async () => {
    await mount(null, { status: "todo" });
    await shot("3-sem-prazo");
  });

  it("3b · prazo atrasado numa janela estreita (alvos de toque)", async () => {
    await page.viewport(414, 900);
    await mount("2026-11-20");
    await shot("3b-prazo-atrasado-estreito");
  });

  it("5 · o campo em edição: os segmentos do seletor de data no lugar do texto", async () => {
    await mount("2026-12-12");
    document.querySelector<HTMLInputElement>(".ticket-due-input")!.focus();
    await settle(200);
    await shot("5-prazo-em-edicao");
  });

  it("5b · o campo em edição sem prazo", async () => {
    await mount(null, { status: "todo" });
    document.querySelector<HTMLInputElement>(".ticket-due-input")!.focus();
    await settle(200);
    await shot("5b-sem-prazo-em-edicao");
  });

  it("5c · o campo em edição numa janela estreita", async () => {
    await page.viewport(414, 900);
    await mount("2026-11-20");
    document.querySelector<HTMLInputElement>(".ticket-due-input")!.focus();
    await settle(200);
    await shot("5c-em-edicao-estreito");
  });

  it("4 · a linha do tempo com os três eventos do prazo", async () => {
    await page.viewport(1440, 1100);
    const screen = await mount(null, { timeline: true });
    await expect.element(screen.getByText(/tirou o prazo/)).toBeVisible();
    document.querySelector(".ticket-activity")?.scrollIntoView({ block: "start" });
    await settle(200);
    await shot("4-linha-do-tempo");
  });
});

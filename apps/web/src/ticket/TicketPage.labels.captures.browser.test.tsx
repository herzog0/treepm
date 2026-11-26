import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ActivityEntry, ApiClient, Label } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makePerson, makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { ClockContext } from "./clock.js";
import { TicketPage } from "./TicketPage.js";

// Capturas da conferência visual das etiquetas (ADR 0065): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-E1/.
// Tema claro: só os tokens `--tp-label-*` mudam com `data-theme="light"`; o resto do app segue escuro (o app não usa tema claro).
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-E1/${name}.png`, save: true });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await page.viewport(1440, 900);
});
afterEach(async () => {
  await page.viewport(1440, 900);
  delete document.documentElement.dataset["theme"];
});

const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const today = () => new Date(2026, 10, 26, 15, 0);

const palette: Label[] = [
  { id: "l1", name: "Bug", color: "rose" },
  { id: "l2", name: "Front-end", color: "cyan" },
  { id: "l3", name: "Desempenho", color: "orange" },
  { id: "l4", name: "Acessibilidade", color: "violet" },
  { id: "l5", name: "Backend", color: "indigo" },
  { id: "l6", name: "Dívida técnica", color: "brown" },
  { id: "l7", name: "Design", color: "olive" },
  { id: "l8", name: "Documentação", color: "gray" },
  { id: "l9", name: "Mobile", color: "cyan" },
  { id: "l10", name: "Segurança", color: "rose" },
  { id: "l11", name: "Integração com o Linear e a importação de históricos antigos", color: "indigo" },
  { id: "l12", name: "Urgente", color: "orange" },
];
const three = [palette[0]!, palette[1]!, palette[10]!];

const timeline: ActivityEntry[] = [
  { id: "a5", occurredAt: "2026-11-25T16:00:00.000Z", actor: null, automatic: true, type: "labels_changed", added: [{ id: "l12", name: "Urgente" }], removed: [] },
  { id: "a4", occurredAt: "2026-11-25T14:00:00.000Z", actor: ana, type: "labels_changed", added: [{ id: "l3", name: "Desempenho" }], removed: [{ id: "l2", name: "Front-end" }] },
  { id: "a3", occurredAt: "2026-11-24T11:00:00.000Z", actor: ana, type: "labels_changed", added: [], removed: [{ id: "l9", name: "Mobile" }, { id: "l10", name: "Segurança" }] },
  { id: "a2", occurredAt: "2026-11-23T10:00:00.000Z", actor: ana, type: "labels_changed", added: [{ id: "l1", name: "Bug" }, { id: "l2", name: "Front-end" }, { id: "l9", name: "Mobile" }], removed: [] },
  { id: "a1", occurredAt: "2026-11-20T09:00:00.000Z", actor: ana, type: "created" },
];

async function mount(labels: Label[], options: { timeline?: boolean } = {}) {
  const project = makeProject("p1", "ENG", "Engenharia");
  const ticket = makeTicket("t1", "p1", 123, "Revisar a paleta do mapa", { key: "ENG-123", status: "in_progress", priority: 2, assigneeIds: ["person-1"], dueDate: "2026-12-12", labels });
  const client = makeTreeClient({ projects: [project], tickets: { p1: [ticket] }, people: [makePerson("person-1", "Ana")], labels: { p1: palette } });
  if (options.timeline) Object.assign(client, { ticketActivity: async () => ok({ entries: timeline, before: null, canComment: true }) });
  const noop = () => undefined;
  const screen = await render(
    <ClockContext.Provider value={today}>
      <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />
    </ClockContext.Provider>,
  );
  await expect.element(screen.getByText("Etiquetas", { exact: true })).toBeVisible();
  await settle(600);
  return screen;
}

const widths = [
  [1440, "1440"],
  [414, "414"],
] as const;

describe.skipIf(!DIR)("capturas das etiquetas na página do ticket (ADR 0065)", () => {
  for (const [width, tag] of widths) {
    it(`ticket sem etiquetas · ${tag}`, async () => {
      await page.viewport(width, 900);
      await mount([]);
      await shot(`ticket-0-etiquetas-${tag}-escuro`);
    });

    it(`ticket com 3 etiquetas (uma com nome longo) · ${tag}`, async () => {
      await page.viewport(width, 900);
      await mount(three);
      await shot(`ticket-3-etiquetas-${tag}-escuro`);
    });

    it(`ticket com 12 etiquetas · ${tag}`, async () => {
      await page.viewport(width, 900);
      await mount(palette);
      await shot(`ticket-12-etiquetas-${tag}-escuro`);
    });

    it(`seletor aberto com «Criar» · ${tag}`, async () => {
      await page.viewport(width, 900);
      const screen = await mount(three);
      await screen.getByRole("button", { name: "Adicionar etiqueta" }).click();
      await userEvent.type(screen.getByRole("combobox", { name: "Buscar ou criar etiqueta" }), "de");
      await expect.element(screen.getByText("Criar «de»")).toBeVisible();
      await settle(200);
      await shot(`ticket-seletor-criar-${tag}-escuro`);
    });

    it(`linha do tempo com entradas de etiqueta · ${tag}`, async () => {
      await page.viewport(width, 1100);
      const screen = await mount(three, { timeline: true });
      await expect.element(screen.getByText(/adicionada automaticamente/)).toBeVisible();
      document.querySelector(".ticket-activity")?.scrollIntoView({ block: "start" });
      await settle(200);
      await shot(`ticket-linha-do-tempo-${tag}-escuro`);
    });
  }

  it("ticket com 3 etiquetas no tema claro (só os tokens de etiqueta mudam) · 1440", async () => {
    document.documentElement.dataset["theme"] = "light";
    await mount(three);
    await shot("ticket-3-etiquetas-1440-claro");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ActivityEntry, ApiClient, TicketDetail } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makePerson, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "../ticket/TicketPage.js";
import { mountImport, settle } from "./importMount.js";

// Capturas da conferência visual do histórico do Linear (ADR 0061, fatia 4; TREEPM-482): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-H1/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-H1/${name}.png`, save: true });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno", avatarUrl: null };
const day = (n: number, hour = 10) => `2026-11-${String(n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const column = (name: string, type: string) => ({ name, type });
const ref = (id: string, key: string, title: string) => ({ id, key, title });

/** Da mais nova para a mais antiga, como a API manda. */
const timeline: ActivityEntry[] = ([
  { id: "a9", occurredAt: day(25, 9), actor: null, automatic: true, type: "history_imported", count: 7 },
  { id: "a6", occurredAt: day(20, 11), actor: null, externalActor: { name: "GitHub" }, type: "linear_history", changes: [{ field: "status", from: column("In Progress", "started"), to: column("Aguardando revisão do time de design e aprovação final do cliente", "started") }] },
  { id: "a8", occurredAt: day(19, 16), actor: ana, type: "comment", body: "Conferi o contraste no modo escuro; o verde novo passa.", area: null, editedAt: null, removed: false, canEdit: true, canRemove: true },
  { id: "a5", occurredAt: day(18, 14), actor: bruno, type: "linear_history", changes: [
    { field: "status", from: column("Todo", "unstarted"), to: column("In Progress", "started") },
    { field: "assignee", from: { kind: "linear", name: "Carla" }, to: { kind: "person", person: bruno } },
    { field: "priority", from: 300, to: 100 },
    { field: "parent", from: null, to: ref("t2", "ENG-98", "Definir os tokens de cor do mapa e da legenda em todos os modos") },
  ] },
  { id: "a7", occurredAt: day(17, 15), actor: ana, type: "priority_changed", from: 100, to: 300 },
  { id: "a4", occurredAt: day(16, 10), actor: null, externalActor: { name: "Carla" }, type: "linear_history", changes: [{ field: "title", from: "Paleta", to: "Revisar a paleta do mapa" }, { field: "project", from: { id: null, key: null, title: null }, to: null }] },
  { id: "a3", occurredAt: day(14, 18), actor: null, externalActor: { name: null }, type: "linear_history", changes: [{ field: "description" }] },
  { id: "a1", occurredAt: day(12, 9), actor: ana, type: "created" },
  { id: "a2", occurredAt: day(3, 17), actor: null, externalActor: { name: "Carla" }, type: "linear_created" },
] as unknown[]) as ActivityEntry[];

async function mountTicket() {
  const project = makeProject("p1", "ENG", "Engenharia");
  const summary = makeTicket("t1", "p1", 123, "Revisar a paleta do mapa", { key: "ENG-123" });
  const parent = makeTicket("t2", "p1", 98, "Definir os tokens de cor do mapa e da legenda em todos os modos", { key: "ENG-98" });
  const detail: TicketDetail = {
    ...summary, description: "Trocar o verde do concluído e conferir o contraste.", mentionedBy: [], dependsOn: [], blocks: [], related: [],
    createdByPersonId: "person-1", createdAt: day(25, 9), updatedAt: day(25, 9),
    externalSource: { provider: "linear", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/revisar-a-paleta" },
  };
  const client = makeClient({ projects: [project], tickets: { p1: [summary, parent] }, people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")] });
  Object.assign(client, { getTicket: async () => ok(detail), ticketActivity: async () => ok({ entries: timeline, before: null, canComment: true }) });
  const noop = () => undefined;
  const screen = await render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />);
  await expect.element(screen.getByText("criou a issue no Linear")).toBeVisible();
  await settle(600);
  const activity = document.querySelector(".ticket-activity");
  activity?.scrollIntoView({ block: "start" });
  await settle(200);
}

describe.skipIf(!DIR)("capturas do histórico do Linear (ADR 0061, fatia 4)", () => {
  it("1 · a linha do tempo do ticket com o histórico do Linear intercalado", async () => {
    await page.viewport(1440, 1100);
    await mountTicket();
    await shot("1-ticket-historico-linear");
  });

  it("2 · a mesma linha do tempo numa janela estreita (nomes longos quebram a linha)", async () => {
    await page.viewport(720, 1100);
    await mountTicket();
    await shot("2-ticket-historico-linear-estreito");
  });

  it("3 · o resumo da rodada com o histórico trazido e as issues cortadas no limite", async () => {
    await mountImport({
      hash: "#linear-sync",
      linear: {
        connection: makeLinearConnection(),
        projects: { p1: { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true } },
        run: {
          total: 4,
          projects: 0,
          existing: { phase: "done", done: true, mode: "reimport", finishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), destinationTicketId: null, counts: { updated: 3, commentsCreated: 129, relationsCreated: 37, historyCreated: 1_284, historyIgnored: 52, historySkipped: 3, historyTruncated: 2 } },
          reimportCounts: { updated: 3, commentsCreated: 129, relationsCreated: 37, historyCreated: 1_284, historyIgnored: 52, historySkipped: 3, historyTruncated: 2 },
        } as never,
      },
    });
    await settle(900);
    await shot("3-resumo-historico");
  });
});

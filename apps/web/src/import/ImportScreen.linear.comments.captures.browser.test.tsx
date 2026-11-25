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

// Capturas da conferência visual dos comentários do Linear (ADR 0061, fatia 2; TREEPM-477): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-C1/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-C1/${name}.png`, save: true });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.skipIf(!DIR)("capturas dos comentários do Linear (ADR 0061, fatia 2)", () => {
  it("1 · a página do ticket com comentário de pessoa casada, de autor do Linear e de robô", async () => {
    await page.viewport(1440, 900);
    const project = makeProject("p1", "ENG", "Engenharia");
    const summary = makeTicket("t1", "p1", 123, "Revisar a paleta do mapa", { key: "ENG-123" });
    const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
    const base = { body: "", editedAt: null, removed: false, canEdit: false, canRemove: true, area: null, via: "linear" as const };
    const entries: ActivityEntry[] = [
      { id: "e1", type: "comments_imported", occurredAt: "2026-11-25T10:00:00.000Z", actor: ana, automatic: true, count: 3 } as ActivityEntry,
      { id: "c3", type: "comment", occurredAt: "2026-03-05T14:00:00.000Z", actor: null, externalAuthor: { name: "GitHub" }, ...base, body: "Pull request #42 aberto: **paleta nova**." } as ActivityEntry,
      { id: "c2", type: "comment", occurredAt: "2026-03-04T11:30:00.000Z", actor: null, externalAuthor: { name: "Zed Externo" }, ...base, body: "> Proposta: trocar o verde do concluído\n\nConcordo, mas testem o contraste.", editedAt: "2026-03-04T12:00:00.000Z" } as ActivityEntry,
      { id: "c1", type: "comment", occurredAt: "2026-03-03T09:00:00.000Z", actor: ana, ...base, body: "Proposta: trocar o verde do concluído." } as ActivityEntry,
    ];
    const detail = { ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z" } as TicketDetail;
    const client = makeClient({ projects: [project], tickets: { p1: [summary] }, people: [makePerson("person-1", "Ana")] });
    Object.assign(client, { getTicket: async () => ok(detail), ticketActivity: async () => ok({ entries, before: null, canComment: true }) });
    const noop = () => undefined;
    const screen = await render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />);
    await expect.element(screen.getByText("Zed Externo (no Linear)")).toBeVisible();
    await settle(600);
    await shot("1-ticket-comentarios-linear");
  });

  it("2 · o resumo da rodada com os comentários trazidos e os mantidos", async () => {
    await mountImport({
      hash: "#linear-sync",
      linear: {
        connection: makeLinearConnection(),
        projects: { p1: { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true } },
        run: {
          total: 4,
          projects: 0,
          existing: { phase: "done", done: true, mode: "reimport", finishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), destinationTicketId: null, counts: { updated: 3 } },
          reimportCounts: { updated: 3, commentsCreated: 129, commentsKeptEdited: 2 },
        } as never,
      },
    });
    await settle(900);
    await shot("2-resumo-comentarios");
  });
});

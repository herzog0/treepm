import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ApiClient, TicketDetail } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makePerson, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "../ticket/TicketPage.js";
import { mountImport, settle } from "./importMount.js";

// Capturas da conferência visual das relações do Linear (ADR 0061, fatia 3; TREEPM-478): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-R1/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-R1/${name}.png`, save: true });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.skipIf(!DIR)("capturas das relações do Linear (ADR 0061, fatia 3)", () => {
  it("1 · a página do ticket com “Depende de”, “Relacionado a” e “Bloqueia” vindos do Linear", async () => {
    await page.viewport(1440, 900);
    const project = makeProject("p1", "ENG", "Engenharia");
    const summary = makeTicket("t1", "p1", 123, "Revisar a paleta do mapa", { key: "ENG-123" });
    const others = [
      makeTicket("t2", "p1", 98, "Definir os tokens de cor", { key: "ENG-98", status: "done" }),
      makeTicket("t3", "p1", 101, "Contraste do modo escuro", { key: "ENG-101", status: "in_progress" }),
      makeTicket("t4", "p1", 130, "Legenda do mapa", { key: "ENG-130" }),
      makeTicket("t5", "p1", 141, "Ícones das situações", { key: "ENG-141" }),
      makeTicket("t6", "p1", 150, "Publicar o guia visual", { key: "ENG-150" }),
    ];
    const link = (entry: (typeof others)[number], fromLinear: boolean) => ({ id: entry.id, key: entry.key, title: entry.title, status: entry.status, fromLinear });
    const detail: TicketDetail = {
      ...summary, description: "Trocar o verde do concluído e conferir o contraste.", mentionedBy: [],
      dependsOn: [link(others[0]!, true), link(others[1]!, false)],
      blocks: [link(others[4]!, true)],
      related: [link(others[2]!, true), link(others[3]!, true)],
      createdByPersonId: "person-1", createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z",
      externalSource: { provider: "linear", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/revisar-a-paleta" },
    };
    const client = makeClient({ projects: [project], tickets: { p1: [summary, ...others] }, people: [makePerson("person-1", "Ana")] });
    const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
    Object.assign(client, {
      getTicket: async () => ok(detail),
      ticketActivity: async () => ok({ entries: [{ id: "e1", type: "relations_imported", occurredAt: "2026-11-25T10:00:00.000Z", actor: ana, automatic: true, count: 4 }], before: null, canComment: true }),
    });
    const noop = () => undefined;
    const screen = await render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />);
    await expect.element(screen.getByText("Relacionado a")).toBeVisible();
    await settle(600);
    await shot("1-ticket-relacoes-linear");
  });

  it("2 · o resumo da rodada com as relações trazidas e as que fechariam um ciclo", async () => {
    await mountImport({
      hash: "#linear-sync",
      linear: {
        connection: makeLinearConnection(),
        projects: { p1: { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true } },
        run: {
          total: 4,
          projects: 0,
          existing: { phase: "done", done: true, mode: "reimport", finishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), destinationTicketId: null, counts: { updated: 3, commentsCreated: 129, relationsCreated: 37, relationsAdopted: 4, relationsCycle: 1 } },
          reimportCounts: { updated: 3, commentsCreated: 129, relationsCreated: 37, relationsAdopted: 4, relationsCycle: 1 },
        } as never,
      },
    });
    await settle(900);
    await shot("2-resumo-relacoes");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe } from "../panel/testing.js";
import { mountLinear } from "../settings/linearMount.js";
import { makeClient, makeLinearConnection, makeLinearTeam, makePerson, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "../ticket/TicketPage.js";
import { mountImport, settle } from "./importMount.js";

// Capturas da conferência visual de "Sincronizar com o Linear" (ADR 0061, TREEPM-501): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-S2/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-S2/${name}.png`, save: true });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.skipIf(!DIR)("capturas de Sincronizar com o Linear (ADR 0061)", () => {
  it("1 · o botão no cartão do Linear das Configurações", async () => {
    const ago = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await mountLinear({
      openImport: true,
      linear: {
        connection: makeLinearConnection(),
        teams: [makeLinearTeam("ENG", "Engenharia", { linkedProject: { id: "p1", name: "TreePM" }, lastImportedAt: ago }), makeLinearTeam("DES", "Design")],
        run: { existing: { projectId: "p1", phase: "done", done: true, finishedAt: ago, startedBy: { id: "person-1" } } },
      },
    });
    await settle(500);
    await shot("1-botao-configuracoes");
  });

  it("2 · o resumo da sincronização com os campos preenchidos e o aviso", async () => {
    await mountImport({
      hash: "#linear-sync",
      linear: {
        connection: makeLinearConnection(),
        projects: { p1: { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true } },
        run: {
          total: 4,
          projects: 0,
          existing: { phase: "done", done: true, mode: "reimport", finishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), destinationTicketId: null, counts: { updated: 23, filled: 41 } },
          reimportCounts: { updated: 23, filled: 41, descriptionUnavailable: true },
        } as never,
      },
    });
    await settle(900);
    await shot("2-resumo-sincronizacao");
  });

  it("3 · a página do ticket com a origem no Linear", async () => {
    await page.viewport(1440, 900);
    const project = makeProject("p1", "ENG", "Engenharia");
    const summary = makeTicket("t1", "p1", 123, "Revisar a paleta do mapa", { key: "ENG-123" });
    const client = makeClient({ projects: [project], tickets: { p1: [summary] }, people: [makePerson("person-1", "Ana"), makePerson("person-2", "Beto")] });
    Object.assign(client, {
      getTicket: async () => ok({
        ...summary, description: "Importado do Linear.", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z",
        externalSource: { provider: "linear", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/x", missingSince: null, createdAt: "2026-03-03T12:00:00.000Z", startedAt: "2026-03-05T12:00:00.000Z", completedAt: "2026-03-09T12:00:00.000Z", canceledAt: null, creator: { name: "Carla" } },
      }),
    });
    await render(
      <div style={{ display: "grid", height: "100dvh" }}>
        <TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={() => undefined} onClose={() => undefined} onChanged={() => undefined} onRemoved={() => undefined} onStartCreate={() => undefined} onCancelCreate={() => undefined} onCreated={() => undefined} />
      </div>,
    );
    await document.fonts.ready;
    await settle(600);
    // A linha da origem usa a cor de texto secundária da página (não compete com o título).
    const origin = document.querySelector(".ticket-linear-origin") as HTMLElement;
    const probe = (variable: string): string => {
      const el = document.createElement("span");
      el.style.color = `var(${variable})`;
      origin.parentElement!.appendChild(el);
      const color = getComputedStyle(el).color;
      el.remove();
      return color;
    };
    expect(getComputedStyle(origin).color).toBe(probe("--tp-text-2"));
    expect(getComputedStyle(origin).color).not.toBe(probe("--tp-text"));
    await shot("3-ticket-origem-linear");
  });
});

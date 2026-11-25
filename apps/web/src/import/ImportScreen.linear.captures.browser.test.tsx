import { afterEach, describe, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "../ticket/TicketPage.js";
import { FREE, LINKED, mountImport, settle } from "./importMount.js";

// Capturas da conferência visual da importação do Linear (ADR 0060, fatia 2): só rodam com `VITE_TREEPM_CAPTURES_DIR=1`; os PNGs saem em
// .vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/importar-${name}.png`, save: true });
const button = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find((element) => (element.textContent ?? "").trim() === text && element.getBoundingClientRect().width > 0)!;
const connection = makeLinearConnection();
const running = (script: object[], counts = { projectsSeen: 6, issuesSeen: 255 }) => ({ connection, projects: { p1: LINKED }, run: { total: 412, existing: { phase: "issues" as const, totalExpected: 412, counts }, script } as never });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.skipIf(!DIR)("capturas da importação do Linear (ADR 0060)", () => {
  it("sem vínculo", async () => {
    await mountImport({ linear: { connection, projects: { p1: FREE } } });
    await settle(300);
    await shot("1-sem-vinculo");
  });

  it("pronto para importar, com o destino aberto", async () => {
    await mountImport({});
    await settle(300);
    await shot("2-pronto-para-importar");
    await userEvent.click(button("Trocar"));
    await settle(300);
    await shot("2b-destino-aberto");
  });

  it("em andamento", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    await mountImport({ linear: running([{ hold }]) });
    await settle(400);
    await shot("3-em-andamento");
    release();
  });

  it("aguardando o limite do Linear", async () => {
    await mountImport({ linear: running([{ waitSeconds: 3600 }]) });
    await settle(400);
    await shot("4-aguardando-limite");
  });

  it("erro de chave", async () => {
    await mountImport({ linear: running([{ error: ["unavailable", "linear_key_invalid"] }]) });
    await settle(400);
    await shot("5-erro-de-chave");
  });

  it("concluído", async () => {
    await mountImport({ hash: "", linear: { connection, projects: { p1: LINKED }, run: { existing: { phase: "done", done: true, counts: { projectsCreated: 6, issuesCreated: 406, issuesExisting: 3, flattened: 2 }, finishedAt: "2026-11-24T13:00:00.000Z" } } } });
    await userEvent.click(button("Do Linear"));
    await settle(300);
    await shot("6-concluido");
  });

  it("ticket com 'Ver no Linear'", async () => {
    await page.viewport(1440, 900);
    const project = makeProject("p1", "DES", "Design");
    const summary = makeTicket("t1", "p1", 88, "Revisar a paleta do mapa", { key: "DES-88" });
    const client = makeClient({ projects: [project], tickets: { p1: [summary] } });
    Object.assign(client, {
      getTicket: async () => ok({ ...summary, description: "Importado do Linear.", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", externalSource: { provider: "linear", key: "DES-88", url: "https://linear.app/acme/issue/DES-88/revisar-a-paleta" } }),
    });
    await render(
      <div style={{ display: "grid", height: "100dvh" }}>
        <TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={() => undefined} onClose={() => undefined} onChanged={() => undefined} onRemoved={() => undefined} onStartCreate={() => undefined} onCancelCreate={() => undefined} onCreated={() => undefined} />
      </div>,
    );
    await document.fonts.ready;
    await settle(500);
    await shot("7-ticket-ver-no-linear");
  });

  it("celular (390 px): pronto, em andamento e concluído", async () => {
    await mountImport({ width: 390, height: 844 });
    await settle(300);
    await shot("8-celular-pronto");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const view = await mountImport({ width: 390, height: 844, linear: running([{ hold }]) });
    await settle(400);
    await shot("9-celular-em-andamento");
    release();
    view.screen.unmount();
    await mountImport({ width: 390, height: 844, hash: "", linear: { connection, projects: { p1: LINKED }, run: { existing: { phase: "done", done: true, counts: { projectsCreated: 6, issuesCreated: 406, issuesExisting: 3, flattened: 2 } } } } });
    await userEvent.click(button("Do Linear"));
    await settle(300);
    await shot("10-celular-concluido");
  });

  it("abandonar: a confirmação e a importação abandonada", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const view = await mountImport({ linear: running([{ hold }], { projectsSeen: 6, issuesSeen: 255 }) });
    await settle(400);
    await userEvent.click(button("Abandonar importação"));
    await settle(300);
    await shot("11-abandonar-confirmacao");
    await userEvent.click(button("Abandonar"));
    await settle(400);
    await shot("12-abandonada");
    release();
    view.screen.unmount();
  });
});

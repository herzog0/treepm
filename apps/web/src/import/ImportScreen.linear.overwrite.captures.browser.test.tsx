import { afterEach, describe, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makeLinearConnection } from "../test/fakes.js";
import { mountImport, settle } from "./importMount.js";

// Capturas da conferência visual de "Sobrescrever com o Linear" (ADR 0066): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-LV1/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-LV1/${name}.png`, save: true });
const LINKED = { p1: { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true } };
const ago = () => new Date(Date.now() - 2 * 86_400_000).toISOString();

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.skipIf(!DIR)("capturas de Sobrescrever com o Linear (ADR 0066)", () => {
  for (const [name, width, height] of [["desktop", 1440, 900], ["celular", 390, 844]] as const) {
    it(`1 · a caixa e a confirmação (${name})`, async () => {
      await page.viewport(width, height);
      await mountImport({ width, height, hash: "#linear", linear: { connection: makeLinearConnection(), projects: LINKED, run: { total: 4, projects: 0, existing: { phase: "done", done: true, mode: "reimport", finishedAt: ago(), destinationTicketId: null, counts: { updated: 3 } } } as never } });
      await settle(600);
      await shot(`1-caixa-${name}`);
      await userEvent.click(page.getByRole("checkbox", { name: "Sobrescrever com o Linear o que foi mudado aqui" }));
      await userEvent.click(page.getByRole("button", { name: "Sincronizar agora" }));
      await settle(300);
      await shot(`2-dialogo-${name}`);
    });
  }

  it("3 · o resumo com os tickets sobrescritos", async () => {
    await mountImport({
      hash: "#linear",
      linear: { connection: makeLinearConnection(), projects: LINKED, run: { total: 4, projects: 0, existing: { phase: "done", done: true, mode: "reimport", overwrite: true, finishedAt: ago(), destinationTicketId: null, counts: { updated: 12, overwritten: 7, labelsAdded: 2 } } } as never },
    });
    await settle(600);
    await shot("3-resumo");
  });
});

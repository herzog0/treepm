import { afterAll, describe, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderScreen } from "./layoutScreens.js";
import { settle } from "./layoutMeasure.js";

// Capturas da conferência visual do layout (TREEPM-231): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em src/.vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true });

describe.skipIf(!ON)("capturas do layout", () => {
  afterAll(async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  });
  for (const [tag, width, height] of [["390", 390, 844], ["1440", 1440, 900]] as const) {
    it(`telas em ${tag}`, async () => {
      // O desktop é visto com mouse (sem emulação de toque), o celular com toque.
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: width < 721, maxTouchPoints: 5 });
      await page.viewport(width, height);
      await renderScreen("map", { assistant: true });
      await shot(`${tag}-01-mapa`);
      await userEvent.click(document.querySelector<HTMLInputElement>(".command-field input")!);
      await userEvent.keyboard("a");
      await settle();
      await shot(`${tag}-02-folha-de-busca`);
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      await settle(800);
      await shot(`${tag}-03-pergunta`);
      await renderScreen("ticket");
      await shot(`${tag}-04-ticket-topo`);
      document.querySelector<HTMLElement>(".ticket-row button")!.click();
      await settle(300);
      await shot(`${tag}-06-ticket-menu-situacao`);
      await userEvent.keyboard("{Escape}");
      await settle(200);
      const body = document.querySelector<HTMLElement>(".ticket-body")!;
      document.querySelector<HTMLElement>(".ticket-contribution")?.scrollIntoView({ block: "start" });
      await settle(200);
      await shot(`${tag}-05-ticket-areas`);
      body.scrollTop = body.scrollHeight;
      await settle(200);
      await shot(`${tag}-05b-ticket-atividade`);
      await renderScreen("teams");
      await shot(`${tag}-07-times`);
      await renderScreen("settings");
      await shot(`${tag}-08-configuracoes`);
      await renderScreen("import");
      await shot(`${tag}-09-importacao`);
    });
  }
});

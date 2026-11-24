import { afterAll, describe, it } from "vitest";
import { cdp, page } from "vitest/browser";
import { renderScreen } from "./layoutScreens.js";
import { settle } from "./layoutMeasure.js";

// Capturas da conferência visual da casca nova (ADR 0055): só rodam com `VITE_TREEPM_CAPTURES_DIR=1`; os PNGs saem em .vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const openChat = async () => {
  [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].find((row) => (row.textContent ?? "").includes("ALFA-1"))!.click();
  await settle(900);
};

describe.skipIf(!DIR)("capturas da barra lateral fixa", () => {
  afterAll(async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.viewport(1440, 900);
  });

  it("desktop: sem conversa, com conversa, com conversa e página do ticket", async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    for (const width of [1440, 1280]) {
      await page.viewport(width, width === 1440 ? 900 : 800);
      await renderScreen("map", { assistant: true });
      await shot(`${width}-01-sem-conversa`);
      await openChat();
      await shot(`${width}-02-com-conversa`);
      await renderScreen("ticket");
      await openChat();
      await shot(`${width}-03-conversa-e-pagina-do-ticket`);
      await renderScreen("teams");
      await shot(`${width}-04-times`);
    }
  });

  it("celular: faixa do topo, gaveta aberta e conversa", async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.viewport(390, 844);
    await renderScreen("map", { assistant: true });
    await shot("390-01-faixa-do-topo");
    q<HTMLButtonElement>(".tenant-menu-button")!.click();
    await settle(300);
    await shot("390-02-gaveta-aberta");
    await openChat();
    await shot("390-03-conversa");
  });
});

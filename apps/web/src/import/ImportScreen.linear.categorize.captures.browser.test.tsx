import { afterEach, describe, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { settle, mountImport } from "./importMount.js";
import { CHECK_ITEMS, arrangeLinear } from "./categorizeFixtures.js";

// Capturas da conferência visual de "Arrumar na árvore" (ADR 0060, seção 6): só rodam com `VITE_TREEPM_CAPTURES_DIR=1`; os PNGs saem em
// .vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/importar-${name}.png`, save: true });
const button = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find((element) => (element.textContent ?? "").trim() === text && element.getBoundingClientRect().width > 0)!;

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.skipIf(!DIR)("capturas de arrumar na árvore (ADR 0060, seção 6)", () => {
  it("17 · pronto para procurar", async () => {
    await mountImport({ linear: arrangeLinear({ candidates: 37 }) });
    await settle(400);
    await shot("17-arrumar-na-arvore");
  });

  it("18 · procurando", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await mountImport({ linear: arrangeLinear({ candidates: 37, plan: { placed: 20, toCheck: 15, kept: 2 }, pageSize: 12, script: ["ok", { hold: gate }] }) });
    await settle(300);
    await userEvent.click(button("Procurar o lugar de 37 itens"));
    await settle(500);
    await shot("18-procurando");
    release();
  });

  it("19 · resumo da procura", async () => {
    await mountImport({ linear: arrangeLinear({ candidates: 37, plan: { placed: 30, toCheck: 3, kept: 3, failed: 1 }, pageSize: 40, toCheckItems: CHECK_ITEMS }) });
    await settle(300);
    await userEvent.click(button("Procurar o lugar de 37 itens"));
    await settle(600);
    await shot("19-resumo-categorizacao");
  });

  it("20 · a conferir", async () => {
    await mountImport({ linear: arrangeLinear({ candidates: 0, toCheckItems: CHECK_ITEMS, existing: { phase: "done", finished: true, total: 37, done: 37, placed: 34, toCheck: 3 } }) });
    await settle(300);
    await userEvent.click(button("Ver os 3 a conferir"));
    await settle(500);
    await shot("20-a-conferir");
  });

  it("21 · sem aceite", async () => {
    await mountImport({ linear: arrangeLinear({ candidates: 37, reason: "assistant_consent_required" }) });
    await settle(400);
    await shot("21-sem-aceite");
  });
});

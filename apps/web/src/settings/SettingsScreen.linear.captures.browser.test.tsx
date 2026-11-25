import { afterEach, describe, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PROJECTS, TEAMS, mountLinear, settle } from "./linearMount.js";

// Capturas da conferência visual da seção "Linear" (ADR 0060, fatia 1): só rodam com `VITE_TREEPM_CAPTURES_DIR=1`; os PNGs saem em .vitest/cap
// (fora do Git) e quem roda os move para fora do repositório.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/linear-${name}.png`, save: true });
const button = (text: string) => [...document.querySelectorAll<HTMLElement>("button")].find((element) => (element.textContent ?? "").trim() === text)!;

afterEach(() => {
  window.location.hash = "";
});

describe.skipIf(!DIR)("capturas da seção Linear (ADR 0060)", () => {
  it("sem chave", async () => {
    await mountLinear({ linear: {} });
    await settle();
    await shot("1-sem-chave");
  });

  it("conectado, com os três estados de time", async () => {
    await mountLinear({});
    await settle(400);
    await shot("2-conectado-tres-estados");
  });

  it("diálogo vazio e diálogo pronto para confirmar", async () => {
    await mountLinear({});
    await settle(400);
    await userEvent.click(button("Ligar a um projeto…"));
    await settle(400);
    await shot("3-dialogo-vazio");
    await userEvent.selectOptions(document.querySelector<HTMLSelectElement>("[role=dialog] select")!, PROJECTS[0]!.id);
    await userEvent.type(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!, TEAMS[1]!.key);
    await settle();
    await shot("4-dialogo-pronto");
  });

  it("celular (390 px): seção conectada, diálogo vazio e diálogo pronto", async () => {
    await mountLinear({ width: 390, height: 844 });
    await settle(400);
    await shot("5-celular-secao");
    await userEvent.click(button("Ligar a um projeto…"));
    await settle(400);
    await shot("6-celular-dialogo-vazio");
    await userEvent.selectOptions(document.querySelector<HTMLSelectElement>("[role=dialog] select")!, PROJECTS[0]!.id);
    await userEvent.type(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!, TEAMS[1]!.key);
    await settle();
    await shot("7-celular-dialogo-pronto");
  });
});

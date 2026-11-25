import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { contrastOf, expectTextCentered, noHorizontalScroll } from "./browserMeasures.js";
import { CHECK_ITEMS, arrangeLinear } from "./categorizeFixtures.js";
import { mountImport } from "./importMount.js";

// "Arrumar na árvore" (ADR 0060, seção 6) em navegador real, em 1440, 720 e 390 px: sem rolagem horizontal, contraste (4,5:1), texto
// centrado nos botões, alvos de 44 px no celular e a lista "a conferir" com títulos longos sem estourar.
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const byText = <T extends Element = HTMLElement>(selector: string, text: string) =>
  all<T>(selector).find((element) => (element.textContent ?? "").trim() === text && element.getBoundingClientRect().width > 0)!;
const hold = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

function expectReadable(selectors: string[]) {
  for (const selector of selectors) {
    const elements = all(selector).filter((element) => element.getBoundingClientRect().width > 0);
    expect(elements.length, selector).toBeGreaterThan(0);
    for (const element of elements) expect(contrastOf(element), `${selector}: contraste`).toBeGreaterThanOrEqual(4.5);
  }
}
function expectInside(selector: string) {
  for (const element of all(selector)) {
    const box = element.getBoundingClientRect();
    expect(box.right, `${selector} cabe na tela`).toBeLessThanOrEqual(window.innerWidth);
    expect(box.left, selector).toBeGreaterThanOrEqual(0);
  }
}
function expectTargets44(elements: Element[], label: string) {
  for (const element of elements) expect(element.getBoundingClientRect().height, `${label}: alvo`).toBeGreaterThanOrEqual(44);
}

describe.each([[1440, 900], [720, 900], [390, 844]])("arrumar na árvore com %i px de largura", (width, height) => {
  it("pronto para procurar: sem rolagem horizontal, botão centrado, contraste e alvo de 44 px no celular", async () => {
    await mountImport({ width, height, linear: arrangeLinear({ candidates: 37 }) });
    await expect.poll(() => byText("button", "Procurar o lugar de 37 itens")).toBeTruthy();
    noHorizontalScroll();
    const button = byText("button", "Procurar o lugar de 37 itens");
    expectTextCentered(button, "Procurar");
    expectReadable([".linear-categorize h4", ".linear-categorize .linear-import-note", ".linear-categorize .linear-import-how"]);
    expectInside(".linear-categorize");
    if (width <= 720) expectTargets44([button], "Procurar");
  });

  it("procurando: barra, contadores, abandonar (com confirmação) sem estourar", async () => {
    const gate = hold();
    await mountImport({ width, height, linear: arrangeLinear({ candidates: 37, plan: { placed: 20, toCheck: 15, kept: 2 }, pageSize: 12, script: ["ok", { hold: gate.promise }] }) });
    await expect.poll(() => byText("button", "Procurar o lugar de 37 itens")).toBeTruthy();
    await userEvent.click(byText("button", "Procurar o lugar de 37 itens"));
    await expect.poll(() => all(".linear-categorize-running .linear-import-count").some((element) => element.textContent === "12 de 37")).toBe(true);
    noHorizontalScroll();
    expectReadable([".linear-categorize-running h5", ".linear-categorize-running .linear-import-count", ".linear-categorize-running dt", ".linear-categorize-running dd"]);
    expect(all(".linear-categorize-running .linear-import-bar").length).toBe(1);
    const abandon = byText("button", "Abandonar");
    if (width <= 720) expectTargets44([abandon], "Abandonar");
    await userEvent.click(abandon);
    await expect.poll(() => all(".linear-categorize .linear-import-abandon-confirm").length).toBe(1);
    noHorizontalScroll();
    expectInside(".linear-categorize .linear-import-abandon-confirm");
    expectTextCentered(byText("button", "Voltar"), "Voltar");
    gate.release();
  });

  it("resumo e lista a conferir com títulos longos: nada estoura e os alvos têm 44 px no celular", async () => {
    await mountImport({ width, height, linear: arrangeLinear({ candidates: 3, plan: { placed: 3 }, toCheckItems: CHECK_ITEMS, existing: { phase: "done", finished: true, total: 3, done: 3, placed: 3, toCheck: 3 } }) });
    await expect.poll(() => byText("button", "Ver os 3 a conferir")).toBeTruthy();
    noHorizontalScroll();
    await userEvent.click(byText("button", "Ver os 3 a conferir"));
    await expect.poll(() => all(".linear-categorize-row").length).toBe(3);
    noHorizontalScroll();
    expectInside(".linear-categorize-row");
    expectInside(".linear-categorize-ticket");
    for (const row of all(".linear-categorize-row")) expect(row.scrollWidth, "linha sem rolagem interna").toBeLessThanOrEqual(row.clientWidth);
    expectReadable([".linear-categorize-ticket", ".linear-categorize-row .linear-import-how", ".linear-categorize-row button"]);
    expectTextCentered(byText("button", "Esconder a lista"), "Esconder");
    if (width <= 720) {
      expectTargets44(all(".linear-categorize-ticket"), "ticket");
      expectTargets44(all(".linear-categorize-row button"), "marcar");
    }
  });

  it("sem aceite: a frase cabe, tem contraste e o atalho existe", async () => {
    await mountImport({ width, height, linear: arrangeLinear({ candidates: 5, reason: "assistant_consent_required" }) });
    await expect.poll(() => all(".linear-categorize a").length).toBe(1);
    noHorizontalScroll();
    expectReadable([".linear-categorize [role=alert]", ".linear-categorize a"]);
    expectInside(".linear-categorize [role=alert]");
    if (width <= 720) expectTargets44(all(".linear-categorize a"), "atalho");
  });
});

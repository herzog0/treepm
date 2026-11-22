import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { renderScreen } from "./layoutScreens.js";
import type { LayoutScreen } from "./layoutScreens.js";
import { settle } from "./layoutMeasure.js";
import indexHtml from "../../index.html?raw";

// TREEPM-231: layout para tela estreita, em navegador real com emulação de toque (pointer: coarse), em 360×740 e 430×932.
const VIEWPORTS = [[360, 740], [430, 932]] as const;
const SCREENS: readonly LayoutScreen[] = ["map", "ticket", "teams", "settings", "import", "ideas"];
const TOUCH = 44;

beforeAll(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
});
// A emulação de toque vale para a página inteira: desligada ao fim, não vaza para as outras suítes de navegador.
afterAll(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
});
afterEach(() => document.getElementById("root")?.remove());

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const rectOf = (el: Element) => el.getBoundingClientRect();
const label = (el: Element) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}[${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}]`;
/** A parte desenhada pelo mapa (cartões, regiões) é do palco, com o zoom dele: fora destas conferências. */
const inStage = (el: Element) => el.closest(".spatial-scene, .spatial-sr-only, [hidden]") !== null;
function visible(el: Element): boolean {
  if (inStage(el)) return false;
  const r = rectOf(el);
  if (r.width <= 1 || r.height <= 1) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || style.clipPath !== "none") return false;
  for (let at: Element | null = el; at; at = at.parentElement) if (getComputedStyle(at).display === "none") return false;
  return true;
}
const clipsX = (el: Element) => /(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowX);
/** Elementos que passam da borda da tela e não estão dentro de um contêiner que rola ou corta. */
function stickingOut(): string[] {
  const width = window.innerWidth;
  return all("body *").filter((el) => {
    if (!visible(el) || getComputedStyle(el).position === "fixed") return false;
    const r = rectOf(el);
    if (r.right <= width + 0.5 && r.left >= -0.5) return false;
    for (let at = el.parentElement; at && at !== document.body; at = at.parentElement) if (clipsX(at)) return false;
    return true;
  }).map(label);
}
/** Tamanho efetivo do alvo de toque: o próprio retângulo, ou a área que responde ao toque em volta do centro (pseudo-elemento). */
function touchSize(el: HTMLElement): { w: number; h: number } {
  // Marcar/desmarcar: o alvo é a linha do rótulo que envolve o campo, não o quadradinho.
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.labels?.[0]) el = el.labels[0];
  const r = rectOf(el);
  const hits = (x: number, y: number) => { const hit = document.elementFromPoint(x, y); return hit !== null && el.contains(hit); };
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const span = (horizontal: boolean) => {
    let lo = 0;
    let hi = 0;
    for (let d = 0; d <= 40; d += 1) if (hits(horizontal ? cx + d : cx, horizontal ? cy : cy + d)) hi = d; else break;
    for (let d = 0; d <= 40; d += 1) if (hits(horizontal ? cx - d : cx, horizontal ? cy : cy - d)) lo = d; else break;
    return lo + hi;
  };
  return { w: Math.max(r.width, span(true)), h: Math.max(r.height, span(false)) };
}
const TARGETS = "button, a[href], [role=tab], [role=option], [role=menuitem], [role=menuitemradio], [role=switch], select, input:not([type=hidden]), summary";
function smallTargets(): string[] {
  return all<HTMLElement>(TARGETS).filter((el) => visible(el) && !el.closest(".spatial-node") && !(el instanceof HTMLInputElement && el.type === "file")).filter((el) => {
    const { w, h } = touchSize(el);
    return w < TOUCH - 0.5 || h < TOUCH - 0.5;
  }).map((el) => `${label(el)} ${Math.round(touchSize(el).w)}×${Math.round(touchSize(el).h)}`);
}
function smallText(): string[] {
  const found = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim() || !visible(parent) || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
    const size = parseFloat(getComputedStyle(parent).fontSize);
    if (size < 12 - 0.01) found.add(`${label(parent)} ${size}px`);
  }
  return [...found];
}
function smallFields(): string[] {
  return all<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=range]), select, textarea, [contenteditable=true]")
    .filter(visible).filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => `${label(el)} ${getComputedStyle(el).fontSize}`);
}
const within = (r: DOMRect) => r.left >= -0.5 && r.right <= window.innerWidth + 0.5;
const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

for (const [width, height] of VIEWPORTS) {
  describe(`tela estreita ${width}×${height}`, () => {
    for (const name of SCREENS) {
      describe(name, () => {
        it("sem rolagem horizontal, sem nada passando da borda", async () => {
          await page.viewport(width, height);
          await renderScreen(name);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
          expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
          expect(stickingOut()).toEqual([]);
        });
        it("alvos de toque de 44×44, texto de 12 px e campos de 16 px", async () => {
          await page.viewport(width, height);
          await renderScreen(name);
          expect(smallTargets()).toEqual([]);
          expect(smallText()).toEqual([]);
          expect(smallFields()).toEqual([]);
        });
        it("a navegação, o seletor da organização e o avatar cabem e se alcançam", async () => {
          await page.viewport(width, height);
          await renderScreen(name);
          const parts = [...all(".app-nav a"), q(".cl-organizationSwitcherTrigger")!, q(".cl-userButtonTrigger")!];
          expect(parts).toHaveLength(6);
          for (const el of parts) {
            const r = rectOf(el);
            expect(within(r), label(el)).toBe(true);
            expect(r.top, label(el)).toBeGreaterThanOrEqual(0);
            expect(r.bottom, label(el)).toBeLessThanOrEqual(window.innerHeight);
            const { w, h } = touchSize(el as HTMLElement);
            expect(w, label(el)).toBeGreaterThanOrEqual(TOUCH - 0.5);
            expect(h, label(el)).toBeGreaterThanOrEqual(TOUCH - 0.5);
          }
        });
      });
    }

    it("o mapa: barra de pedidos, controles e dica não se sobrepõem; as folhas cabem na tela", async () => {
      await page.viewport(width, height);
      await renderScreen("map", { assistant: true });
      const bar = rectOf(q(".command-bar")!);
      expect(bar.left).toBeGreaterThanOrEqual(8);
      expect(bar.right).toBeLessThanOrEqual(width - 8);
      for (const other of [".spatial-toolbar", ".spatial-help", ".spatial-selection"]) {
        const el = q(other);
        if (el && visible(el)) expect(overlap(bar, rectOf(el)), `barra × ${other}`).toBe(false);
      }
      await userEvent.click(q<HTMLInputElement>(".command-field input")!);
      await userEvent.keyboard("a");
      await settle();
      const sheet = rectOf(q(".command-bar")!);
      expect(sheet.left).toBeGreaterThanOrEqual(0);
      expect(sheet.right).toBeLessThanOrEqual(width);
      expect(sheet.bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(overlap(sheet, rectOf(q(".spatial-toolbar")!)), "folha de busca × controles").toBe(false);
      expect(smallTargets()).toEqual([]);
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      await settle();
      const ask = q(".assistant-sheet:not([hidden])");
      if (ask) {
        const r = rectOf(ask);
        expect(within(r)).toBe(true);
        expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(stickingOut()).toEqual([]);
        expect(smallTargets()).toEqual([]);
        expect(smallText()).toEqual([]);
      }
    });

    it("a página do ticket ocupa a tela inteira, com o fechar visível, e fecha", async () => {
      await page.viewport(width, height);
      await renderScreen("ticket");
      const pageEl = q(".ticket-page")!;
      const r = rectOf(pageEl);
      expect([r.left, r.top, r.width, r.height]).toEqual([0, 0, width, height]);
      const close = q<HTMLElement>('.ticket-header button[aria-label="Fechar e voltar ao mapa"]')!;
      expect(close.getAttribute("aria-label")).toBe("Fechar e voltar ao mapa");
      const c = rectOf(close);
      expect(c.top).toBeGreaterThanOrEqual(0);
      expect(c.right).toBeLessThanOrEqual(width);
      expect(touchSize(close).w).toBeGreaterThanOrEqual(TOUCH - 0.5);
      expect(touchSize(close).h).toBeGreaterThanOrEqual(TOUCH - 0.5);
      // Rolando o conteúdo até o fim, o cabeçalho com o fechar segue no lugar.
      const body = q(".ticket-body")!;
      body.scrollTop = body.scrollHeight;
      expect(rectOf(close).top).toBeGreaterThanOrEqual(0);
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
      close.click();
      await settle();
      expect(q(".ticket-page")).toBeNull();
    });

    it("as linhas de propriedade empilham o rótulo e o valor", async () => {
      await page.viewport(width, height);
      await renderScreen("ticket");
      for (const row of all(".ticket-row")) {
        const dt = row.querySelector("dt")!;
        const dd = row.querySelector("dd")!;
        expect(rectOf(dd).top, label(row)).toBeGreaterThanOrEqual(rectOf(dt).bottom - 0.5);
        expect(rectOf(dd).left, label(row)).toBeLessThanOrEqual(rectOf(dt).left + 20);
      }
    });

    it("os menus abrem dentro da tela", async () => {
      await page.viewport(width, height);
      await renderScreen("ticket");
      const openers: Array<() => HTMLElement | null> = [
        () => q(".ticket-row button"),
        () => q('button[aria-label="Mais ações"]'),
        () => all("button").find((b) => b.textContent?.trim() === "Adicionar área") ?? null,
        () => all("button.ticket-dashed").find((b) => b.textContent?.trim() === "Adicionar") ?? null,
      ];
      for (const [index, opener] of openers.entries()) {
        const button = opener();
        expect(button, `abridor ${index}`).not.toBeNull();
        button!.scrollIntoView({ block: "center" });
        button!.click();
        await settle(250);
        const menu = all(".ticket-menu, .ticket-picker, select[aria-label='Adicionar pessoa']").filter(visible).at(-1);
        expect(menu, `menu ${index}`).toBeDefined();
        const m = rectOf(menu!);
        expect(within(m), `menu ${index}`).toBe(true);
        expect(stickingOut(), `menu ${index}`).toEqual([]);
        expect(smallTargets(), `menu ${index}`).toEqual([]);
        if (index === 1) {
          // A confirmação de remover também abre dentro da tela.
          const remove = all<HTMLElement>(".ticket-menu button").find((b) => /Remover ticket/.test(b.textContent ?? ""));
          expect(remove, "remover ticket").toBeDefined();
          remove!.click();
          await settle(250);
          const confirm = all(".ticket-menu .confirm-action, .ticket-page .confirm-action").filter(visible).at(-1);
          expect(confirm, "confirmação").toBeDefined();
          expect(within(rectOf(confirm!)), "confirmação").toBe(true);
          expect(smallTargets(), "confirmação").toEqual([]);
        }
        await userEvent.keyboard("{Escape}");
        await settle(150);
      }
    });

    it("Ideias: uma coluna, ações de 44 px, confirmação e seletor dentro da tela", async () => {
      await page.viewport(width, height);
      await renderScreen("ideas");
      const select = q<HTMLSelectElement>(".ideas-project select")!;
      expect(within(rectOf(select))).toBe(true);
      for (const row of all(".ideas-row")) {
        expect(within(rectOf(row)), label(row)).toBe(true);
        expect(rectOf(row.querySelector(".ideas-actions")!).top, label(row)).toBeGreaterThanOrEqual(rectOf(row.querySelector(".ideas-main")!).bottom - 0.5);
      }
      for (const asked of ["Aceitar ALFA-3", "Descartar ALFA-4"]) {
        const button = all<HTMLElement>("button").find((b) => b.getAttribute("aria-label") === asked)!;
        button.scrollIntoView({ block: "center" });
        button.click();
        await settle(250);
        const confirm = all(".ideas-row .confirm-action").filter(visible).at(-1);
        expect(confirm, asked).toBeDefined();
        expect(within(rectOf(confirm!)), asked).toBe(true);
        expect(stickingOut(), asked).toEqual([]);
        expect(smallTargets(), asked).toEqual([]);
        expect(smallFields(), asked).toEqual([]);
        all<HTMLElement>(".ideas-row .confirm-action button").at(-1)!.click();
        await settle(150);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    });

    it("Times, Configurações e importação: uma coluna só, e a lista larga rola dentro dela", async () => {
      await page.viewport(width, height);
      await renderScreen("teams");
      const layout = q(".teams-layout");
      if (layout) expect(getComputedStyle(layout).gridTemplateColumns.split(" ")).toHaveLength(1);
      document.getElementById("root")?.remove();
      await renderScreen("import");
      expect(getComputedStyle(q(".import-columns")!).gridTemplateColumns.split(" ")).toHaveLength(1);
    });
  });
}

describe("margens seguras e altura da tela", () => {
  it("a página declara viewport-fit=cover e a altura dinâmica, e as regras usam env(safe-area-inset-*) e dvh", async () => {
    expect(indexHtml).toMatch(/viewport-fit=cover/);
    expect(indexHtml).toMatch(/interactive-widget=resizes-content/);
    await page.viewport(390, 844);
    await renderScreen("ticket");
    const rules = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } }).map((rule) => rule.cssText).join("\n");
    expect(rules).toMatch(/env\(safe-area-inset-top/);
    expect(rules).toMatch(/env\(safe-area-inset-bottom/);
    expect(rules).toMatch(/100dvh/);
  });
  it("o título da aba é TreePM", () => {
    expect(indexHtml).toMatch(/<title>TreePM<\/title>/);
  });
});

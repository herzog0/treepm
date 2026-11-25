import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { makeLinearConnection } from "../test/fakes.js";
import { FREE, LINKED, mountImport } from "./importMount.js";

// A aba "Do Linear" da importação (ADR 0060), em navegador real: sem rolagem horizontal, contraste (4,5:1), texto centrado nos botões,
// foco visível, alvos de 44 px no celular e a barra de progresso sem deslocar o conteúdo ao mudar de fase.
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
/** Só os elementos à vista: a aba "Por lista" fica montada (escondida) e tem o seu próprio botão "Importar". */
const byText = <T extends Element = HTMLElement>(selector: string, text: string) =>
  all<T>(selector).find((element) => (element.textContent ?? "").trim() === text && element.getBoundingClientRect().width > 0)!;

type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgb) {
    const parts = rgb[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  const srgb = /^color\(srgb ([^)]+)\)$/.exec(color);
  if (srgb) {
    const parts = srgb[1]!.split(/[ /]+/).filter(Boolean).map(Number);
    return [parts[0]! * 255, parts[1]! * 255, parts[2]! * 255, parts[3] ?? 1];
  }
  throw new Error(`cor ilegível: ${color}`);
}
function backgroundOf(element: Element): [number, number, number] {
  const layers: Rgba[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = parse(getComputedStyle(node).backgroundColor);
    if (color[3] > 0) layers.push(color);
    if (color[3] === 1) break;
  }
  let base: [number, number, number] = [8, 9, 13];
  for (const layer of layers.reverse()) base = [0, 1, 2].map((i) => layer[i]! * layer[3] + base[i]! * (1 - layer[3])) as [number, number, number];
  return base;
}
const luminance = ([r, g, b]: number[]) => {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
};
function contrastOf(element: Element): number {
  const fg = parse(getComputedStyle(element).color);
  const bg = backgroundOf(element);
  const mixed = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
  const [a, b] = [luminance(mixed), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const noHorizontalScroll = () => {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
function expectTextCentered(button: Element, label: string) {
  const range = document.createRange();
  range.selectNodeContents(button);
  const text = range.getBoundingClientRect();
  const box = button.getBoundingClientRect();
  expect(Math.abs(text.left + text.width / 2 - (box.left + box.width / 2)), `${label}: centro horizontal`).toBeLessThan(1);
  expect(Math.abs(text.top + text.height / 2 - (box.top + box.height / 2)), `${label}: centro vertical`).toBeLessThan(1);
}
const hold = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const inProgress = (extra = {}) => ({ connection: makeLinearConnection(), projects: { p1: LINKED }, run: { total: 412, existing: { phase: "issues" as const, totalExpected: 412, counts: { projectsSeen: 6, issuesSeen: 255 } }, ...extra } });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.each([[1440, 900], [720, 900], [390, 844]])("importação do Linear com %i px de largura", (width, height) => {
  it("pronta para importar: sem rolagem horizontal, botão centrado e destino aberto cabendo", async () => {
    await mountImport({ width, height });
    await expect.poll(() => byText("button", "Importar")).toBeTruthy();
    noHorizontalScroll();
    expectTextCentered(byText("button", "Importar"), "Importar");
    expectTextCentered(byText("button", "Do Linear"), "aba");
    await userEvent.click(byText("button", "Trocar"));
    await expect.poll(() => q('[role="group"]')).not.toBeNull();
    noHorizontalScroll();
    const picker = q(".linear-import-picker").getBoundingClientRect();
    expect(picker.right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("sem vínculo e com chave que não serve: sem rolagem horizontal", async () => {
    await mountImport({ width, height, linear: { connection: makeLinearConnection(), projects: { p1: FREE } } });
    await expect.poll(() => q(".linear-import-notice")).not.toBeNull();
    noHorizontalScroll();
    expectTextCentered(byText("button", "Abrir Configurações → Linear"), "Abrir Configurações");
  });

  it("em andamento, esperando, com erro e concluído: sem rolagem horizontal", async () => {
    const wait = await mountImport({ width, height, linear: inProgress({ script: [{ waitSeconds: 3600 }] }) });
    await expect.poll(() => q(".linear-import-note")).not.toBeNull();
    noHorizontalScroll();
    wait.screen.unmount();
    await mountImport({ width, height, linear: inProgress({ script: [{ error: ["unavailable", "linear_key_invalid"] }] }) });
    await expect.poll(() => q('[role="alert"]')).not.toBeNull();
    noHorizontalScroll();
    expectTextCentered(byText("button", "Continuar"), "Continuar");
  });

  it("concluído: contagens e botão cabem na tela", async () => {
    await mountImport({ width, height, linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "done", done: true, counts: { projectsCreated: 6, issuesCreated: 406, issuesExisting: 3, flattened: 2, skipped: 1 } } } }, hash: "" });
    await userEvent.click(byText("button", "Do Linear"));
    await expect.poll(() => q(".linear-import-counts")).not.toBeNull();
    noHorizontalScroll();
    expectTextCentered(byText("button", "Abrir no mapa"), "Abrir no mapa");
  });
});

describe("contraste (4,5:1)", () => {
  it("textos e botões de cada estado", async () => {
    const { promise, release } = hold();
    const view = await mountImport({ linear: inProgress({ script: [{ hold: promise }] }) });
    await expect.poll(() => q('[role="progressbar"]')).not.toBeNull();
    for (const selector of [".linear-import-count", ".linear-import-close", ".linear-import-phases li", ".linear-import-mark", "h3", ".import-tabs [aria-selected='true']", ".import-tabs [aria-selected='false']"]) {
      for (const element of all(selector)) expect(contrastOf(element), selector).toBeGreaterThanOrEqual(4.5);
    }
    release();
    await expect.poll(() => q(".linear-import-counts")).not.toBeNull();
    for (const selector of [".linear-import-counts dt", ".linear-import-counts dd", ".linear-import-how", "button.primary"]) {
      for (const element of all(selector)) expect(contrastOf(element), selector).toBeGreaterThanOrEqual(4.5);
    }
    view.screen.unmount();
    await mountImport({});
    await expect.poll(() => byText("button", "Importar")).toBeTruthy();
    for (const selector of [".linear-import-facts dt", ".linear-import-facts dd", ".linear-import-how", "button"]) {
      for (const element of all(selector)) expect(contrastOf(element), selector).toBeGreaterThanOrEqual(4.5);
    }
    await mountImport({ linear: inProgress({ script: [{ error: ["unavailable", "linear_key_invalid"] }] }) });
    await expect.poll(() => q('[role="alert"]')).not.toBeNull();
    expect(contrastOf(q('[role="alert"]'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("foco e alvos de toque", () => {
  it("o foco é visível nas abas e no botão Importar", async () => {
    await mountImport({});
    await expect.poll(() => byText("button", "Importar")).toBeTruthy();
    for (const element of [q<HTMLElement>('[role="tab"][aria-selected="true"]'), byText("button", "Importar")]) {
      // Pelo teclado, como a pessoa chega: `:focus-visible` só vale depois de Tab.
      await userEvent.keyboard("{Shift}");
      element.focus();
      expect(document.activeElement).toBe(element);
      const style = getComputedStyle(element);
      expect(style.outlineStyle !== "none" || style.boxShadow !== "none", "foco visível").toBe(true);
    }
  });

  it("no celular, abas, botões e itens do seletor têm pelo menos 44 px de altura", async () => {
    await mountImport({ width: 390, height: 844 });
    await expect.poll(() => byText("button", "Importar")).toBeTruthy();
    await userEvent.click(byText("button", "Trocar"));
    await expect.poll(() => q(".linear-import-picker-list button")).not.toBeNull();
    for (const element of [...all('[role="tab"]'), ...all(".linear-import-card button"), ...all(".linear-import-picker-list button")]) {
      expect(element.getBoundingClientRect().height, element.textContent ?? "").toBeGreaterThanOrEqual(44);
    }
  });
});

describe("a barra de progresso não desloca o conteúdo", () => {
  it("mudar de fase mantém a altura e a posição do cartão e da lista de fases", async () => {
    const first = hold();
    const second = hold();
    const view = await mountImport({ linear: inProgress({ pageSize: 100, existing: { phase: "issues" as const, totalExpected: 412, counts: { projectsSeen: 6, issuesSeen: 400 } }, script: [{ hold: first.promise }, { hold: second.promise }] }) });
    await expect.poll(() => q('[role="progressbar"]')).not.toBeNull();
    const measure = () => ({ card: q(".linear-import-card").getBoundingClientRect().height, phases: q(".linear-import-phases").getBoundingClientRect().top, bar: q('[role="progressbar"]').getBoundingClientRect().top });
    const before = measure();
    first.release();
    // O passo seguinte leva a rodada a "hierarquia": a barra enche e as fases mudam de estado, mas nada se move.
    await expect.poll(() => all(".linear-import-phases li")[2]?.getAttribute("data-state")).toBe("doing");
    const after = measure();
    expect(after).toEqual(before);
    second.release();
    view.screen.unmount();
  });
});

describe.each([[1440, 900], [720, 900], [390, 844]])("abandonar a importação com %i px de largura", (width, height) => {
  it("botão e confirmação: sem rolagem horizontal, contraste, texto centrado e alvos de toque", async () => {
    const { promise, release } = hold();
    const view = await mountImport({ width, height, linear: inProgress({ existing: { phase: "issues" as const, totalExpected: 412, errorStreak: 0, counts: { projectsSeen: 6, issuesSeen: 255 } }, script: [{ hold: promise }] }) });
    await expect.poll(() => byText("button", "Abandonar importação")).toBeTruthy();
    noHorizontalScroll();
    const quiet = byText("button", "Abandonar importação");
    expect(contrastOf(quiet), "botão discreto").toBeGreaterThanOrEqual(4.5);
    expectTextCentered(quiet, "Abandonar importação");
    if (width <= 720) expect(quiet.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(quiet);
    await expect.poll(() => q('[role="group"][aria-label="Confirmar abandono"]')).not.toBeNull();
    noHorizontalScroll();
    const confirm = q('[role="group"][aria-label="Confirmar abandono"]');
    expect(contrastOf(confirm.querySelector("p")!), "texto da confirmação").toBeGreaterThanOrEqual(4.5);
    for (const label of ["Abandonar", "Voltar"]) {
      const button = [...confirm.querySelectorAll("button")].find((element) => element.textContent === label)!;
      expect(contrastOf(button), label).toBeGreaterThanOrEqual(4.5);
      expectTextCentered(button, label);
      if (width <= 720) expect(button.getBoundingClientRect().height, label).toBeGreaterThanOrEqual(44);
    }
    release();
    view.screen.unmount();
  });

  it("em destaque (3 falhas seguidas) e a tela de importação abandonada", async () => {
    const { promise, release } = hold();
    const view = await mountImport({ width, height, linear: inProgress({ existing: { phase: "issues" as const, totalExpected: 412, errorStreak: 3, counts: { projectsSeen: 6, issuesSeen: 255 } }, script: [{ hold: promise }] }) });
    await expect.poll(() => byText("button", "Abandonar importação")).toBeTruthy();
    const prominent = byText("button", "Abandonar importação");
    expect(prominent.classList.contains("is-prominent")).toBe(true);
    expect(contrastOf(prominent), "botão em destaque").toBeGreaterThanOrEqual(4.5);
    expectTextCentered(prominent, "Abandonar importação em destaque");
    noHorizontalScroll();
    release();
    view.screen.unmount();
    await mountImport({ width, height, linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "failed" as const, done: true, counts: { projectsCreated: 3, issuesCreated: 120 } } } } });
    await expect.poll(() => q(".linear-import-previous")).not.toBeNull();
    expect(contrastOf(q(".linear-import-previous"))).toBeGreaterThanOrEqual(4.5);
    noHorizontalScroll();
    expectTextCentered(byText("button", "Importar"), "Importar");
  });
});

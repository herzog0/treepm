import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { makeLinearConnection } from "../test/fakes.js";
import { PROJECTS, TEAMS, mountLinear, settle } from "./linearMount.js";

// Seção "Linear" e diálogo de ligação permanente (ADR 0060), em navegador real: sem rolagem horizontal, contraste (4,5:1), texto centrado nos
// botões, foco visível e ordem de Tab no diálogo, e alvos de toque de 44 px no celular.
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const byText = <T extends Element = HTMLElement>(selector: string, text: string | RegExp) =>
  all<T>(selector).find((element) => (typeof text === "string" ? (element.textContent ?? "").trim() === text : text.test(element.textContent ?? "")))!;

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
/** Contraste WCAG do texto do elemento contra o fundo que o cobre, sem contar `opacity` (o botão desabilitado usa a do projeto). */
function contrastOf(element: Element): number {
  const fg = parse(getComputedStyle(element).color);
  const bg = backgroundOf(element);
  const mixed = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
  const [a, b] = [luminance(mixed), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const noHorizontalScroll = () => {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  const main = q(".tenant-settings");
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
};
/** O texto do botão (a caixa do próprio texto) centrado no botão, na horizontal e na vertical, a menos de 1 px. */
function expectTextCentered(button: Element, label: string) {
  const range = document.createRange();
  range.selectNodeContents(button);
  const text = range.getBoundingClientRect();
  const box = button.getBoundingClientRect();
  expect(Math.abs(text.left + text.width / 2 - (box.left + box.width / 2)), `${label}: centro horizontal`).toBeLessThan(1);
  expect(Math.abs(text.top + text.height / 2 - (box.top + box.height / 2)), `${label}: centro vertical`).toBeLessThan(1);
}

const dialog = () => q('[role="dialog"]');
const openDialog = async () => {
  await userEvent.click(byText("button", "Ligar a um projeto…"));
  await expect.poll(() => document.querySelector('[role="dialog"] select')).not.toBeNull();
  await settle(100);
};
const choose = async () => {
  await userEvent.selectOptions(q<HTMLSelectElement>("[role=dialog] select"), "p1");
  await userEvent.type(q('[role="dialog"] input[type="text"]'), "DES");
};

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.each([[1440 - 296, 900], [720, 900], [390, 844]])("seção Linear com %i px de largura", (width, height) => {
  it("conectada, com os três estados de time: sem rolagem horizontal", async () => {
    await mountLinear({ width, height });
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    noHorizontalScroll();
    // Cada linha de time cabe na coluna: nenhuma caixa passa da borda da página.
    for (const row of all(".linear-teams > li")) expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("sem chave: o campo e o botão cabem na tela", async () => {
    await mountLinear({ width, height, linear: {} });
    await expect.poll(() => q('input[type="password"]')).not.toBeNull();
    noHorizontalScroll();
    expect(q('input[type="password"]').getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("diálogo aberto: cabe na tela, sem rolagem horizontal, com os botões à vista", async () => {
    await mountLinear({ width, height });
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    await openDialog();
    await choose();
    noHorizontalScroll();
    const box = q(".linear-dialog-box").getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(q(".linear-dialog-box").scrollWidth).toBeLessThanOrEqual(q(".linear-dialog-box").clientWidth);
    for (const button of all("[role=dialog] button")) {
      const rect = button.getBoundingClientRect();
      expect(rect.right).toBeLessThanOrEqual(box.right);
      expect(rect.left).toBeGreaterThanOrEqual(box.left);
    }
  });
});

describe("contraste (4,5:1) dos textos e botões novos", () => {
  it("seção sem chave, conectada e com os times", async () => {
    const first = await mountLinear({ linear: {} });
    await expect.poll(() => q('input[type="password"]')).not.toBeNull();
    for (const element of [q(".linear-guide"), q(".linear-key-form label"), byText("button", "Conectar"), q(".settings-lead"), q(".settings-card-head h3"), q(".linear-footnote")]) {
      expect(contrastOf(element), element.textContent ?? "").toBeGreaterThanOrEqual(4.5);
    }
    const field = q('input[type="password"]');
    expect(contrastOf(field)).toBeGreaterThanOrEqual(4.5);
    await first.screen.unmount();

    await mountLinear({});
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    const elements: Element[] = [
      q(".linear-ok"), q(".settings-row-title"), q(".settings-row-hint"), q(".settings-card-note"), q(".settings-danger-row .confirm-message") ?? q(".settings-danger-row"),
      byText("button", "Substituir"), byText("button", "Remover"), byText("button", "Atualizar"), byText("button", "Ligar a um projeto…"),
      q(".linear-badge-lock"), byText(".linear-badge", "indisponível"), q(".linear-team-off"), q(".linear-teams .settings-row-hint"),
    ];
    for (const element of elements) expect(contrastOf(element), element.textContent ?? "").toBeGreaterThanOrEqual(4.5);
    for (const hint of all(".linear-teams .settings-row-hint")) expect(contrastOf(hint), hint.textContent ?? "").toBeGreaterThanOrEqual(4.5);
  });

  it("diálogo: título, aviso, resumo, campo, erro e botões (habilitado e, por padrão do projeto, desabilitado)", async () => {
    await mountLinear({ linear: { connection: makeLinearConnection(), teams: TEAMS, linkError: ["unavailable", "linear_unavailable"] } });
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    await openDialog();
    const submit = byText<HTMLButtonElement>("[role=dialog] button", "Ligar para sempre");
    expect(submit.disabled).toBe(true);
    // Desabilitado: o padrão do projeto (`opacity` 0,5 e cursor de bloqueado, WCAG isenta); a cor do texto em si segue o par do botão habilitado.
    expect(getComputedStyle(submit).opacity).toBe("0.5");
    expect(getComputedStyle(submit).cursor).toBe("not-allowed");
    expect(contrastOf(submit)).toBeGreaterThanOrEqual(4.5);
    await choose();
    expect(submit.disabled).toBe(false);
    expect(getComputedStyle(submit).opacity).toBe("1");
    await userEvent.click(submit);
    await expect.poll(() => q('[role="dialog"] [role="alert"]')).not.toBeNull();
    const elements: Element[] = [
      q("[role=dialog] h2"), q(".linear-warning"), q(".linear-warning strong"), q(".linear-summary dt"), q(".linear-summary dd"), q(".linear-confirm"), q(".linear-confirm strong"),
      q('[role="dialog"] input[type="text"]'), q("[role=dialog] select"), q('[role="dialog"] [role="alert"]'), submit, byText("[role=dialog] button", "Cancelar"),
    ];
    for (const element of elements) expect(contrastOf(element), element.textContent ?? element.tagName).toBeGreaterThanOrEqual(4.5);
  });
});

describe("texto centrado nos botões (menos de 1 px)", () => {
  it("seção e diálogo", async () => {
    const first = await mountLinear({});
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    for (const label of ["Substituir", "Remover", "Atualizar", "Ligar a um projeto…"]) expectTextCentered(byText("button", label), label);
    await openDialog();
    await choose();
    for (const label of ["Cancelar", "Ligar para sempre"]) expectTextCentered(byText("[role=dialog] button", label), label);
    await first.screen.unmount();
    await mountLinear({ linear: {} });
    await expect.poll(() => q('input[type="password"]')).not.toBeNull();
    expectTextCentered(byText("button", "Conectar"), "Conectar");
  });
});

describe("teclado no diálogo", () => {
  it("o foco entra no diálogo, a ordem de Tab é a do desenho, o foco é visível e fica preso", async () => {
    await mountLinear({});
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    const opener = byText("button", "Ligar a um projeto…");
    await userEvent.click(opener);
    await expect.poll(() => document.querySelector('[role="dialog"] select')).not.toBeNull();
    await settle(100);
    const select = q<HTMLSelectElement>("[role=dialog] select");
    expect(dialog().contains(document.activeElement)).toBe(true);
    await userEvent.selectOptions(select, "p1");
    const field = q<HTMLInputElement>('[role="dialog"] input[type="text"]');
    const cancel = byText("[role=dialog] button", "Cancelar");
    const submit = byText("[role=dialog] button", "Ligar para sempre");
    select.focus();
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 && style.outlineColor !== "rgba(0, 0, 0, 0)";
    };
    const order: Element[] = [];
    // Primeiro Tab com o botão ainda desabilitado: select → campo → Cancelar → (volta ao select).
    await userEvent.tab();
    order.push(document.activeElement!);
    expect(visible(document.activeElement!), "foco visível no campo").toBe(true);
    await userEvent.tab();
    order.push(document.activeElement!);
    expect(visible(document.activeElement!), "foco visível em Cancelar").toBe(true);
    await userEvent.tab();
    order.push(document.activeElement!);
    expect(order).toEqual([field, cancel, select]);
    await userEvent.type(field, "DES");
    cancel.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(submit);
    expect(visible(submit), "foco visível em Ligar para sempre").toBe(true);
    await userEvent.tab();
    expect(document.activeElement).toBe(select);
    expect(visible(select), "foco visível no seletor").toBe(true);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(submit);
    // Esc cancela e o foco volta ao botão de origem.
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("alvos de toque no celular (390 px)", () => {
  it("botões e campos da seção e do diálogo têm pelo menos 44 px", async () => {
    const first = await mountLinear({ width: 390, height: 844 });
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    const small = (elements: Element[]) => elements.filter((element) => element.getBoundingClientRect().height < 44 || element.getBoundingClientRect().width < 44).map((element) => element.textContent?.trim() || element.tagName);
    expect(small(all(".settings-pane button"))).toEqual([]);
    await openDialog();
    await choose();
    expect(small(all("[role=dialog] button, [role=dialog] select, [role=dialog] input"))).toEqual([]);
    await first.screen.unmount();
    await mountLinear({ width: 390, height: 844, linear: {} });
    await expect.poll(() => q('input[type="password"]')).not.toBeNull();
    expect(small(all(".settings-pane button, .settings-pane input"))).toEqual([]);
  });
});

describe("sem consulta desnecessária", () => {
  it("os projetos só são consultados ao abrir o diálogo", async () => {
    const { client } = await mountLinear({});
    await expect.poll(() => all(".linear-teams > li").length).toBe(3);
    expect(client.getProjectLinear).not.toHaveBeenCalled();
    await openDialog();
    expect(client.getProjectLinear).toHaveBeenCalledTimes(PROJECTS.length);
  });
});

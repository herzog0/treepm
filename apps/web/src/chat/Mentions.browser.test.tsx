import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { settle } from "../layout/layoutMeasure.js";
import { mountConversations, rowOf } from "./conversationHarness.js";

// O seletor de @ e # (ADR 0056, fatia 1) no navegador real: junto do ponto do texto, dentro da tela, sem rolagem lateral e com contraste.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const poll = <T,>(read: () => T) => expect.poll(read, { timeout: 5000, interval: 100 });
const field = () => page.getByRole("combobox", { name: "Mensagem" });
const rect = (selector: string) => q(selector)!.getBoundingClientRect();
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const rgba = (css: string): number[] => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
};
const over = (top: number[], below: number[]) => { const a = top[3]! / 255; return [0, 1, 2].map((i) => top[i]! * a + below[i]! * (1 - a)).concat(255); };
const backdrop = (el: Element): number[] => {
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
  return chain.reduceRight<number[]>((below, node) => over(rgba(getComputedStyle(node).backgroundColor), below), [8, 9, 13, 255]);
};
const contrastOf = (el: Element) => { const bg = backdrop(el); return ratio(over(rgba(getComputedStyle(el).color), bg).slice(0, 3), bg.slice(0, 3)); };

async function openGeneral() {
  await mountConversations({ seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]) });
  await poll(() => document.querySelectorAll("button.conv-row").length).toBeGreaterThanOrEqual(1);
  rowOf(/Meu chat/).click();
  await poll(() => q(".chat-composer textarea")).not.toBeNull();
  await settle(500);
}
afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1440, 900);
});

describe("o seletor junto do ponto do texto, 1440×900", () => {
  it("abre acima da linha do cursor (medida), dentro do campo, e acompanha a linha seguinte", async () => {
    await page.viewport(1440, 900);
    await openGeneral();
    await userEvent.fill(field(), "primeira linha\n");
    await userEvent.type(field(), "@");
    await poll(() => q(".chat-mention-list")).not.toBeNull();
    const area = q<HTMLTextAreaElement>(".chat-composer textarea")!;
    const style = getComputedStyle(area);
    const line = Number.parseFloat(style.lineHeight);
    const secondLineTop = area.getBoundingClientRect().top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop) + line;
    await poll(() => Math.abs(rect(".chat-mention-list").bottom - (secondLineTop - 6))).toBeLessThan(3);
    const box = area.getBoundingClientRect();
    expect(rect(".chat-mention-list").left).toBeGreaterThanOrEqual(box.left - 0.5);
    expect(rect(".chat-mention-list").right).toBeLessThanOrEqual(box.right + 0.5);
    expect(q("[role=combobox]")).toBe(area);
    expect(area.getAttribute("aria-activedescendant")).toBe(q("[role=option][aria-selected=true]")!.id);
    expect(document.activeElement).toBe(area);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    if (ON) await shot("f1-01-seletor-de-pessoas");
  });

  it("o # abre a lista de tickets com bolinha, chave, título e caminho", async () => {
    await page.viewport(1440, 900);
    await openGeneral();
    await userEvent.type(field(), "Como está o #");
    await poll(() => document.querySelectorAll(".chat-mention-list [role=option]").length).toBeGreaterThan(0);
    expect(q(".chat-mention-list [role=option] .chat-option-title code")!.textContent).toMatch(/^ALFA-\d$/);
    expect(q(".chat-mention-list [role=option] .chat-situation-dot")).not.toBeNull();
    if (ON) {
      await shot("f1-02-seletor-de-tickets");
      await userEvent.keyboard("{Enter}");
      await userEvent.type(field(), "e o @");
      await settle(300);
      await userEvent.keyboard("{Enter}");
      await settle(300);
      await shot("f1-03-aviso-ticket-e-pessoa");
    }
  });

  it("contraste da opção escolhida e da normal", async () => {
    await page.viewport(1440, 900);
    await openGeneral();
    await userEvent.type(field(), "@");
    await poll(() => q("[role=option][aria-selected=true]")).not.toBeNull();
    for (const el of document.querySelectorAll<HTMLElement>("[role=option][aria-selected=true] .chat-option-title")) expect(contrastOf(el), "escolhida").toBeGreaterThanOrEqual(4.5);
    for (const el of document.querySelectorAll<HTMLElement>("[role=option]:not([aria-selected=true]) .chat-option-title")) expect(contrastOf(el), "normal").toBeGreaterThanOrEqual(4.5);
  });

  it("contraste da opção apagada na lista de verdade: quem não enxerga o projeto do ticket aparece apagado, com o motivo", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ privateProject: true, seed: (chat) => void chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    await poll(() => document.querySelectorAll("button.conv-row").length).toBeGreaterThanOrEqual(1);
    rowOf("ALFA-1").click();
    await poll(() => q(".chat-composer textarea")).not.toBeNull();
    await userEvent.type(field(), "@");
    await poll(() => document.querySelectorAll("[role=option][aria-disabled=true]").length).toBeGreaterThan(0);
    // A primeira (a escolhida, porque nenhuma outra pode sê-lo) e as demais (normais): todas com o motivo e contraste.
    for (const dim of document.querySelectorAll<HTMLElement>("[role=option][aria-disabled=true]")) {
      expect(dim.textContent).toContain("Não enxerga o projeto deste ticket");
      for (const el of dim.querySelectorAll<HTMLElement>(".chat-option-title, .chat-option-sub")) expect(contrastOf(el), `apagada${dim.getAttribute("aria-selected") === "true" ? " e escolhida" : ""}`).toBeGreaterThanOrEqual(4.5);
    }
    await userEvent.keyboard("{ArrowDown}");
    for (const dim of document.querySelectorAll<HTMLElement>("[role=option][aria-disabled=true]")) for (const el of dim.querySelectorAll<HTMLElement>(".chat-option-title, .chat-option-sub")) expect(contrastOf(el), "apagada depois da seta").toBeGreaterThanOrEqual(4.5);
  });
});

describe("o seletor na tela estreita (390×700)", () => {
  it("não sai da tela na borda direita, nem rola para o lado, com o campo no fim da página", async () => {
    await page.viewport(390, 700);
    await mountConversations({ seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]) });
    await poll(() => document.querySelectorAll("button.conv-row").length).toBeGreaterThanOrEqual(1);
    rowOf(/Meu chat/).click();
    await poll(() => q(".chat-composer textarea")).not.toBeNull();
    await settle(500);
    await userEvent.fill(field(), "uma linha bem comprida para chegar perto da borda direita do campo de escrever ");
    await userEvent.type(field(), "@");
    await poll(() => q(".chat-mention-list")).not.toBeNull();
    const list = rect(".chat-mention-list");
    expect(list.left).toBeGreaterThanOrEqual(0);
    expect(list.right).toBeLessThanOrEqual(window.innerWidth + 0.5);
    expect(list.top).toBeGreaterThanOrEqual(0);
    expect(list.bottom).toBeLessThanOrEqual(rect(".chat-composer").bottom);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const option of document.querySelectorAll<HTMLElement>(".chat-mention-list [role=option]")) expect(Math.round(option.getBoundingClientRect().height), "alvo de 44 px").toBeGreaterThanOrEqual(44);
  });
});

describe("elo de ticket na mensagem", () => {
  it("#CHAVE vira pastilha com a chave e a situação, sem o #", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => void chat.seedConversation("t1", [{ person: "veja o #ALFA-2 e o #ZZZ-9", assistant: "ok" }]) });
    await poll(() => document.querySelectorAll("button.conv-row").length).toBeGreaterThanOrEqual(2);
    rowOf("ALFA-1").click();
    await poll(() => q(".chat-ticket-link")).not.toBeNull();
    expect(q(".chat-ticket-link")!.textContent).toBe("ALFA-2");
    expect(contrastOf(q(".chat-ticket-link span")!)).toBeGreaterThanOrEqual(4.5);
    if (ON) await shot("f1-04-elo-na-mensagem");
  });
});

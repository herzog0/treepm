import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "../ticket/TicketPage.js";
import { LINKED, mountImport, settle } from "./importMount.js";

// A reimportação (ADR 0060, seção 5) em navegador real: cartão "Última importação", durante, resumo e o aviso do ticket, em 1440, 720 e
// 390 px: sem rolagem horizontal, contraste (4,5:1), texto centrado nos botões e alvos de 44 px no celular.
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
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
const DAY = 86_400_000;
const lastRun = (extra = {}) => ({
  phase: "done" as const,
  done: true,
  mode: "reimport" as const,
  finishedAt: new Date(Date.now() - 2 * DAY).toISOString(),
  destinationTicketId: null,
  counts: { projectsCreated: 1, issuesCreated: 8, updated: 23, keptTouched: 5, keptMoved: 3, missing: 2, elsewhere: 1, assigneeEmailUnavailable: true, descriptionUnavailable: true, missingNotChecked: true },
  ...extra,
});
const card = (run: object = {}, existing = {}) => ({ connection: makeLinearConnection(), projects: { p1: LINKED }, run: { total: 4, projects: 0, existing: lastRun(existing), ...run } });

afterEach(async () => {
  window.location.hash = "";
  await page.viewport(1440, 900);
});

describe.each([[1440, 900], [720, 900], [390, 844]])("reimportação com %i px de largura", (width, height) => {
  it("cartão da última importação: sem rolagem horizontal, contraste, botões centrados e alvos de toque", async () => {
    await mountImport({ width, height, linear: card() });
    await expect.poll(() => byText("button", "Sincronizar agora")).toBeTruthy();
    noHorizontalScroll();
    for (const label of ["Sincronizar agora", "Abrir no mapa", "Mudar destino das issues novas"]) {
      const button = byText("button", label);
      expect(button, label).toBeTruthy();
      expectTextCentered(button, label);
      expect(contrastOf(button), label).toBeGreaterThanOrEqual(4.5);
      if (width <= 720) expect(button.getBoundingClientRect().height, label).toBeGreaterThanOrEqual(44);
    }
    for (const selector of ["h3", ".linear-import-counts dt", ".linear-import-counts dd", ".linear-import-how", ".linear-import-warning"]) {
      expect(all(selector).length, selector).toBeGreaterThan(0);
      for (const element of all(selector)) expect(contrastOf(element), selector).toBeGreaterThanOrEqual(4.5);
    }
    await userEvent.click(byText("button", "Mudar destino das issues novas"));
    await expect.poll(() => q(".linear-import-picker")).not.toBeNull();
    noHorizontalScroll();
    expect(q(".linear-import-picker").getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  });

  it("reimportando: as oito fases (com os comentários e as relações) cabem e nada rola para o lado", async () => {
    const { promise, release } = hold();
    const view = await mountImport({ width, height, linear: card({ script: ["ok", "ok", "ok", "ok", "ok", "ok", "ok", { hold: promise }] }) });
    await userEvent.click(byText("button", "Sincronizar agora"));
    await expect.poll(() => all(".linear-import-phases li").length).toBe(8);
    await expect.poll(() => all(".linear-import-phases li")[7]?.getAttribute("data-state")).toBe("doing");
    noHorizontalScroll();
    expect(q("h3").textContent).toBe("Sincronizando…");
    for (const element of all(".linear-import-phases li, .linear-import-close, h3")) expect(contrastOf(element)).toBeGreaterThanOrEqual(4.5);
    release();
    view.screen.unmount();
  });

  it("resumo da reimportação: linhas, avisos e botão cabem", async () => {
    await mountImport({ width, height, linear: card({ reimportCounts: lastRun().counts }) });
    await userEvent.click(byText("button", "Sincronizar agora"));
    await expect.poll(() => byText("h3", "Sincronização concluída")).toBeTruthy();
    noHorizontalScroll();
    expect(all(".linear-import-counts > div").length).toBe(6);
    expectTextCentered(byText("button", "Abrir no mapa"), "Abrir no mapa");
    for (const selector of [".linear-import-counts dt", ".linear-import-counts dd", ".linear-import-warning", "button.primary"]) {
      for (const element of all(selector)) expect(contrastOf(element), selector).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("o aviso 'Não encontrada no Linear' do ticket cabe, tem contraste e ícone", async () => {
    await page.viewport(width, height);
    const project = makeProject("p1", "DES", "Design");
    const summary = makeTicket("t1", "p1", 88, "Revisar a paleta do mapa", { key: "DES-88" });
    const client = makeClient({ projects: [project], tickets: { p1: [summary] } });
    Object.assign(client, {
      getTicket: async () => ok({ ...summary, description: "", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z", externalSource: { provider: "linear", key: "DES-88", url: "https://linear.app/acme/issue/DES-88/x", missingSince: "2026-11-20T15:00:00.000Z" } }),
    });
    const view = await render(
      <div style={{ display: "grid", height: "100dvh" }}>
        <TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={() => undefined} onClose={() => undefined} onChanged={() => undefined} onRemoved={() => undefined} onStartCreate={() => undefined} onCancelCreate={() => undefined} onCreated={() => undefined} />
      </div>,
    );
    await document.fonts.ready;
    await expect.poll(() => q(".ticket-linear-missing")).not.toBeNull();
    await settle(200);
    noHorizontalScroll();
    const note = q(".ticket-linear-missing");
    expect(note.textContent).toContain("Não encontrada no Linear desde");
    expect(note.querySelector("svg")).not.toBeNull();
    expect(contrastOf(note)).toBeGreaterThanOrEqual(4.5);
    expect(note.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    if (width <= 720) expect(note.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    view.unmount();
  });
});

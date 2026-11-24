import { beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { renderScreen } from "./layoutScreens.js";
import type { LayoutScreen } from "./layoutScreens.js";
import { measure, measureStable, settle } from "./layoutMeasure.js";
import type { Box } from "./layoutMeasure.js";

// TREEPM-231, regra de ouro: acima de 720 px nada muda. Esta suíte grava em 1440×900 o retângulo dos elementos principais de cada tela
// (com `VITE_TREEPM_RECORD=1`, no código de antes da mudança) e confere que o desenho de hoje continua idêntico. Não se edita a linha de base.
//
// ADR 0055, a exceção pedida por Teodoro (2026-11-23/24): o redesign da casca troca o cabeçalho de cima pela barra lateral fixa de 296 px, e a
// linha de base foi REGERADA por esse pedido explícito (a de antes está no Git, em `git show 849d17e:apps/web/src/layout/baseline.desktop.json`).
// As telas (mapa, ticket, times, configurações, importação) perdem a altura do cabeçalho (48 px) e ganham a largura da barra (296 px) à esquerda;
// o desenho de dentro de cada tela não muda. A partir daqui a regra volta a valer: a nova linha de base não se edita.
const BASELINE = "src/layout/baseline.desktop.json";
const RECORD = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_RECORD"] === "1";
const TOLERANCE = 0.6;

const COMMON = [".sidebar", ".sidebar-org", ".sidebar-actions", ".sidebar-new", ".sidebar-search", ".app-nav", ".app-nav a", ".conv-section", ".conv-row", ".sidebar-foot", ".cl-organizationSwitcherTrigger", ".tenant-api-status", ".cl-userButtonTrigger", ".sidebar-settings"];
const SELECTORS: Record<Exclude<LayoutScreen, "ideas">, readonly string[]> = {
  map: [...COMMON, ".org-map", ".spatial-toolbar", ".spatial-toolbar button", ".spatial-help", ".spatial-context", ".command-zone", ".command-bar", ".command-field input"],
  ticket: [...COMMON, ".map-workspace", ".ticket-page", ".ticket-header", ".ticket-chat-button", ".ticket-icon-button", ".ticket-title", ".ticket-row", ".ticket-row button", ".ticket-section", ".ticket-section h2", ".ticket-contribution", ".ticket-contribution-head", ".ticket-activity-item", ".ticket-comment-composer", ".ticket-comment-composer textarea", ".command-bar"],
  teams: [...COMMON, ".teams-screen", ".teams-layout", ".teams-screen h1", ".teams-screen h2", ".teams-screen button", ".teams-screen input", ".teams-screen li"],
  settings: [...COMMON, ".settings-screen", ".settings-screen h1", ".settings-screen h2", ".settings-screen button", ".settings-screen input", ".settings-screen select", ".mcp-token-meta"],
  import: [...COMMON, ".import-screen", ".import-columns", ".import-screen h1", ".import-screen textarea", ".import-screen button", ".import-input", ".import-preview"],
};

const recorded: Record<string, Record<string, Box>> = {};
let stored: Record<string, Record<string, Box>> = {};

beforeAll(async () => {
  if (!RECORD) stored = JSON.parse(await commands.readFile(BASELINE)) as typeof stored;
});

async function observe(screen: Exclude<LayoutScreen, "ideas">, key: string, afterOpen?: () => Promise<void>) {
  await page.viewport(1440, 900);
  await renderScreen(screen);
  await document.fonts.ready;
  const result = await measureStable(SELECTORS[screen]);
  if (afterOpen) {
    await afterOpen();
    await settle();
    Object.assign(result, Object.fromEntries(Object.entries(measure([".ticket-menu", ".command-sheet", ".command-sheet [role=option]"])).map(([k, v]) => [`open:${k}`, v])));
  }
  recorded[key] = result;
  if (RECORD) {
    await commands.writeFile(BASELINE, JSON.stringify(recorded, null, 2) + "\n");
    return;
  }
  const before = stored[key]!;
  expect(Object.keys(result).sort(), `${key}: o conjunto de elementos mudou`).toEqual(Object.keys(before).sort());
  const moved = Object.entries(before).flatMap(([name, box]) => {
    const now = result[name]!;
    const off = (["x", "y", "w", "h"] as const).filter((side) => Math.abs(now[side] - box[side]) > TOLERANCE);
    return off.length ? [`${name}: era ${JSON.stringify(box)}, agora ${JSON.stringify(now)}`] : [];
  });
  expect(moved, `${key}: elementos que mudaram de lugar ou de tamanho`).toEqual([]);
}

describe("desktop 1440×900 inalterado (TREEPM-231)", () => {
  it("mapa com a barra de pedidos", () => observe("map", "map"));
  it("mapa com a folha de busca aberta", () => observe("map", "map+sheet", async () => { await userEvent.click(document.querySelector<HTMLInputElement>(".command-field input")!); await userEvent.keyboard("a"); }));
  it("página do ticket", () => observe("ticket", "ticket"));
  it("página do ticket com o menu de situação aberto", () => observe("ticket", "ticket+menu", async () => { document.querySelector<HTMLElement>(".ticket-row button")!.click(); }));
  it("Times", () => observe("teams", "teams"));
  it("Configurações", () => observe("settings", "settings"));
  it("importação", () => observe("import", "import"));
});

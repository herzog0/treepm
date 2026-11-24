import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { fakeToken, makeClient, makeInstallation, makeMe, makeProject, makeToken } from "../test/fakes.js";
import { SettingsScreen } from "./SettingsScreen.js";

// Redesenho das Configurações (ADR 0028, seções): duas colunas, coluna de leitura de até 760 px, faixa horizontal em tela estreita,
// nenhuma rolagem horizontal e contraste dos textos, em navegador real.
// Com `VITE_TREEPM_CAPTURES=1`, grava uma captura de cada seção (administrador e membro) e da tela estreita em `.vitest/cap` (fora do Git); quem roda as move para fora do repositório.
const CAPTURES = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/config-${name}.png`, save: true });
const SECTIONS = ["idioma", "tokens", "ia", "github", "mcp"] as const;
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

afterEach(() => {
  window.location.hash = "";
});

async function open(role: "admin" | "member", section: (typeof SECTIONS)[number], width: number, height = 900) {
  await page.viewport(width, height);
  window.location.hash = section;
  const me = makeMe({ clerk: role, github: true, assistant: true, consent: true, mcp: true, mcpWrite: true });
  const client = makeClient({
    me,
    projects: [makeProject("p1", "ALFA", "Alfa")],
    github: { installation: makeInstallation() },
    aiConsent: {},
    mcp: {
      secret: fakeToken("s"),
      tokens: [makeToken("a", "Coordenação", { scope: "write" }), makeToken("b", "Leitor do Cursor com um nome comprido de propósito", { scope: "read" })],
    },
  });
  const screen = await render(
    // Como a casca da aplicação: a tela é uma célula da grade que ocupa a altura da janela e rola por dentro.
    <div style={{ display: "grid", height: "100dvh", gridTemplateRows: "minmax(0, 1fr)" }}>
      <main className="tenant-settings" style={{ minWidth: 0, minHeight: 0, overflow: "auto" }}>
        <MemoryPreferencesProvider onSave={vi.fn()}>
          <SettingsScreen client={client} me={me} />
        </MemoryPreferencesProvider>
      </main>
    </div>,
  );
  await document.fonts.ready;
  await settle();
  return screen;
}

const box = (selector: string) => q(selector).getBoundingClientRect();
/** Nenhuma rolagem horizontal: nem da página, nem da área da tela (que rola por dentro). */
const noHorizontalScroll = () => {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  const main = q(".tenant-settings");
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
};

type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
  const hex = /^rgba?\(([^)]+)\)$/.exec(color);
  if (hex) {
    const parts = hex[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
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
/** Razão de contraste WCAG entre o texto do elemento e o fundo que o cobre (`over` troca o fundo, para botões). */
function contrast(selector: string, over?: Element): number {
  const element = q(selector);
  const fg = parse(getComputedStyle(element).color);
  const bg = backgroundOf(over ?? element);
  const mixed = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
  const [a, b] = [luminance(mixed), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("Configurações em navegador real: duas colunas (1440×900, com a barra lateral de 296 px)", () => {
  it.each(SECTIONS)("seção %s: navegação à esquerda, coluna de leitura de até 760 px, sem rolagem horizontal", async (section) => {
    await open("admin", section, 1440 - 296);
    const nav = box(".settings-side");
    const pane = box(".settings-pane-inner");
    await expect.poll(() => Math.round(nav.width)).toBe(240);
    expect(pane.left).toBeGreaterThanOrEqual(nav.right);
    expect(pane.width).toBeLessThanOrEqual(760);
    expect(pane.width).toBeGreaterThan(600);
    // Lado a lado: o título da seção começa na altura do topo da página, não abaixo da navegação.
    expect(box(".settings-pane-title").top).toBeLessThan(nav.top + 80);
    noHorizontalScroll();
    if (CAPTURES) await shot(`admin-${section}`);
  });

  it.each(SECTIONS)("seção %s para um membro: o mesmo desenho, sem a marca admin", async (section) => {
    await open("member", section, 1440 - 296);
    expect(document.querySelector(".settings-nav-tag")).toBeNull();
    expect(box(".settings-pane-inner").width).toBeLessThanOrEqual(760);
    noHorizontalScroll();
    if (CAPTURES) await shot(`membro-${section}`);
  });

  it("cada ajuste é uma linha com o nome à esquerda e o controle à direita", async () => {
    await open("admin", "mcp", 1440 - 296);
    const row = document.querySelector(".settings-row")!;
    const text = row.querySelector(".settings-row-text")!.getBoundingClientRect();
    const control = row.querySelector(".settings-row-control")!.getBoundingClientRect();
    expect(text.right).toBeLessThanOrEqual(control.left);
    expect(Math.abs(text.top + text.height / 2 - (control.top + control.height / 2))).toBeLessThan(40);
    expect(row.getBoundingClientRect().right - control.right).toBeLessThan(40);
  });
});

describe("Configurações em navegador real: o que a coordenação pediu na revisão", () => {
  it("as chaves são interruptores (mesmo input, papel e rótulo), com a faixa da chave desenhada", async () => {
    await open("admin", "mcp", 1440 - 296);
    const toggle = q<HTMLInputElement>('input[role="switch"]');
    expect(toggle.type).toBe("checkbox");
    expect(getComputedStyle(toggle).appearance).toBe("none");
    expect(Math.round(toggle.getBoundingClientRect().width)).toBe(40);
    expect(getComputedStyle(toggle, "::before").content).not.toBe("none");
    expect(page.getByRole("switch", { name: "Permitir acesso por MCP" }).element()).toBe(toggle);
  });

  it("cada token é uma linha: nome, alcance e situação em cima; os dados em uma linha só; Revogar na mesma linha, à direita", async () => {
    await open("admin", "tokens", 1440 - 296);
    const item = q(".mcp-token");
    const head = item.querySelector(".mcp-token-head")!.getBoundingClientRect();
    const meta = item.querySelector(".mcp-token-meta")!.getBoundingClientRect();
    const revoke = item.querySelector("button")!.getBoundingClientRect();
    expect(item.querySelector(".mcp-token-scope")?.textContent).toBe("Leitura e escrita");
    expect(item.querySelector(".mcp-token-meta code")).not.toBeNull();
    expect(getComputedStyle(item.querySelector(".mcp-token-meta code")!).fontFamily).toMatch(/mono/i);
    // Os dados ficam abaixo do nome, em até duas linhas (as datas são por extenso).
    expect(meta.height).toBeLessThan(40);
    expect(meta.top).toBeGreaterThanOrEqual(head.bottom - 1);
    // O botão está à direita, na altura do bloco de nome e dados, não embaixo.
    const row = item.getBoundingClientRect();
    expect(revoke.left).toBeGreaterThan(head.left + 300);
    expect(row.right - revoke.right).toBeLessThan(40);
    expect(revoke.bottom).toBeLessThanOrEqual(row.bottom);
    expect(revoke.top).toBeLessThan(meta.top);
  });

  it("em tela estreita os dados do token quebram e o botão vai para baixo", async () => {
    await open("admin", "tokens", 390, 844);
    const item = q(".mcp-token");
    const meta = item.querySelector(".mcp-token-meta")!.getBoundingClientRect();
    const revoke = item.querySelector("button")!.getBoundingClientRect();
    expect(revoke.top).toBeGreaterThanOrEqual(meta.bottom - 1);
    noHorizontalScroll();
  });

  it("\"Clientes de IA\" cabe em uma linha na navegação lateral", async () => {
    await open("admin", "mcp", 1440 - 296);
    const link = [...document.querySelectorAll<HTMLElement>(".settings-nav a")].find((a) => a.textContent?.startsWith("Clientes de IA"))!;
    expect(link.getBoundingClientRect().height).toBeLessThanOrEqual(40);
    expect(link.textContent).not.toContain("(MCP)");
  });

  it("a linha divisória da navegação vai até o fim da página, mesmo com pouco conteúdo", async () => {
    await open("member", "idioma", 1440 - 296, 1100);
    const side = box(".settings-side");
    const screen = box(".settings-screen");
    expect(Math.abs(side.bottom - screen.bottom)).toBeLessThan(2);
    expect(side.height).toBeGreaterThan(1000);
  });

  it("a explicação de uma chave não encosta no interruptor", async () => {
    await open("admin", "mcp", 1440 - 296);
    for (const row of document.querySelectorAll(".settings-row")) {
      const hint = row.querySelector(".settings-row-hint");
      const control = row.querySelector(".settings-row-control");
      if (!hint || !control) continue;
      expect(control.getBoundingClientRect().left - hint.getBoundingClientRect().right).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("Configurações em navegador real: tela estreita", () => {
  // 900 px de largura útil é o limite: 1196 de janela menos a barra lateral de 296 px.
  it.each([900, 640, 390])("com %i px de largura útil a navegação vira uma faixa horizontal acima do conteúdo", async (width) => {
    await open("admin", "mcp", width);
    const links = [...document.querySelectorAll<HTMLElement>(".settings-nav a")].map((link) => link.getBoundingClientRect());
    expect(links.length).toBeGreaterThanOrEqual(5);
    // Todos os itens na mesma linha, acima do título da seção.
    for (const link of links) expect(Math.abs(link.top - links[0]!.top)).toBeLessThan(2);
    expect(links[0]!.bottom).toBeLessThanOrEqual(box(".settings-pane-title").top);
    noHorizontalScroll();
    for (const link of links) expect(link.height).toBeGreaterThanOrEqual(44);
    if (CAPTURES && width === 390) await shot(`estreita-mcp`);
  });

  it("passada a faixa, a seção aberta continua visível na navegação rolável", async () => {
    await open("admin", "mcp", 390);
    const nav = box(".settings-nav");
    // A aplicação rola a faixa até o item atual (o teste não rola nada).
    const current = q('.settings-nav a[aria-current="page"]');
    await expect.poll(() => current.getBoundingClientRect().right).toBeLessThanOrEqual(nav.right + 1);
    const rect = current.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(nav.left - 1);
    expect(q(".settings-nav").scrollLeft).toBeGreaterThan(0);
    expect(rect.right).toBeLessThanOrEqual(nav.right + 1);
  });

  it.each(SECTIONS)("seção %s em 390 px: sem rolagem horizontal da página", async (section) => {
    await open("admin", section, 390, 844);
    noHorizontalScroll();
  });
});

/** Geometria da bolinha (`::before`, posicionada em relação à borda de dentro do interruptor), em px a partir da borda de fora. */
function knob(sw: HTMLElement) {
  const style = getComputedStyle(sw, "::before");
  const border = sw.clientTop;
  const shift = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform).m41;
  const size = parseFloat(style.width);
  const left = border + parseFloat(style.left) + shift;
  const top = border + parseFloat(style.top);
  return { size, left, centerY: top + size / 2 };
}

describe("Configurações em navegador real: interruptores", () => {
  it.each([1440 - 296, 390])("com %i px de largura útil todo interruptor mede 40×22, com a bolinha de 16 px centrada", async (width) => {
    await open("admin", "mcp", width);
    const switches = [...document.querySelectorAll<HTMLInputElement>("input[role='switch']")];
    expect(switches.length).toBeGreaterThanOrEqual(2);
    for (const sw of switches) {
      await expect.poll(() => sw.getBoundingClientRect().width).toBeCloseTo(40, 0);
      await expect.poll(() => sw.getBoundingClientRect().height).toBeCloseTo(22, 0);
      const rect = sw.getBoundingClientRect();
      expect(Math.abs(rect.height - 22)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(rect.width - 40)).toBeLessThanOrEqual(0.5);
      expect(parseFloat(getComputedStyle(sw).borderTopLeftRadius)).toBeGreaterThanOrEqual(11);
      const ball = knob(sw);
      expect(ball.size).toBe(16);
      expect(Math.abs(ball.centerY - rect.height / 2)).toBeLessThan(1);
      // À esquerda quando desligado (3 px da borda), à direita quando ligado (3 px da outra borda).
      const expectedLeft = sw.checked ? rect.width - 3 - 16 : 3;
      expect(Math.abs(ball.left - expectedLeft)).toBeLessThan(1);
      // A área de toque (a linha) continua com 44 px ou mais, sem esticar o desenho.
      expect(sw.closest(".settings-row")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});

describe("Configurações em navegador real: contraste (WCAG AA, 4,5:1)", () => {
  it("os textos secundários, a navegação e a marca admin passam", async () => {
    await open("admin", "mcp", 1440 - 296);
    const checks: Record<string, number> = {
      lead: contrast(".settings-lead"),
      hint: contrast(".settings-row-hint"),
      groupLabel: contrast(".settings-nav-heading"),
      navLink: contrast(".settings-nav a:not([aria-current])"),
      navCurrent: contrast('.settings-nav a[aria-current="page"]'),
      navTag: contrast(".settings-nav a:not([aria-current]) .settings-nav-tag"),
      navTagCurrent: contrast('.settings-nav a[aria-current="page"] .settings-nav-tag'),
      cardNote: contrast(".settings-card-note"),
      rowTitle: contrast(".settings-row-title"),
      title: contrast(".settings-pane-title"),
    };
    for (const [name, ratio] of Object.entries(checks)) expect(ratio, name).toBeGreaterThanOrEqual(4.5);
  });

  it("o botão de perigo (revogar) e a explicação da confirmação passam", async () => {
    await open("admin", "tokens", 1440 - 296);
    const revoke = q<HTMLButtonElement>(".mcp-token button.destructive");
    expect(contrast(".mcp-token button.destructive", revoke)).toBeGreaterThanOrEqual(4.5);
    revoke.click();
    await settle(100);
    expect(contrast(".mcp-token .confirm-message")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(".mcp-token button.danger", q(".mcp-token button.danger"))).toBeGreaterThanOrEqual(4.5);
  });

  it("as ações de perigo ficam em uma linha própria, separada dos ajustes (IA e GitHub)", async () => {
    await open("admin", "github", 1440 - 296);
    const danger = q(".settings-danger-row");
    expect(getComputedStyle(danger).backgroundColor).not.toBe(getComputedStyle(q(".settings-card")).backgroundColor);
    expect(contrast(".settings-danger-row button.destructive", q(".settings-danger-row button.destructive"))).toBeGreaterThanOrEqual(4.5);
  });
});

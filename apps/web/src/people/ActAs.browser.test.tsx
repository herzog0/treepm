import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { mountConversations, people as harnessPeople, rowOf } from "../chat/conversationHarness.js";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { writeActAs } from "../api/actAs.js";
import { ChatShell } from "../chat/ChatShell.js";
import { ChatsProvider } from "../chat/ChatsContext.js";
import { settle } from "../layout/layoutMeasure.js";
import { TestSidebar } from "../layout/testSidebar.js";
import { SettingsScreen } from "../settings/SettingsScreen.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeMe, makePerson, makeProject, createFakeChat } from "../test/fakes.js";
import { ActAsProvider } from "./ActAs.js";

// ADR 0057: a faixa "entrar como" divide a altura com a aplicação; não cobre a barra lateral nem empurra o mapa para fora da tela.
// Capturas só com `VITE_TREEPM_CAPTURES=1` (PNGs em .vitest/cap, fora do Git).
const CAPTURES = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const shot = async (name: string) => { if (CAPTURES) await page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true }); };
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const rect = (selector: string) => q(selector).getBoundingClientRect();

async function mountShell() {
  const people = [makePerson("person-1", "Ana"), makePerson("p-bia", "Bia Nogueira", { isTest: true })];
  const chat = createFakeChat({ tickets: [], people });
  const client = makeClient({ me: makeMe({ assistant: true }), people, projects: [makeProject("p1", "ALFA", "Projeto Alfa")], chat });
  return await render(
    <div id="root" style={{ height: "100dvh" }}>
      <ActAsProvider>
        <ChatsProvider client={client} onShowTicket={() => {}}>
          <ChatShell sidebar={<TestSidebar />}>
            <main className="tenant-map" style={{ minWidth: 0 }}>mapa</main>
          </ChatShell>
        </ChatsProvider>
      </ActAsProvider>
    </div>,
  );
}

const luminance = (rgb: string): number => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number]; return (x + 0.05) / (y + 0.05); };

afterEach(async () => {
  document.body.replaceChildren();
  window.sessionStorage.clear();
  await page.viewport(1440, 900);
});

describe("faixa 'entrar como' no navegador", () => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    it(`${w}x${h}: a faixa fica no alto, não cobre a barra lateral nem empurra o mapa para fora`, async () => {
      await page.viewport(w, h);
      writeActAs({ id: "p-bia", displayName: "Bia Nogueira" });
      await mountShell();
      await settle();
      const banner = rect(".actas-banner");
      expect(banner.top).toBe(0);
      expect(banner.left).toBe(0);
      expect(banner.width).toBe(w);
      const shell = rect(".tenant-shell");
      expect(shell.top).toBeCloseTo(banner.bottom, 0);
      expect(shell.bottom).toBeLessThanOrEqual(h);
      const map = rect(".tenant-map");
      expect(map.right).toBeLessThanOrEqual(w);
      expect(map.top).toBeGreaterThanOrEqual(banner.bottom - 1);
      if (w > 720) {
        const side = rect(".sidebar");
        expect(side.top).toBeGreaterThanOrEqual(banner.bottom - 1);
        expect(side.bottom).toBeLessThanOrEqual(h);
        expect(side.width).toBe(296);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(w);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(h);
      const style = getComputedStyle(q(".actas-banner"));
      expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      const button = rect(".actas-banner button");
      expect(button.height).toBeGreaterThanOrEqual(32);
      await shot(`faixa-${w}`);
    });
  }

  it("sem o modo, não existe faixa nem moldura: o layout é o de sempre", async () => {
    await mountShell();
    await settle();
    expect(document.querySelector(".actas-banner")).toBeNull();
    expect(document.querySelector(".actas-frame")).toBeNull();
    expect(rect(".tenant-shell").top).toBe(0);
  });
});

describe.skipIf(!CAPTURES)("capturas", () => {
  it("seção Pessoas das Configurações", async () => {
    await page.viewport(1440, 900);
    window.location.hash = "#pessoas";
    const people = [makePerson("person-1", "Ana Admin", { clerkRole: "admin" }), makePerson("p-alice", "Alice Lima"), makePerson("p-rafa", "Rafael Moura", { active: false }), makePerson("p-bia", "Bia Nogueira", { isTest: true }), makePerson("p-caio", "Caio Prado", { isTest: true })];
    const me = makeMe({ clerk: "admin" });
    const client = makeClient({ me, people });
    await render(
      <div id="root" style={{ height: "100dvh", overflow: "auto" }}>
        <MemoryPreferencesProvider onSave={() => undefined}>
          <ActAsProvider><SettingsScreen client={client} me={me} /></ActAsProvider>
        </MemoryPreferencesProvider>
      </div>,
    );
    await settle(900);
    await shot("secao-pessoas");
  });

  it("seletor de menção com o selo 'teste'", async () => {
    await page.viewport(1440, 900);
    const bia = harnessPeople.find((person) => person.id === "person-2")!;
    bia.isTest = true;
    try {
      await mountConversations({ seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]) });
      await settle(900);
      rowOf(/Meu chat/).click();
      await settle(900);
      await userEvent.type(page.getByRole("combobox", { name: "Mensagem" }), "Bia, olha isto @");
      await settle(600);
      expect(document.body.textContent).toContain("teste");
      await shot("seletor-de-mencao-com-selo");
    } finally {
      delete bia.isTest;
    }
  });
});

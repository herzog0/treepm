import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { settle } from "../layout/layoutMeasure.js";
import { TestSidebar } from "../layout/testSidebar.js";
import { makeClient, makeMe, makePerson, makeProject, createFakeChat } from "../test/fakes.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

// ADR 0049 e ADR 0055: a barra lateral e a conversa aberta no navegador real. Roda no Chromium do contêiner (TREEPM_PLAYWRIGHT_WS).
const WIDE = [1440, 900] as const;
const NARROW = [[360, 740], [390, 844], [430, 932]] as const;
const TOUCH = 44;

async function mount() {
  const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia")];
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true }], people });
  chat.seedConversation("t1", Array.from({ length: 12 }, (_, index) => ({ person: `pergunta ${index + 1}`, assistant: `resposta ${index + 1}` })));
  const client = makeClient({ me: makeMe({ assistant: true }), people, projects: [makeProject("p1", "ALFA", "Projeto Alfa")], chat });
  return await render(
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <ChatShell sidebar={<TestSidebar />}>
          <main id="stand-in-map" className="tenant-map" style={{ minWidth: 0 }}>mapa</main>
        </ChatShell>
      </ChatsProvider>
    </div>,
  );
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const rowOf = (key: string) => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].find((row) => (row.textContent ?? "").includes(key))!;
const rect = (selector: string) => q(selector)!.getBoundingClientRect();
/** No celular a lista está dentro da gaveta: abre a gaveta antes de escolher a conversa. */
async function openChat() {
  if (window.innerWidth <= 720) await page.getByRole("button", { name: /^Abrir o menu/ }).click();
  await page.getByRole("button", { name: /ALFA-1/ }).click();
  await settle();
}

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(...WIDE);
});

describe("barra lateral e conversa, tela larga", () => {
  it("a barra tem 296 px, fica fixa à esquerda e a lista de conversas já está à vista", async () => {
    await page.viewport(...WIDE);
    await mount();
    await settle();
    const bar = rect(".sidebar");
    expect(bar.left).toBe(0);
    expect(bar.width).toBe(296);
    expect(bar.height).toBe(900);
    expect(rect(".conv-row").width).toBeGreaterThan(200);
    expect(q(".chat-panel")).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("a conversa abre numa coluna de 440 px entre a barra e o mapa, e o mapa encolhe em vez de ficar coberto", async () => {
    await page.viewport(...WIDE);
    await mount();
    await settle();
    const before = rect("#stand-in-map");
    expect(before.left).toBe(296);
    await openChat();
    const panel = rect(".chat-panel");
    expect(panel.left).toBe(296);
    expect(panel.width).toBe(440);
    expect(panel.height).toBe(900);
    const map = rect("#stand-in-map");
    expect(map.left).toBeGreaterThanOrEqual(panel.right - 1);
    expect(map.width).toBeCloseTo(before.width - panel.width, 0);
    expect(rect(".sidebar").width).toBe(296);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("fechar a conversa devolve a largura ao mapa e o foco à linha dela", async () => {
    await page.viewport(...WIDE);
    await mount();
    await settle();
    const before = rect("#stand-in-map").width;
    await openChat();
    expect(q(".chat-panel")!.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await settle();
    expect(getComputedStyle(q(".chat-panel")!).display).toBe("none");
    expect(rect("#stand-in-map").width).toBe(before);
    expect(document.activeElement).toBe(rowOf("ALFA-1"));
  });

  it("a linha da conversa aberta fica marcada na barra", async () => {
    await page.viewport(...WIDE);
    await mount();
    await settle();
    await openChat();
    expect(rowOf("ALFA-1").getAttribute("aria-current")).toBe("true");
  });
});

describe.each(NARROW)("conversa no celular %ix%i", (width, height) => {
  it("ocupa a tela inteira, sem rolagem lateral e com alvos de 44 px", async () => {
    await page.viewport(width, height);
    await mount();
    await openChat();
    const panel = rect(".chat-panel");
    expect(Math.round(panel.width)).toBe(width);
    expect(Math.round(panel.height)).toBe(height);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const selector of [".chat-header .chat-icon-button", ".chat-header .ticket-icon-button", ".chat-trail button", ".chat-thread-footer", ".chat-send"]) {
      for (const element of document.querySelectorAll(`.chat-panel ${selector}`)) {
        const box = element.getBoundingClientRect();
        expect(box.height, selector).toBeGreaterThanOrEqual(TOUCH - 1);
        expect(box.width, selector).toBeGreaterThanOrEqual(TOUCH - 1);
      }
    }
  });

  it("mantém o campo de escrever preso à base da área visível", async () => {
    await page.viewport(width, height);
    await mount();
    await openChat();
    const composer = rect(".chat-composer");
    expect(Math.round(composer.bottom)).toBeLessThanOrEqual(height);
    expect(height - composer.bottom).toBeLessThan(40);
    // O teclado virtual encolhe a altura visível (interactive-widget=resizes-content): o campo continua à vista.
    await page.viewport(width, Math.round(height / 2));
    await settle();
    expect(rect(".chat-composer").bottom).toBeLessThanOrEqual(Math.round(height / 2));
  });
});

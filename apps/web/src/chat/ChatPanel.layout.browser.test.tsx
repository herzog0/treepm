import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { settle } from "../layout/layoutMeasure.js";
import { TenantHeader } from "../nav/TenantHeader.js";
import { makeClient, makeMe, makePerson, makeProject, createFakeChat } from "../test/fakes.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

// ADR 0049: o painel de chats no navegador real. ESCRITO, NÃO RODADO (a suíte de navegador desta máquina está fora do ar): a coordenação roda.
const WIDE = [1440, 900] as const;
const NARROW = [[360, 740], [390, 844], [430, 932]] as const;
const TOUCH = 44;

function mount() {
  const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia")];
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true }], people });
  chat.seedConversation("t1", Array.from({ length: 12 }, (_, index) => ({ person: `pergunta ${index + 1}`, assistant: `resposta ${index + 1}` })));
  const client = makeClient({ me: makeMe({ assistant: true }), people, projects: [makeProject("p1", "ALFA", "Projeto Alfa")], chat });
  return render(
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <ChatShell header={<TenantHeader view="map" onNavigate={() => {}}><span /></TenantHeader>}>
          <main id="stand-in-map" className="tenant-map" style={{ minWidth: 0 }}>mapa</main>
        </ChatShell>
      </ChatsProvider>
    </div>,
  );
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const rect = (selector: string) => q(selector)!.getBoundingClientRect();
async function openChat() {
  await page.getByRole("button", { name: /^Chats/ }).click();
  await page.getByRole("button", { name: /ALFA-1/ }).click();
  await settle();
}

afterEach(() => document.getElementById("root")?.remove());

describe("chats panel, wide screen", () => {
  it("splits the space with the map at 1440: the panel is fixed and the map shrinks instead of being covered", async () => {
    await page.viewport(...WIDE);
    mount();
    const before = rect("#stand-in-map").width;
    await page.getByRole("button", { name: /^Chats/ }).click();
    await settle();
    const panel = rect(".chat-panel");
    expect(panel.width).toBeGreaterThanOrEqual(360);
    expect(panel.width).toBeLessThanOrEqual(400);
    expect(panel.left).toBe(0);
    const map = rect("#stand-in-map");
    expect(map.left).toBeGreaterThanOrEqual(panel.right - 1);
    expect(map.width).toBeCloseTo(before - panel.width, 0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("moves the focus into the panel when it opens and back to the button when Esc closes it", async () => {
    await page.viewport(...WIDE);
    mount();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await settle();
    expect(q(".chat-panel")!.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await settle();
    expect(getComputedStyle(q(".chat-panel")!).display).toBe("none");
    expect(document.activeElement).toBe(q(".tenant-chats"));
  });
});

describe.each(NARROW)("chats panel at %ix%i", (width, height) => {
  it("takes the whole screen, has no sideways scroll and 44 px targets", async () => {
    await page.viewport(width, height);
    mount();
    await openChat();
    const panel = rect(".chat-panel");
    expect(Math.round(panel.width)).toBe(width);
    expect(Math.round(panel.height)).toBe(height);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    for (const selector of [".chat-header .chat-icon-button", ".chat-tabs button", ".chat-mention-button", ".chat-send"]) {
      for (const element of document.querySelectorAll(`.chat-panel ${selector}`)) {
        const box = element.getBoundingClientRect();
        expect(box.height, selector).toBeGreaterThanOrEqual(TOUCH - 1);
        expect(box.width, selector).toBeGreaterThanOrEqual(TOUCH - 1);
      }
    }
  });

  it("keeps the composer stuck to the bottom of the visible area", async () => {
    await page.viewport(width, height);
    mount();
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

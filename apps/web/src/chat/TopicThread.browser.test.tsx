import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { settle } from "../layout/layoutMeasure.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe } from "../panel/testing.js";
import { TestSidebar } from "../layout/testSidebar.js";
import { createFakeChat } from "../test/chatFakes.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import { mountConversations, rows } from "./conversationHarness.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

// ADR 0056, fatia 2: a thread de assunto desenhada de verdade (Chromium do contêiner, TREEPM_PLAYWRIGHT_WS). Capturas só com VITE_TREEPM_CAPTURES (a pasta).
const dir = import.meta.env["VITE_TREEPM_CAPTURES"] as string | undefined;
const shot = async (name: string) => {
  if (dir) await page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true });
};
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const poll = <T,>(read: () => T) => expect.poll(read, { timeout: 5000, interval: 100 });
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
const rgba = (css: string): number[] => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
};
const backdrop = (el: Element): number[] => {
  let color = [8, 9, 13];
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
  for (const node of chain.reverse()) {
    const c = rgba(getComputedStyle(node).backgroundColor);
    const a = c[3]! / 255;
    color = [0, 1, 2].map((i) => c[i]! * a + color[i]! * (1 - a));
  }
  return color;
};
const contrastOf = (el: Element) => {
  const bg = backdrop(el);
  const fg = rgba(getComputedStyle(el).color);
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1440, 900);
});

const LONG = "Dividir a migração do banco em etapas pequenas";
const seed = (chat: ReturnType<typeof createFakeChat>) => {
  const general = chat.seedGeneral([{ person: "O que tenho para hoje?", assistant: "Você é responsável pelo ALFA-1." }]);
  chat.seedTopic(general, { body: "Como divido a migração do banco?", reply: "Em três passos: dados, código e corte.", title: LONG });
  chat.seedTopic(general, { body: "Quais tickets estão bloqueados no login?", reply: "Três, todos esperando o ALFA-2.", title: null });
};

describe("a thread de assunto no navegador", () => {
  it("a linha ✦ na barra de 296 px mostra o título em mais de 60% da linha, com contraste, sob o Meu chat", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed });
    await poll(() => rows().length >= 3).toBe(true);
    const topics = rows().filter((row) => row.querySelector(".conv-topic-mark"));
    expect(topics).toHaveLength(2);
    const sidebarWidth = q(".sidebar")!.getBoundingClientRect().width;
    expect(sidebarWidth).toBeLessThanOrEqual(296);
    const titled = topics.find((row) => row.textContent?.includes(LONG))!;
    const title = titled.querySelector<HTMLElement>(".conv-title")!;
    // O título não é cortado em menos de 60% da largura da linha.
    await poll(() => title.getBoundingClientRect().width / titled.getBoundingClientRect().width).toBeGreaterThanOrEqual(0.6);
    for (const row of topics) {
      expect(contrastOf(row.querySelector(".conv-topic-mark")!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(row.querySelector(".conv-title")!)).toBeGreaterThanOrEqual(4.5);
    }
    // O marcador ✦ não invade o texto (a coluna da marca tem 10 px; o glifo fica na linha).
    const mark = titled.querySelector<HTMLElement>(".conv-topic-mark")!.getBoundingClientRect();
    expect(mark.right).toBeLessThanOrEqual(title.getBoundingClientRect().left + 1);
    await shot("04-barra-lateral-duas-threads-de-assunto");
  });

  it("o painel abre na thread de assunto com trilha, título e 'Só você e o assistente'; o cartão ✦ aparece na conversa de cima", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed });
    await poll(() => rows().length >= 3).toBe(true);
    rows()[0]!.click();
    await poll(() => q(".chat-panel .chat-thread-footer.is-topic") !== null).toBe(true);
    await settle(500);
    const card = q(".chat-panel .chat-thread-footer.is-topic")!;
    expect(card.textContent).toContain(LONG);
    expect(card.querySelector(".chat-avatars")).toBeNull();
    expect(contrastOf(card.querySelector(".chat-thread-name")!)).toBeGreaterThanOrEqual(4.5);
    await shot("05-cartao-do-assunto-na-conversa-de-cima");
    card.click();
    await poll(() => q(".chat-panel .chat-trail [aria-current=page]")?.textContent).toBe(LONG);
    await settle(400);
    expect(q(".chat-panel")!.textContent).not.toContain("Incluir pessoas");
    expect(q(".chat-panel .chat-notice")?.textContent).toBe("Só você e o assistente");
    await shot("03-thread-de-assunto-aberta");
  });

  it("a barra de pedidos manda o texto ao Meu chat: a coluna abre na thread nova e a barra fecha", async () => {
    await page.viewport(1440, 900);
    const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Acesso e conta", projectId: "p1" }], people: [], topicTitle: () => "Migração do banco" });
    const client = makeClient({ projects: [makeProject("p1", "ALFA", "Projeto Alfa")], tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1" })] }, people: [], chat });
    const me = { ...makePanelMe("admin"), assistant: { enabled: true } };
    await render(
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <ChatShell sidebar={<TestSidebar />}>
          <main className="tenant-map" style={{ minWidth: 0 }}>
            <OrganizationMap client={client} me={me} openTicketId={null} onOpenTicketChange={() => undefined} />
          </main>
        </ChatShell>
      </ChatsProvider>,
    );
    await page.getByRole("combobox", { name: "Peça qualquer coisa" }).click();
    await userEvent.keyboard("como divido a migração do banco");
    await settle(300);
    await shot("01-barra-de-pedidos-com-o-texto");
    await userEvent.keyboard("{Enter}");
    await poll(() => q(".chat-panel .chat-trail [aria-current=page]")?.textContent).toBe("Migração do banco");
    await poll(() => q(".command-sheet")).toBeNull();
    await settle(500);
    await shot("02-thread-aberta-pela-barra");
  });
});

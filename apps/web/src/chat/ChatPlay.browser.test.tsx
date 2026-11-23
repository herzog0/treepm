import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { chatTicketTarget } from "../nav/navigation.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { TenantHeader } from "../nav/TenantHeader.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { createFakeChat, makeMe, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

// ADR 0049 × ADR 0048, em navegador real: o painel de chats, a página do ticket e o modo play ligados ao mesmo tempo.
// Em 1440 os três ficam alcançáveis (o painel à esquerda, a página à direita, a barra do play dentro da página).
// Em 390 o painel cobre a tela inteira e o play continua do mesmo ponto depois que ele fecha.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const TICKETS = [
  makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1", status: "in_progress", assigneeIds: ["person-1"] }),
  makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2", assigneeIds: ["person-1"], priority: 4 }),
  makeTicket("t3", "p1", 3, "Relatórios", { key: "ALFA-3", status: "in_progress", assigneeIds: ["person-2"] }),
];
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")];
const panelMe = makePanelMe("admin");

function Host() {
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [api] = useState(() => {
    const chat = createFakeChat({ tickets: TICKETS.map((ticket) => ({ id: ticket.id, key: ticket.key, title: ticket.title, projectId: "p1", assignedToMe: true })), people });
    return makeTreeClient({ projects: [project], tickets: { p1: TICKETS.map((ticket) => ({ ...ticket })) }, people, me: makeMe({ assistant: true }), chat });
  });
  return (
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={api} onShowTicket={(id) => { const target = chatTicketTarget(open, id); setOpen(target.ticketId ?? null); setFocus(target.focusId ?? null); }}>
        <ChatShell header={<TenantHeader view="map" onNavigate={() => {}}><span /></TenantHeader>}>
          <main className="tenant-map">
            <OrganizationMap client={api} me={panelMe} openTicketId={open} onOpenTicketChange={setOpen} focusTicketId={focus} onFocusHandled={() => setFocus(null)} />
          </main>
        </ChatShell>
      </ChatsProvider>
    </div>
  );
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const byLabel = (label: string) => q<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const size = (el: Element) => el.getBoundingClientRect();
const noSideScroll = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
/** O elemento que de fato recebe o toque no centro de `el`. */
const hitAt = (el: Element) => {
  const r = size(el);
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
};
const reachable = (el: Element, label: string) => expect(el.contains(hitAt(el)), `${label} coberto por ${hitAt(el)?.className}`).toBe(true);

async function startPlay() {
  byLabel("Modo play").click();
  await settle(200);
  [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((el) => el.textContent?.includes("Meu trabalho"))!.click();
  await settle(2500);
}
const openPanel = async () => {
  [...document.querySelectorAll<HTMLButtonElement>("button.tenant-chats")][0]!.click();
  await settle(600);
};
const playStep = () => q(".play-bar [role=status]")?.textContent ?? "";

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1440, 900);
});

describe("painel de chats, página do ticket e play juntos em 1440", () => {
  it("o painel fica à esquerda, a página à direita e a barra do play dentro da página, todos alcançáveis", async () => {
    await page.viewport(1440, 900);
    await render(<Host />);
    await settle(1200);
    await startPlay();
    const step = playStep();
    expect(step).not.toBe("");
    await openPanel();
    const panel = q(".chat-panel")!;
    const ticketPage = q("[aria-label='Página do ticket']")!;
    expect(panel).not.toBeNull();
    expect(ticketPage).not.toBeNull();
    const p = size(panel);
    expect(p.left).toBe(0);
    expect(p.width).toBeGreaterThanOrEqual(360);
    expect(p.width).toBeLessThanOrEqual(400);
    // A página e a barra do play ficam inteiras à direita do painel, dentro da janela.
    const t = size(ticketPage);
    expect(t.left).toBeGreaterThanOrEqual(p.right - 1);
    expect(t.right).toBeLessThanOrEqual(window.innerWidth + 1);
    const bar = size(q(".play-bar")!);
    expect(bar.left).toBeGreaterThanOrEqual(p.right - 1);
    expect(bar.right).toBeLessThanOrEqual(window.innerWidth + 1);
    for (const label of ["Voltar", "Avançar", "Sair do play"]) reachable(byLabel(label), label);
    reachable(panel.querySelector("h2, .chat-header-title, button")!, "painel");
    reachable(q("button.tenant-chats")!, "botão Chats");
    // Mexer no play com o painel aberto continua funcionando e não fecha o painel.
    byLabel("Avançar").click();
    await settle(1500);
    expect(playStep()).not.toBe(step);
    expect(size(q(".chat-panel")!).width).toBe(p.width);
    noSideScroll();
  });
});

describe.each([[390, 844]] as const)("painel de chats com o play ligado em %ix%i", (width, height) => {
  beforeAll(async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  });
  afterAll(async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
  });

  it("o painel cobre a tela inteira e o play continua do mesmo ponto quando ele fecha", async () => {
    await page.viewport(width, height);
    await render(<Host />);
    await settle(1200);
    await startPlay();
    const step = playStep();
    await openPanel();
    const panel = q(".chat-panel")!;
    expect(Math.round(size(panel).width)).toBe(width);
    expect(Math.round(size(panel).height)).toBe(height);
    // Nada do play ou da página atravessa o painel: o toque no centro e na base cai nele.
    for (const [x, y] of [[width / 2, height / 2], [width / 2, height - 8], [width / 2, 100]] as const) {
      expect(panel.contains(document.elementFromPoint(x, y)), `ponto ${x},${y}`).toBe(true);
    }
    noSideScroll();
    byLabel("Fechar o painel de chats").click();
    await settle(500);
    expect(getComputedStyle(q(".chat-panel")!).display).toBe("none");
    expect(playStep()).toBe(step);
    for (const label of ["Voltar", "Avançar", "Sair do play"]) reachable(byLabel(label), label);
    noSideScroll();
  });
});

describe("cabeçalho do chat com a página do ticket já aberta (ajuste 3, ADR 0049)", () => {
  it("leva a câmera de volta ao ticket mesmo com a página já aberta nele", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Host />);
    await settle(1200);
    await openPanel();
    const spot = () => {
      const stage = document.querySelector("[aria-label='Mapa da organização']")!.getBoundingClientRect();
      const card = q("[aria-label^='ALFA-2 · ']")!.getBoundingClientRect();
      return { x: Math.round(card.left - stage.left), y: Math.round(card.top - stage.top) };
    };
    await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
    await screen.getByRole("button", { name: "Explorar ramo" }).click();
    await settle();
    await screen.getByRole("button", { name: /ALFA-2 · Publicação/ }).click();
    await expect.element(screen.getByRole("heading", { level: 1, name: "Publicação" })).toBeVisible();
    await settle();
    const framed = spot();
    const stage = screen.getByRole("region", { name: "Mapa da organização" });
    await userEvent.dragAndDrop(stage, stage, { sourcePosition: { x: 40, y: 400 }, targetPosition: { x: 140, y: 330 } });
    await settle();
    expect(spot()).not.toEqual(framed);
    // O chat do ALFA-2 pelo painel; o cabeçalho dele leva a câmera ao ticket cuja página já está aberta.
    [...q(".chat-panel")!.querySelectorAll<HTMLButtonElement>("button")].find((b) => /ALFA-2/.test(b.textContent ?? ""))!.click();
    await settle(600);
    q<HTMLButtonElement>(".chat-panel .chat-ticket-title")!.click();
    await settle(1200);
    expect(spot()).toEqual(framed);
    expect(q("[aria-label='Página do ticket']")).not.toBeNull();
  });
});

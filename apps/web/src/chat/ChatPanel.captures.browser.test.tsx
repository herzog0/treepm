import { useState } from "react";
import { afterEach, describe, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ApiClient } from "../api/client.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { chatTicketTarget } from "../nav/navigation.js";
import { TestSidebar } from "../layout/testSidebar.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { createFakeChat, makeMe, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import type { FakeChat } from "../test/chatFakes.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

// Capturas da conferência visual do chat por ticket (ADR 0049): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em .vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const DIR = "../../.vitest/cap";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}.png`, save: true });
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
const TICKETS = [
  makeTicket("t1", "p1", 1, "Corrigir o login quando a sessão expira no meio do formulário", { key: "ALFA-1", status: "in_progress", assigneeIds: ["person-1"] }),
  makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2", assigneeIds: ["person-1"], priority: 4 }),
  makeTicket("t3", "p1", 3, "Relatórios", { key: "ALFA-3", assigneeIds: ["person-2"] }),
];
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia Nogueira"), makePerson("person-3", "Caio")];
const panelMe = makePanelMe("admin");
const MARKDOWN = "## Plano\n\nPara corrigir o login:\n\n1. Renovar o token **antes** de enviar o formulário\n2. Guardar o rascunho em `sessionStorage`\n3. Testar com a sessão vencida\n\n> O assistente só lê o ticket; nada foi alterado.\n\nMais em [a documentação](https://example.com/docs).";

interface Setup {
  chatTickets?: number;
  assistant?: "ready" | "no_consent" | "not_configured";
  prepare?: (chat: FakeChat, client: ApiClient) => void;
  me?: ReturnType<typeof makeMe>;
}
let current: { client: ApiClient; chat: FakeChat } | null = null;
function Host({ setup }: { setup: Setup }) {
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [api] = useState(() => {
    const chat = createFakeChat({
      tickets: TICKETS.slice(0, setup.chatTickets ?? 3).map((ticket) => ({ id: ticket.id, key: ticket.key, title: ticket.title, projectId: "p1", assignedToMe: ticket.id !== "t3" })),
      people,
      assistant: setup.assistant ?? "ready",
      reply: () => MARKDOWN,
    });
    const client = makeTreeClient({ projects: [project], tickets: { p1: TICKETS.map((ticket) => ({ ...ticket })) }, people, me: setup.me ?? makeMe({ assistant: true, consent: setup.assistant !== "no_consent" }), chat });
    setup.prepare?.(chat, client);
    current = { client, chat };
    return client;
  });
  return (
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={api} onShowTicket={(id) => { const target = chatTicketTarget(open, id); setOpen(target.ticketId ?? null); setFocus(target.focusId ?? null); }}>
        <ChatShell sidebar={<TestSidebar />}>
          <main className="tenant-map">
            <OrganizationMap client={api} me={panelMe} openTicketId={open} onOpenTicketChange={setOpen} focusTicketId={focus} onFocusHandled={() => setFocus(null)} />
          </main>
        </ChatShell>
      </ChatsProvider>
    </div>
  );
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const inPanel = (text: RegExp | string) => [...document.querySelectorAll<HTMLElement>(".chat-panel button, .chat-panel [role=tab], .chat-panel [role=menuitem]")].find((el) => (typeof text === "string" ? (el.textContent ?? "").includes(text) || el.getAttribute("aria-label") === text : text.test(`${el.textContent} ${el.getAttribute("aria-label") ?? ""}`)))!;
/** A lista "Conversas" está sempre na barra lateral; no celular ela fica na gaveta, que o passo "abrir" abre. */
const openPanel = async () => { if (window.innerWidth <= 720) { q<HTMLButtonElement>(".tenant-menu-button")!.click(); await settle(); } };
const openChat = async (key: string) => { [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].find((row) => new RegExp(key).test(row.textContent ?? ""))!.click(); await settle(); };
const type = async (text: string) => { await page.getByRole("textbox", { name: "Mensagem" }).fill(text); await settle(200); };

describe.skipIf(!ON)("capturas do chat por ticket", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.viewport(1440, 900);
  });
  for (const [tag, width, height] of [["1440", 1440, 900], ["390", 390, 844]] as const) {
    const prepare = async (setup: Setup = {}) => {
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: width < 721, maxTouchPoints: 5 });
      await page.viewport(width, height);
      await render(<Host setup={setup} />);
      await settle(1200);
    };
    it(`lista com não lidas, vazia e sem aceite em ${tag}`, async () => {
      await prepare({
        prepare: (chat) => {
          chat.receiveThread("t2", { from: "person-2", body: "Ana, olha o ALFA-2 antes de publicar?" });
          chat.receiveThread("t3", { from: "person-3", body: "Sobre relatórios", replies: [{ from: "person-3", body: "mais uma" }] });
          chat.seedConversation("t1", [{ person: "Como corrijo?", assistant: "Renove o token." }]);
          chat.readAll("t1");
        },
      });
      await openPanel();
      await shot(`${tag}-01-lista-com-nao-lidas`);
      document.body.replaceChildren();
      await prepare({ chatTickets: 0 });
      await openPanel();
      await shot(`${tag}-02-lista-vazia`);
    });
    it(`conversa com markdown e mensagem não respondida em ${tag}`, async () => {
      await prepare({ prepare: (chat) => { chat.seedConversation("t1", [{ person: "Como corrijo o login?", assistant: MARKDOWN }]); chat.readAll("t1"); } });
      await openPanel();
      await openChat("ALFA-1");
      await shot(`${tag}-03-conversa-com-markdown`);
      const real = vi.mocked(current!.client.sendChatMessage).getMockImplementation()!;
      vi.mocked(current!.client.sendChatMessage).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable", code: "assistant_unavailable" } });
      await type("E se o provedor estiver fora?");
      q<HTMLButtonElement>(".chat-send")!.click();
      await settle(900);
      await shot(`${tag}-04-nao-respondida`);
      vi.mocked(current!.client.sendChatMessage).mockImplementation(real);
    });
    it(`seletor de menção, pastilhas e thread em ${tag}`, async () => {
      await prepare({
        prepare: (chat) => {
          chat.seedConversation("t1", [{ person: "Como corrijo?", assistant: "Renove o token." }]);
          chat.receiveThread("t1", { from: "person-2", body: "Ana, o token expira em 15 min?", replies: [{ from: "person-3", body: "Confirmei: 15 min." }, { from: "person-2", body: "Então o rascunho precisa sobreviver." }] });
          chat.readAll("t1");
        },
      });
      await openPanel();
      await openChat("ALFA-1");
      inPanel("Mencionar").click();
      await settle();
      await shot(`${tag}-05-seletor-de-mencao`);
      [...document.querySelectorAll<HTMLElement>("[role=dialog] button")].find((el) => /Bia/.test(el.textContent ?? ""))!.click();
      await settle(300);
      await type("Bia, consegue revisar a correção até amanhã?");
      await shot(`${tag}-06-pastilha-e-abrir-thread`);
      inPanel("Abrir thread (não vai ao assistente)").click();
      await settle(900);
      await shot(`${tag}-07-cartoes-de-thread`);
      document.querySelector<HTMLButtonElement>(".chat-panel .chat-thread-open, .chat-panel button")!;
      [...document.querySelectorAll<HTMLButtonElement>(".chat-panel button")].find((el) => el.textContent === "Abrir thread")!.click();
      await settle(900);
      await shot(`${tag}-08-thread-aberta`);
    });
    it(`aba Menções e sem aceite da organização em ${tag}`, async () => {
      await prepare({ prepare: (chat) => { chat.receiveThread("t3", { from: "person-3", body: "Ana, preciso de você nos relatórios", replies: [] }); } });
      await openPanel();
      await openChat("ALFA-3");
      await shot(`${tag}-09-aba-mencoes`);
      document.body.replaceChildren();
      await prepare({ assistant: "no_consent" });
      await openPanel();
      await openChat("ALFA-1");
      await shot(`${tag}-10-sem-aceite`);
      q<HTMLButtonElement>(".chat-panel .chat-header .ticket-icon-button")!.click();
      await settle(300);
      await shot(`${tag}-12-opcoes-do-chat`);
    });
    it(`painel e página do ticket juntos em ${tag}`, async () => {
      await prepare({ prepare: (chat) => { chat.seedConversation("t2", [{ person: "Isso já pode ir?", assistant: "Falta a revisão." }]); chat.readAll("t2"); } });
      await openPanel();
      await openChat("ALFA-2");
      q<HTMLButtonElement>(".chat-panel .chat-ticket-title")!.click();
      await settle(1500);
      await shot(`${tag}-11-painel-e-pagina`);
    });
  }
});

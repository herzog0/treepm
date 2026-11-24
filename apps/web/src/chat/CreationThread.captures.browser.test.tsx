import { useEffect } from "react";
import { afterAll, describe, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { settle } from "../layout/layoutMeasure.js";
import { TestSidebar } from "../layout/testSidebar.js";
import { makeClient, makeConversation, makeMe, makePerson, makePlacement, makeProject, makeTicket, createFakeChat, ok } from "../test/fakes.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider, useChats } from "./ChatsContext.js";

// Capturas da conferência visual da thread de criação (ADR 0056, fatia 3): só rodam com `VITE_TREEPM_CAPTURES_DIR=1`; os PNGs saem em .vitest/cap
// (fora do Git) e quem roda os move para fora do repositório.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/f3-${name}.png`, save: true });
const draft = { title: "Corrigir o login quando a sessão expira no meio do formulário de cadastro", description: "O login falha no Safari depois de o token expirar.", children: [], idea: false };
const which = makePlacement({
  question: { level: 1, kind: "which", at: { id: null, title: "Projeto Alfa", path: [] }, options: [{ id: "t1", title: "Corrigir o login", path: [{ id: "t1", title: "Corrigir o login" }] }, { id: "t2", title: "Publicar a versão", path: [{ id: "t2", title: "Publicar a versão" }] }] },
  destinationConfirmed: false,
  uncertain: true,
  destination: { parentId: "t1", path: [{ id: "t1", title: "Corrigir o login" }] },
});
const rowWith = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].find((row) => (row.textContent ?? "").includes(text))!;

/** A barra lateral com o "Novo ticket" ligado como a aplicação o liga, e o mapa emprestando à thread o que ela usa dele. */
function WiredSidebar() {
  const chats = useChats()!;
  const { setMapHost } = chats;
  useEffect(() => {
    setMapHost({ projectId: () => null, creatable: [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")], scopeTicketId: () => null, registerPicker: () => {}, onDraftChange: () => {}, onChanged: () => {}, onManualCreate: () => {} });
    return () => setMapHost(null);
  }, [setMapHost]);
  return <TestSidebar onNewTicket={chats.startNewTicket} />;
}

async function mount(options: { several?: boolean } = {}) {
  const people = [makePerson("person-1", "Ana")];
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true }], people });
  chat.seedGeneral([]);
  if (options.several) chat.options.creatable = { p1: "ALFA", p2: "BETA" };
  const client = makeClient({ me: makeMe({ assistant: true }), people, projects: [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")], tickets: { p1: [makeTicket("t1", "p1", 1, "Corrigir o login", { status: "in_progress" }), makeTicket("t2", "p1", 2, "Publicar a versão")] }, chat });
  Object.assign(client, {
    createTicketFromConversation: vi.fn(async (id: string) => {
      // Como o servidor: a conversa vira o ticket e a thread passa a "criado".
      const thread = id.replace(/^tc-/, "");
      chat.setCreation(thread, { state: "created", ticketConversationId: null, ticket: { id: "t9", key: "ALFA-9", title: "Corrigir o login" } });
      return ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] });
    }),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { draft }))),
    // A primeira procura tem dúvida (e a thread passa a "sua vez", como no servidor); a resposta da pessoa acha o lugar.
    findPlacement: vi.fn(async (id: string, _scope?: string, branch?: string) => {
      if (branch !== undefined) return ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Corrigir o login" }] } }));
      chat.setCreation(id.replace(/^tc-/, ""), { state: "waiting" });
      return ok(which);
    }),
  });
  const ids: string[] = [];
  if (!options.several) {
    for (const text of [draft.title, "Cobrar o relatório mensal"]) {
      const sent = await client.sendChatMessage(chat.generalOf()!, { body: text, creation: true });
      if (sent.ok && sent.data.kind === "creation") ids.push(sent.data.thread.id);
    }
  }
  await render(
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <ChatShell sidebar={<WiredSidebar />}>
          <main className="tenant-map" style={{ minWidth: 0 }}>mapa</main>
        </ChatShell>
      </ChatsProvider>
    </div>,
  );
  await settle();
  return { chat, ids };
}

describe.skipIf(!DIR)("capturas da thread de criação (ADR 0056)", () => {
  afterAll(async () => {
    await page.viewport(1440, 900);
  });

  it("barra lateral, thread com o rascunho, thread com a pergunta e cartão criado pelo fluxo de Criar", async () => {
    await page.viewport(1440, 900);
    const { chat, ids } = await mount();
    chat.setCreation(ids[1]!, { state: "waiting" });
    // A lista relê a árvore ao abrir uma conversa; "sua vez" aparece depois de abrir e voltar.
    rowWith("Corrigir o login quando").click();
    await settle(700);
    await shot("01-barra-rascunho-e-sua-vez");
    await shot("02-thread-com-o-rascunho");
    await page.getByRole("button", { name: "Procurar o lugar" }).click();
    await settle(700);
    await shot("03-thread-com-a-pergunta");
    document.querySelector<HTMLButtonElement>(".assistant-choice")!.click();
    await settle(500);
    await page.getByRole("button", { name: "Criar aqui" }).click();
    await settle(800);
    rowWith("Meu chat").click();
    await settle(800);
    await shot("04-cartao-criado-na-conversa-de-cima");
  });

  it("escolha de projeto quando há mais de um, pelo 'Novo ticket' da barra", async () => {
    await page.viewport(1440, 900);
    await mount({ several: true });
    await page.getByRole("button", { name: /Novo ticket/ }).click();
    await settle(300);
    await userEvent.keyboard("Cobrar o relatório mensal{Enter}");
    await settle(700);
    await shot("05-escolha-de-projeto");
  });
});

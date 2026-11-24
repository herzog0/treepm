import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { TestSidebar } from "../layout/testSidebar.js";
import { createFakeChat, makeClient, makeMe, makePerson, makeProject } from "../test/fakes.js";
import { ChatShell } from "./ChatShell.js";
import { ChatsProvider } from "./ChatsContext.js";

// Montagem comum das suítes de navegador da árvore de conversas (ADR 0055, fatia 2): a casca com a barra lateral e a coluna da conversa.
export const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia Nogueira"), makePerson("person-3", "Caio"), makePerson("person-4", "Duda")];
const TICKETS = [
  { id: "t1", key: "ALFA-1", title: "Corrigir o login quando a sessão expira no meio do formulário", projectId: "p1", assignedToMe: true },
  { id: "t2", key: "ALFA-2", title: "Publicar a versão", projectId: "p1" },
];
type Chat = ReturnType<typeof createFakeChat>;

export async function mountConversations(options: { as?: string; seed?: (chat: Chat) => void } = {}) {
  const chat = createFakeChat({ tickets: TICKETS, people });
  options.seed?.(chat);
  const as = options.as ?? "person-1";
  const client = makeClient({ me: makeMe({ assistant: true, personId: as, displayName: people.find((person) => person.id === as)!.displayName }), people, projects: [makeProject("p1", "ALFA", "Projeto Alfa")], chat, chatAs: as });
  return await render(
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <ChatShell sidebar={<TestSidebar />}>
          <main id="stand-in-map" className="tenant-map" style={{ minWidth: 0 }} />
        </ChatShell>
      </ChatsProvider>
    </div>,
  );
}

/** Uma conversa do ticket ALFA-1 com `depth` threads uma dentro da outra (alternando quem é chamado). */
export function seedDeep(chat: Chat, depth: number, replies = true) {
  let parent = chat.seedConversation("t1", [{ person: "Vamos revisar o login", assistant: "Posso ajudar com o plano de revisão." }]);
  for (let level = 1; level <= depth; level += 1) {
    parent = chat.openThreadIn(parent, { from: "person-1", body: `Nível ${level}: olha isto`, to: [level % 2 === 0 ? "person-3" : "person-2"], ...(replies ? { replies: [{ from: level % 2 === 0 ? "person-3" : "person-2", body: `Resposta no nível ${level}` }] } : {}) });
  }
}

export const rows = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")];
export const rowOf = (text: string | RegExp) => rows().find((row) => (typeof text === "string" ? (row.textContent ?? "").startsWith(text) : text.test(row.textContent ?? "")))!;

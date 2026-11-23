import { render } from "@testing-library/react";
import { vi } from "vitest";
import type { ApiClient, Project } from "../api/client.js";
import { ChatPanel } from "./ChatPanel.js";
import { ChatsButton } from "./ChatsButton.js";
import { ChatsProvider } from "./ChatsContext.js";
import { createFakeChat } from "../test/chatFakes.js";
import type { FakeChatOptions, FakeChatTicket } from "../test/chatFakes.js";
import { makeClient, makeMe, makePerson, makeProject } from "../test/fakes.js";

export const ALFA1: FakeChatTicket = { id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true };
export const ALFA2: FakeChatTicket = { id: "t2", key: "ALFA-2", title: "Publicar a versão", projectId: "p1" };
export const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia"), makePerson("person-3", "Caio"), makePerson("person-4", "Duda", { active: false })];

export interface ChatSetup {
  tickets?: FakeChatTicket[];
  assistant?: FakeChatOptions["assistant"];
  reply?: FakeChatOptions["reply"];
  projects?: Project[];
  /** Desliga o assistente no `me` (a IA não está configurada ou a organização não aceitou). */
  me?: ReturnType<typeof makeMe>;
}

/** O painel de chats montado como a aplicação o monta: provedor, botão do cabeçalho e painel, com o chat em memória do contrato. */
export function renderChats(setup: ChatSetup = {}) {
  const chat = createFakeChat({ tickets: setup.tickets ?? [ALFA1, ALFA2], people: people.filter((person) => person.active), ...(setup.assistant ? { assistant: setup.assistant } : {}), ...(setup.reply ? { reply: setup.reply } : {}) });
  const client: ApiClient = makeClient({ me: setup.me ?? makeMe({ assistant: true }), people, projects: setup.projects ?? [makeProject("p1", "ALFA", "Projeto Alfa")], chat });
  const onShowTicket = vi.fn();
  const view = render(
    <ChatsProvider client={client} onShowTicket={onShowTicket}>
      <ChatsButton />
      <ChatPanel />
    </ChatsProvider>,
  );
  return { chat, client, onShowTicket, ...view };
}

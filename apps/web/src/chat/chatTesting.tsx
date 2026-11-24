import { render } from "@testing-library/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { ApiClient, Project } from "../api/client.js";
import { ChatPanel } from "./ChatPanel.js";
import { ConversationList } from "./ConversationList.js";
import { ChatsProvider } from "./ChatsContext.js";
import { createFakeChat } from "../test/chatFakes.js";
import type { FakeChatOptions, FakeChatTicket } from "../test/chatFakes.js";
import { makeClient, makeMe, makePerson, makeProject, makeTicket } from "../test/fakes.js";

export const ALFA1: FakeChatTicket = { id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true };
export const ALFA2: FakeChatTicket = { id: "t2", key: "ALFA-2", title: "Publicar a versão", projectId: "p1" };
const ALL_PEOPLE = [makePerson("person-1", "Ana"), makePerson("person-2", "Bia"), makePerson("person-3", "Caio"), makePerson("person-4", "Duda", { active: false })];
export const people = ALL_PEOPLE;

export interface ChatSetup {
  tickets?: FakeChatTicket[];
  assistant?: FakeChatOptions["assistant"];
  reply?: FakeChatOptions["reply"];
  /** O título que o assistente dá a um assunto novo (padrão: nenhum). */
  topicTitle?: FakeChatOptions["topicTitle"];
  projects?: Project[];
  /** Desliga o assistente no `me` (a IA não está configurada ou a organização não aceitou). */
  me?: ReturnType<typeof makeMe>;
  /** Monta sob `StrictMode`, como `main.tsx` em desenvolvimento (efeitos rodam montar, limpar, montar). Padrão: ligado. */
  strict?: boolean;
  /** Quem lê as conversas (padrão: `person-1`). Dono, participante e convidado leem os mesmos dados. */
  as?: string;
  /** Mexe no chat em memória antes de a aplicação montar: a lista "Conversas" carrega ao montar e se atualiza a cada 30 s, não ao abrir. */
  seed?: (chat: ReturnType<typeof createFakeChat>) => void;
  /** Mexe no cliente (para fazer uma chamada falhar) antes de a aplicação montar. */
  prepare?: (client: ApiClient) => void;
  /** Ids de pessoas que são de teste (ADR 0057): a lista de pessoas as devolve com `isTest`. */
  testPeople?: string[];
  /** Algo a mais dentro do provedor (um botão que chama a API do contexto, como a barra de pedidos faz). */
  extra?: ReactNode;
}

/** A lista "Conversas" e a coluna da conversa montadas como a aplicação as monta: provedor, lista da barra lateral e coluna, com o chat em memória do contrato. */
export function renderChats(setup: ChatSetup = {}) {
  const people = ALL_PEOPLE.map((person) => (setup.testPeople?.includes(person.id) ? { ...person, isTest: true } : person));
  const chat = createFakeChat({ tickets: setup.tickets ?? [ALFA1, ALFA2], people: people.filter((person) => person.active), ...(setup.assistant ? { assistant: setup.assistant } : {}), ...(setup.reply ? { reply: setup.reply } : {}), ...(setup.topicTitle ? { topicTitle: setup.topicTitle } : {}) });
  setup.seed?.(chat);
  const client: ApiClient = makeClient({ me: setup.me ?? makeMe({ assistant: true, ...(setup.as ? { personId: setup.as, displayName: people.find((person) => person.id === setup.as)?.displayName ?? setup.as } : {}) }), people, projects: setup.projects ?? [makeProject("p1", "ALFA", "Projeto Alfa")], tickets: { p1: [makeTicket("t1", "p1", 1, "Corrigir o login", { key: "ALFA-1" }), makeTicket("t2", "p1", 2, "Publicar a versão", { key: "ALFA-2" })] }, chat, ...(setup.as ? { chatAs: setup.as } : {}) });
  setup.prepare?.(client);
  const onShowTicket = vi.fn();
  const tree = (
    <ChatsProvider client={client} onShowTicket={onShowTicket}>
      <ConversationList />
      <ChatPanel />
      {setup.extra}
    </ChatsProvider>
  );
  const view = render(setup.strict === false ? tree : <StrictMode>{tree}</StrictMode>);
  return { chat, client, onShowTicket, ...view };
}

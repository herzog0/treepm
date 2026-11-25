import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { makeConversation, makeMe, makeProject, ok } from "../test/fakes.js";
import { useChats } from "./ChatsContext.js";
import { ALFA1, renderChats } from "./chatTesting.js";
import { composer, fillComposer } from "./composerTesting.js";

// A criação de ticket como subthread (ADR 0056, fatia 3): o fluxo inteiro em jsdom, com o chat em memória e a conversa de novo ticket de sempre.
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const beta = makeProject("p2", "BETA", "Projeto Beta");

/** A conversa de novo ticket que a thread hospeda, pelas rotas de sempre; o estado da thread acompanha a conversa como o servidor o deriva. */
function withCreationRoutes(client: ApiClient, onState?: (conversationId: string, state: "waiting" | "created" | "discarded") => void) {
  Object.assign(client, {
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { draft: { title: "Corrigir o login", description: "Descrição", children: [], idea: false } }))),
    removeConversation: vi.fn(async (id: string) => {
      onState?.(id, "discarded");
      return ok(undefined);
    }),
  });
}

function Starter({ text, projectId }: { text: string; projectId?: string }) {
  const chats = useChats()!;
  return <button type="button" onClick={() => chats.startCreation(text, projectId)}>começar</button>;
}

const sidebarRow = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row.is-creation")];

describe("thread de criação", () => {
  it("o assistente abre o rascunho: a linha '+' com o selo, o cartão e a frase no idioma da pessoa, e descartar volta à conversa de cima", async () => {
    const user = userEvent.setup();
    let store: ReturnType<typeof renderChats>["chat"] | null = null;
    const { chat, client } = renderChats({
      seed: (fake) => {
        store = fake;
        fake.seedGeneral([]);
      },
      projects: [alfa],
      // O servidor deriva "descartado" do elo que some (a conversa de novo ticket foi apagada), na mesma transação.
      prepare: (client) => withCreationRoutes(client, (id) => store!.setCreation(id.replace(/^tc-/, ""), { state: "discarded", ticketConversationId: null, projectId: null, projectKey: null })),
    });
    const fake = chat as unknown as { options: { assistantOpens?: (body: string) => string | null } };
    fake.options.assistantOpens = (body) => (body.startsWith("Crie") ? "Corrigir o login" : null);
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    await composer();
    fillComposer("Crie um ticket para o login");
    await user.click(await screen.findByRole("button", { name: "Enviar" }));
    // O painel vai para a thread nova; a barra mostra a linha "+" com o selo "rascunho".
    await waitFor(() => expect(sidebarRow()).toHaveLength(1));
    expect(sidebarRow()[0]).toHaveTextContent("rascunho");
    expect(await screen.findByText("Só você vê. O ticket só existe quando você apertar Criar.")).toBeInTheDocument();
    expect(screen.getByText("O assistente abriu este rascunho a seu pedido.")).toBeInTheDocument();
    expect(client.getConversation).toHaveBeenCalled();
    // Descartar (com confirmação) tira a linha e volta à conversa de cima.
    await user.click(await screen.findByRole("button", { name: "Descartar rascunho" }));
    await user.click(await screen.findByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(client.removeConversation).toHaveBeenCalled());
    fake.options.assistantOpens = undefined;
    await waitFor(() => expect(sidebarRow()).toHaveLength(0));
    expect(await screen.findByText("Abri um rascunho de ticket")).toBeInTheDocument();
  });

  it("'Novo ticket' junto do campo abre a thread; duplo clique não cria dois", async () => {
    const user = userEvent.setup();
    const { client } = renderChats({ seed: (fake) => void fake.seedGeneral([]), projects: [alfa], prepare: (client) => withCreationRoutes(client) });
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    await composer();
    fillComposer("Corrigir o login");
    const button = await screen.findByRole("button", { name: "Novo ticket" });
    await user.dblClick(button);
    await waitFor(() => expect(sidebarRow()).toHaveLength(1));
    expect(vi.mocked(client.sendChatMessage).mock.calls.filter(([, body]) => body.creation === true)).toHaveLength(1);
  });

  it("assunto da barra de pedidos em que o assistente abre um rascunho: leva à thread de criação, sem 'tempo esgotado'", async () => {
    const user = userEvent.setup();
    const Bar = () => {
      const chats = useChats()!;
      return <button type="button" onClick={() => chats.startTopic("Crie um ticket para o login")}>Pedir assunto</button>;
    };
    const { chat } = renderChats({ seed: (fake) => void fake.seedGeneral([]), projects: [alfa], prepare: (client) => withCreationRoutes(client), extra: <Bar /> });
    chat.options.assistantOpens = (body) => (body.startsWith("Crie") ? "Corrigir o login" : null);
    await user.click(await screen.findByRole("button", { name: "Pedir assunto" }));
    await waitFor(() => expect(sidebarRow()).toHaveLength(1));
    expect(await screen.findByText("Só você vê. O ticket só existe quando você apertar Criar.")).toBeInTheDocument();
    expect(screen.queryByText(/não respondeu a tempo|tempo/i)).toBeNull();
  });

  it("'Novo ticket' junto do campo: a espera aparece desde o clique, o campo trava e 'Cancelar' devolve o campo", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client } = renderChats({
      seed: (fake) => void fake.seedGeneral([]),
      projects: [alfa],
      prepare: (client) => {
        withCreationRoutes(client);
        const send = client.sendChatMessage;
        client.sendChatMessage = vi.fn(async (...args: Parameters<typeof send>) => (await gate, send(...args))) as typeof send;
      },
    });
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    await composer();
    fillComposer("Corrigir o login");
    await user.click(await screen.findByRole("button", { name: "Novo ticket" }));
    expect(await screen.findByText("Abrindo o rascunho…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Novo ticket" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    release();
    await waitFor(() => expect(screen.queryByText("Abrindo o rascunho…")).not.toBeInTheDocument());
    // O texto continua no campo e nada abriu a thread.
    expect(document.querySelector(".ProseMirror")).toHaveTextContent("Corrigir o login");
    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sidebarRow()).toHaveLength(0);
  });

  it("a barra de pedidos com uma criação já esperando: a recusa fala de ticket novo, não de assunto", async () => {
    const user = userEvent.setup();
    const Twice = () => {
      const chats = useChats()!;
      const [refusal, setRefusal] = useState<string | null>(null);
      return (
        <>
          <button type="button" onClick={() => { chats.startCreation("Primeiro pedido"); setRefusal(chats.startCreation("Segundo pedido")); }}>duas vezes</button>
          <p data-testid="refusal">{refusal}</p>
        </>
      );
    };
    renderChats({ seed: (fake) => void fake.seedGeneral([]), projects: [alfa], prepare: (client) => withCreationRoutes(client), extra: <Twice /> });
    await user.click(await screen.findByRole("button", { name: "duas vezes" }));
    expect(screen.getByTestId("refusal")).toHaveTextContent("Já há um ticket novo sendo aberto");
    expect(screen.getByTestId("refusal")).not.toHaveTextContent("assunto");
  });

  it("dentro de uma thread de assunto, a frase 'Abri um rascunho de ticket' também leva à thread de criação", async () => {
    const user = userEvent.setup();
    const { chat } = renderChats({
      seed: (fake) => {
        const general = fake.seedGeneral([{ person: "oi", assistant: "olá" }]);
        fake.seedTopic(general, { body: "Como divido a migração?", reply: "Em três passos.", title: "Dividir a migração" });
      },
      projects: [alfa],
      prepare: (client) => withCreationRoutes(client),
    });
    chat.options.assistantOpens = (body) => (body.startsWith("Crie") ? "Corrigir o login" : null);
    await user.click(await screen.findByRole("button", { name: /^Dividir a migração/ }));
    await composer();
    fillComposer("Crie um ticket para o login");
    await user.click(await screen.findByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(sidebarRow()).toHaveLength(1));
    chat.options.assistantOpens = undefined;
    await user.click(sidebarRow()[0]!.closest("li")!.parentElement!.closest("li")!.querySelector(":scope > .conv-line > button")!);
    expect(await screen.findByText("Abri um rascunho de ticket")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Abrir o rascunho" })).toBeInTheDocument();
  });

  it("vários projetos e nenhum aberto: a tela pergunta qual e reenvia com o projeto escolhido", async () => {
    const user = userEvent.setup();
    const { chat, client } = renderChats({
      seed: (fake) => void fake.seedGeneral([]),
      projects: [alfa, beta],
      prepare: (client) => withCreationRoutes(client),
      extra: <Starter text="Corrigir o login" />,
    });
    chat.options.creatable = { p1: "ALFA", p2: "BETA" };
    await user.click(await screen.findByRole("button", { name: "começar" }));
    expect(await screen.findByRole("group", { name: "Em qual projeto?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /BETA · Projeto Beta/ }));
    await waitFor(() => expect(sidebarRow()).toHaveLength(1));
    expect(vi.mocked(client.sendChatMessage).mock.calls.at(-1)![1]).toMatchObject({ creation: true, projectId: "p2" });
  });

  it("a escolha de projeto lista só os projetos em que a pessoa pode criar ticket", async () => {
    const user = userEvent.setup();
    const me = makeMe({ assistant: true, clerk: "member" });
    me.roles.projects.push({ projectId: "p1", role: "contributor" });
    const { chat } = renderChats({ me, seed: (fake) => void fake.seedGeneral([]), projects: [alfa, beta], prepare: (client) => withCreationRoutes(client), extra: <Starter text="Corrigir o login" /> });
    chat.options.creatable = { p1: "ALFA", p2: "BETA" };
    await user.click(await screen.findByRole("button", { name: "começar" }));
    const group = await screen.findByRole("group", { name: "Em qual projeto?" });
    expect(group).toHaveTextContent("ALFA · Projeto Alfa");
    expect(group).not.toHaveTextContent("BETA");
  });

  it("projeto sem permissão: texto próprio e o pedido continua no campo", async () => {
    const user = userEvent.setup();
    const { chat } = renderChats({ seed: (fake) => void fake.seedGeneral([]), projects: [alfa], prepare: (client) => withCreationRoutes(client), extra: <Starter text="Corrigir o login" projectId="p1" /> });
    chat.options.creatable = { p9: "ZZZ" };
    await user.click(await screen.findByRole("button", { name: "começar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não pode criar tickets nesse projeto");
    expect(sidebarRow()).toHaveLength(0);
  });

  it("a partir do chat de um ticket: nasce no projeto dele e o cartão aparece na conversa", async () => {
    const user = userEvent.setup();
    const { client } = renderChats({ tickets: [ALFA1], projects: [alfa], prepare: (client) => withCreationRoutes(client) });
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await composer();
    fillComposer("Também validar o logout");
    await user.click(await screen.findByRole("button", { name: "Novo ticket" }));
    await waitFor(() => expect(sidebarRow()).toHaveLength(1));
    const [, body] = vi.mocked(client.sendChatMessage).mock.calls.at(-1)!;
    expect(body).toMatchObject({ creation: true });
    expect(body.projectId).toBeUndefined();
    expect(sidebarRow()[0]).toHaveTextContent("Também validar o logout");
  });
});

describe("thread de criação sem acesso", () => {
  it("falha do provedor: nada pela metade e o texto volta", async () => {
    const user = userEvent.setup();
    renderChats({ assistant: "not_configured", seed: (fake) => void fake.seedGeneral([]), projects: [alfa], prepare: (client) => withCreationRoutes(client), extra: null });
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    expect(sidebarRow()).toHaveLength(0);
  });
});

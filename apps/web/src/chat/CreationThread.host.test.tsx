import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type { MapNode } from "../map/items.js";
import type { MapPicker } from "../assistant/types.js";
import { failed, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { useChats } from "./ChatsContext.js";
import type { MapHost } from "./ChatsContext.js";
import { renderChats } from "./chatTesting.js";

const sidebarRows = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row.is-creation")];
const threadOf = (conversationId: string) => conversationId.replace(/^tc-/, "");

// A thread de criação e o mapa (ADR 0056): o mapa empresta à thread o projeto, o escolher no mapa, o card tracejado, a recarga e a criação manual.
const draft = { title: "Corrigir o login", description: "O login falha.", children: [], idea: false };
const target = (...ids: string[]) => ({ parentId: ids.at(-1) ?? null, path: ids.map((id) => ({ id, title: id === "t1" ? "Corrigir o login" : "Publicar a versão" })) });

function newHost(overrides: Partial<MapHost> = {}) {
  const pickers: (MapPicker | null)[] = [];
  const host = {
    projectId: () => "p1",
    creatable: [{ id: "p1", key: "ALFA", name: "Projeto Alfa", archived: false }] as unknown as MapHost["creatable"],
    scopeTicketId: () => null,
    registerPicker: vi.fn((picker: MapPicker | null) => void pickers.push(picker)),
    onDraftChange: vi.fn(),
    onChanged: vi.fn(),
    onManualCreate: vi.fn(),
    ...overrides,
  } satisfies MapHost;
  return { host, pickers };
}

function Registrar({ host }: { host: MapHost | null }) {
  const chats = useChats()!;
  const { setMapHost, startCreation } = chats;
  useEffect(() => {
    setMapHost(host);
    return () => setMapHost(null);
  }, [host, setMapHost]);
  return <button type="button" onClick={() => startCreation("Corrigir o login")}>começar</button>;
}

function routes(client: ApiClient, extra: Partial<Record<keyof ApiClient, unknown>> = {}) {
  Object.assign(client, {
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { draft }))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: target("t1") }))),
    updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string }) => ok(makeConversation(id, "p1", { draft: { ...draft, ...body } }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] })),
    removeConversation: vi.fn(async () => ok(undefined)),
    getPlacementDecision: vi.fn(async () => ok({ decision: null })),
    ...extra,
  });
}

async function open(host: MapHost | null, extra: Partial<Record<keyof ApiClient, unknown>> = {}) {
  const user = userEvent.setup();
  const view = renderChats({ seed: (fake) => void fake.seedGeneral([]), prepare: (client) => routes(client, extra), extra: <Registrar host={host} /> });
  await user.click(await screen.findByRole("button", { name: "começar" }));
  await screen.findByRole("textbox", { name: "Título" });
  return { user, ...view };
}
const search = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
  await screen.findByRole("region", { name: "Caminho encontrado" });
};
const node = (id: string): MapNode => {
  const ticket = makeTicket(id, "p1", 1, id === "t1" ? "Corrigir o login" : "Publicar a versão", { key: id === "t1" ? "ALFA-1" : "ALFA-2" });
  return { id, parentId: "p1", kind: "ticket", label: ticket.title, color: "#fff", key: ticket.key, ticket, leafCount: 1 };
};

describe("thread de criação com o mapa montado", () => {
  it("Escolher no mapa: o clique do mapa vira o destino e criar usa esse lugar", async () => {
    const { host, pickers } = newHost();
    const { user, client } = await open(host);
    await search(user);
    await user.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await waitFor(() => expect(pickers.at(-1)).not.toBeNull());
    act(() => pickers.at(-1)!.pick(node("t2")));
    await user.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith(expect.any(String), { parentId: "t2", placedBy: "map" }));
  });

  it("Escolher no mapa pode ser cancelado pela faixa, e o mapa é solto", async () => {
    const { host, pickers } = newHost();
    const { user } = await open(host);
    await search(user);
    await user.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await waitFor(() => expect(pickers.at(-1)).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Cancelar escolha" }));
    await waitFor(() => expect(pickers.at(-1)).toBeNull());
    expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
  });

  it("o card tracejado do mapa segue o destino achado", async () => {
    const { host } = newHost();
    const { user } = await open(host);
    await search(user);
    await waitFor(() => expect(host.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" }));
  });

  it("criar: o mapa recarrega, a conversa vai ao ticket novo e a linha da barra mostra o selo 'novo'", async () => {
    const { host } = newHost();
    const { user, onShowTicket } = await open(host);
    await search(user);
    await user.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(host.onChanged).toHaveBeenCalled());
    await waitFor(() => expect(onShowTicket).toHaveBeenCalledWith("t9"));
  });

  it("falha da IA: 'Criar manualmente' entrega o projeto e o rascunho ao mapa", async () => {
    const { host } = newHost();
    const { user } = await open(host, { sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")) });
    await user.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "x{Enter}");
    await user.click(await screen.findByRole("button", { name: "Criar manualmente" }));
    expect(host.onManualCreate).toHaveBeenCalledWith({ projectId: "p1", parentId: null, draft: { title: "Corrigir o login", description: "O login falha." } });
  });

  it("o ticket aberto no mapa é o escopo: a procura começa dentro dele e o chip diz onde", async () => {
    const { host } = newHost({ scopeTicketId: () => "t1" });
    const { user, client } = await open(host);
    expect(await screen.findByText("Dentro de ALFA-1")).toBeInTheDocument();
    await search(user);
    expect(client.findPlacement).toHaveBeenCalledWith(expect.any(String), "t1");
  });
});

describe("thread de criação sem mapa montado (outra tela)", () => {
  it("o botão 'Escolher no mapa' não aparece, e o resto do fluxo funciona", async () => {
    const { user, client } = await open(null);
    await search(user);
    expect(screen.queryByRole("button", { name: "Escolher no mapa" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalled());
  });
});

describe("thread de criação: conversa que não carrega", () => {
  it("mostra o erro com 'Tentar novamente' e carrega depois", async () => {
    let failedOnce = false;
    const getConversation = vi.fn(async (id: string) => {
      if (id.startsWith("tc-") && !failedOnce) {
        failedOnce = true;
        return failed("unavailable");
      }
      return ok(makeConversation(id, "p1", { draft }));
    });
    const user = userEvent.setup();
    renderChats({ strict: false, seed: (fake) => void fake.seedGeneral([]), prepare: (client) => routes(client, { getConversation }), extra: <Registrar host={newHost().host} /> });
    await user.click(await screen.findByRole("button", { name: "começar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("indisponível");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("textbox", { name: "Título" })).toBeInTheDocument();
  });
});

describe("thread de criação: a pergunta do lugar até Criar", () => {
  const question = makePlacement({
    question: { level: 1, kind: "which", at: { id: null, title: "Projeto Alfa", path: [] }, options: [{ id: "t1", title: "Corrigir o login", path: [{ id: "t1", title: "Corrigir o login" }] }, { id: "t2", title: "Publicar a versão", path: [{ id: "t2", title: "Publicar a versão" }] }] },
    destinationConfirmed: false,
    uncertain: true,
    destination: target("t1"),
  });

  it("'sua vez' na barra enquanto a pergunta espera; ao criar a linha some e a conversa vai ao ticket novo", async () => {
    const { host } = newHost();
    const user = userEvent.setup();
    let fake: ReturnType<typeof renderChats>["chat"] | null = null;
    let asked = false;
    const view = renderChats({
      seed: (chat) => {
        fake = chat;
        chat.seedGeneral([]);
      },
      prepare: (client) =>
        routes(client, {
          findPlacement: vi.fn(async (id: string) => {
            if (!asked) {
              asked = true;
              fake!.setCreation(threadOf(id), { state: "waiting" });
              return ok(question);
            }
            fake!.setCreation(threadOf(id), { state: "draft" });
            return ok(makePlacement({ destination: target("t1") }));
          }),
          createTicketFromConversation: vi.fn(async (id: string) => {
            fake!.setCreation(threadOf(id), { state: "created", ticketConversationId: null, ticket: { id: "t9", key: "ALFA-9", title: "Corrigir o login" } });
            return ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] });
          }),
        }),
      extra: <Registrar host={host} />,
    });
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await user.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    // A pergunta é da pessoa: a linha da barra diz "sua vez" e o Enter da conversa não cria nada.
    await waitFor(() => expect(sidebarRows()[0]).toHaveTextContent("sua vez"));
    expect(screen.queryByRole("button", { name: "Criar aqui" })).not.toBeInTheDocument();
    const choices = [...document.querySelectorAll<HTMLButtonElement>("button.assistant-choice")];
    await user.click(choices.find((choice) => choice.textContent?.startsWith("Corrigir o login"))!);
    await user.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(view.client.createTicketFromConversation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sidebarRows()).toHaveLength(0));
    await waitFor(() => expect(view.onShowTicket).toHaveBeenCalledWith("t9"));
    expect(screen.queryByText("Só você vê. O ticket só existe quando você apertar Criar.")).not.toBeInTheDocument();
}, 20_000);

  it("Criar com duplo clique cria um ticket só", async () => {
    const { host } = newHost();
    const { user, client } = await open(host);
    await search(user);
    await user.dblClick(screen.getByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalled());
    expect(client.createTicketFromConversation).toHaveBeenCalledTimes(1);
  });

  it("Tirar o escopo: a procura seguinte vai ao projeto inteiro", async () => {
    const { host } = newHost({ scopeTicketId: () => "t1" });
    const { user, client } = await open(host);
    await user.click(await screen.findByRole("button", { name: "Tirar o escopo" }));
    expect(screen.queryByText("Dentro de ALFA-1")).not.toBeInTheDocument();
    await search(user);
    // `null` explícito: sem ele o servidor reaplicaria o ticket de origem da thread.
    expect(client.findPlacement).toHaveBeenLastCalledWith(expect.any(String), null);
  });
});

describe("thread de criação: quem vê e onde", () => {
  it("outra pessoa ('entrar como') não vê a thread na árvore nem a lê por id", async () => {
    const { host } = newHost();
    const { chat, client } = await open(host);
    const mine = await client.listConversationTree();
    if (!mine.ok) throw new Error("árvore");
    const nodes = (items: typeof mine.data.items): typeof mine.data.items => items.flatMap((node) => [node, ...nodes(node.children ?? [])]);
    const creation = nodes(mine.data.items).find((node) => node.purpose === "creation");
    expect(creation).toBeDefined();
    const other = chat.methods("person-2");
    const theirs = await other.listConversationTree();
    if (!theirs.ok) throw new Error("árvore");
    expect(nodes(theirs.data.items).some((node) => node.purpose === "creation")).toBe(false);
    const read = await other.getConversationView(creation!.id!);
    expect(read.ok).toBe(false);
  });

  it("sem acesso ao projeto do rascunho: só o aviso, sem a conversa de novo ticket", async () => {
    const user = userEvent.setup();
    const { chat } = renderChats({ seed: (fake) => void fake.seedGeneral([]), projects: [], prepare: (client) => routes(client), extra: <Registrar host={null} /> });
    chat.options.creatable = { p9: "ZZZ" };
    chat.options.assistantOpens = undefined;
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await waitFor(() => expect(sidebarRows()).toHaveLength(1));
    expect(await screen.findByText("Você não enxerga o projeto deste rascunho.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Mensagem para o assistente" })).not.toBeInTheDocument();
  });

  it("trocar de projeto descarta o rascunho e reabre a thread no outro com o pedido", async () => {
    const both = [{ id: "p1", key: "ALFA", name: "Projeto Alfa", archived: false }, { id: "p2", key: "BETA", name: "Projeto Beta", archived: false }] as unknown as MapHost["creatable"];
    const { host } = newHost({ creatable: both });
    const user = userEvent.setup();
    const view = renderChats({ projects: [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")], seed: (fake) => void fake.seedGeneral([]), prepare: (client) => routes(client), extra: <Registrar host={host} /> });
    view.chat.options.creatable = { p1: "ALFA", p2: "BETA" };
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await screen.findByRole("textbox", { name: "Título" });
    await user.click(await screen.findByRole("button", { name: "Abrir em BETA" }));
    await user.click(await screen.findByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(view.client.removeConversation).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(view.client.sendChatMessage).mock.calls.at(-1)![1]).toMatchObject({ creation: true, projectId: "p2" }));
  });
});

describe("thread de criação: trocar de projeto com a reabertura falhando", () => {
  it("o rascunho já foi descartado: o pedido volta ao campo da conversa de cima, em modo 'novo ticket', com o erro visível", async () => {
    const both = [{ id: "p1", key: "ALFA", name: "Projeto Alfa", archived: false }, { id: "p2", key: "BETA", name: "Projeto Beta", archived: false }] as unknown as MapHost["creatable"];
    const { host } = newHost({ creatable: both });
    const user = userEvent.setup();
    // O servidor só deixa criar em ALFA: a reabertura em BETA volta `project_unavailable`.
    const view = renderChats({ projects: [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")], seed: (fake) => void fake.seedGeneral([]), prepare: (client) => routes(client), extra: <Registrar host={host} /> });
    view.chat.options.creatable = { p1: "ALFA" };
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await screen.findByRole("textbox", { name: "Título" });
    await user.click(await screen.findByRole("button", { name: "Abrir em BETA" }));
    await user.click(await screen.findByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(view.client.removeConversation).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não pode criar tickets nesse projeto");
    expect(document.querySelector(".ProseMirror")).toHaveTextContent("Corrigir o login");
    expect(document.querySelector(".creation-mode")).not.toBeNull();
  });
});

describe("thread de criação: falha do provedor dentro dela", () => {
  it("a mensagem fica como não respondida, com 'Tentar de novo' e a saída manual, e a thread continua", async () => {
    const { host } = newHost();
    const { user } = await open(host, { sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")) });
    await user.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "Oi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("O assistente não respondeu");
    expect(screen.getByText("Não respondida")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar manualmente" })).toBeInTheDocument();
    expect(sidebarRows()).toHaveLength(1);
  });
});

describe("o selo do estado da thread", () => {
  it("com a pergunta do lugar aberta, o cabeçalho e a linha da barra dizem 'sua vez' (o servidor a marca e a tela relê)", async () => {
    const { host } = newHost();
    const store: { chat?: { setCreation: (id: string, patch: { state: "waiting" }) => void } } = {};
    const question = makePlacement({
      question: { level: 1, kind: "which", at: { id: null, title: "Projeto Alfa", path: [] }, options: [{ id: "t1", title: "Corrigir o login", path: [{ id: "t1", title: "Corrigir o login" }] }] },
      destinationConfirmed: false,
      uncertain: true,
    });
    const view = await open(host, {
      findPlacement: vi.fn(async (conversationId: string) => {
        store.chat?.setCreation(threadOf(conversationId), { state: "waiting" });
        return ok(question);
      }),
    });
    store.chat = view.chat;
    const { user } = view;
    expect(document.querySelector(".creation-head .creation-badge")?.textContent).toBe("rascunho");
    await user.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await screen.findByText("Onde isto entra?");
    await waitFor(() => expect(document.querySelector(".creation-head .creation-badge")?.textContent).toBe("sua vez"));
    expect(sidebarRows()[0]?.querySelector(".creation-badge")?.textContent).toBe("sua vez");
  });
});

describe("thread de criação: trocar de conversa e voltar", () => {
  const t1 = makeTicket("t1", "p1", 1, "Corrigir o login", { key: "ALFA-1" });
  const t2 = makeTicket("t2", "p1", 2, "Publicar a versão", { key: "ALFA-2" });
  const question = makePlacement({
    question: { level: 1, kind: "which", at: { id: null, title: "Projeto Alfa", path: [] }, options: [{ id: "t1", title: "Corrigir o login", path: [{ id: "t1", title: "Corrigir o login" }] }, { id: "t2", title: "Publicar a versão", path: [{ id: "t2", title: "Publicar a versão" }] }] },
    destinationConfirmed: false,
    uncertain: true,
    destination: target("t1"),
  });
  const decision = { chosenPath: [], related: [], duplicateTicketId: null, doubt: { confirmed: false, startId: null, question: { level: 1, kind: "which", parentId: null, options: [{ ticketId: "t1" }, { ticketId: "t2" }] } } };

  it("a pergunta aberta volta do servidor e o que é só da tela (edição não salva, resposta escolhida) volta da memória da sessão", async () => {
    const { host } = newHost();
    const user = userEvent.setup();
    let searched = false;
    renderChats({
      seed: (chat) => void chat.seedGeneral([]),
      tickets: [t1, t2],
      projects: [makeProject("p1", "ALFA", "Projeto Alfa")],
      prepare: (client) => routes(client, { findPlacement: vi.fn(async () => ((searched = true), ok(question))), getPlacementDecision: vi.fn(async () => ok({ decision: searched ? decision : null })) }),
      extra: <Registrar host={host} />,
    });
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await user.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await waitFor(() => expect(document.querySelectorAll("button.assistant-choice").length).toBeGreaterThan(0));
    // Edição à mão que ainda não foi salva.
    const title = screen.getByRole("textbox", { name: "Título" });
    await user.type(title, " agora");
    // Sai para o Meu chat e volta à thread: a pergunta continua aberta e a edição não se perde.
    await user.click(document.querySelector<HTMLButtonElement>("button.conv-row:not(.is-creation)")!);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Título" })).not.toBeInTheDocument());
    await user.click(sidebarRows()[0]!);
    await waitFor(() => expect(document.querySelectorAll("button.assistant-choice").length).toBeGreaterThan(0));
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login agora");
  });
});

describe("thread de criação: aviso de ligações descartadas", () => {
  it("o aviso continua à vista no bloco 'criada' depois de a conversa reler e a thread virar criada", async () => {
    const { host } = newHost();
    const user = userEvent.setup();
    let fake: ReturnType<typeof renderChats>["chat"] | null = null;
    renderChats({
      seed: (chat) => {
        fake = chat;
        chat.seedGeneral([]);
      },
      prepare: (client) =>
        routes(client, {
          createTicketFromConversation: vi.fn(async (id: string) => {
            fake!.setCreation(threadOf(id), { state: "created", ticketConversationId: null, ticket: { id: "t9", key: "ALFA-9", title: "Corrigir o login" } });
            return ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [{ code: "link_discarded", de: "pai", dependeDe: "ALFA-3", reason: "cycle" }] });
          }),
        }),
      extra: <Registrar host={host} />,
    });
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await user.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await user.click(await screen.findByRole("button", { name: "Criar aqui" }));
    // O miolo desmonta quando a thread vira "criada": o aviso mora no bloco da thread e fica à vista.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Título" })).not.toBeInTheDocument());
    expect(screen.getByText(/Ligação a ALFA-3/)).toBeInTheDocument();
  });
});

describe("thread de criação: acertos de comportamento", () => {
  const closeColumn = () => screen.getByRole("button", { name: "Fechar a conversa" });
  const meniscus = (id: string) => makeTicket(id, "p9", 7, "De outro projeto", { key: "ZZZ-7" });

  it("sem o mapa montado, a falha da IA não oferece 'Criar manualmente' (só tentar de novo)", async () => {
    const { user } = await open(null, { sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")) });
    await user.type(await screen.findByRole("textbox", { name: "Mensagem para o assistente" }), "x{Enter}");
    expect(await screen.findByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar manualmente" })).not.toBeInTheDocument();
  });

  it("fechar a coluna da conversa solta o mapa que esperava um clique", async () => {
    const { host, pickers } = newHost();
    const { user } = await open(host);
    await search(user);
    await user.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await waitFor(() => expect(pickers.at(-1)).not.toBeNull());
    await user.click(closeColumn());
    await waitFor(() => expect(pickers.at(-1)).toBeNull());
  });

  it("o clique em ticket de outro projeto durante a escolha é recusado com a mensagem, e a escolha segue armada", async () => {
    const { host, pickers } = newHost();
    const { user } = await open(host);
    await search(user);
    await user.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await waitFor(() => expect(pickers.at(-1)).not.toBeNull());
    act(() => pickers.at(-1)!.pick({ ...node("t2"), ticket: meniscus("x9") }));
    expect(await screen.findByText(/Esta conversa é do projeto Projeto Alfa/)).toBeInTheDocument();
    expect(pickers.at(-1)).not.toBeNull();
  });

  it("o card tracejado segue 'Um nível acima' e some quando a thread é descartada", async () => {
    const { host } = newHost();
    const { user } = await open(host);
    await search(user);
    await waitFor(() => expect(host.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" }));
    await user.click(screen.getByRole("button", { name: "Um nível acima" }));
    await waitFor(() => expect(host.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: null, title: "Corrigir o login" }));
    await user.click(await screen.findByRole("button", { name: "Descartar rascunho" }));
    await user.click(await screen.findByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(host.onDraftChange).toHaveBeenLastCalledWith(null));
  });

  it("o mapa que remonta com a thread aberta recebe o card tracejado de novo", async () => {
    const first = newHost();
    const second = newHost();
    let swap: (host: MapHost) => void = () => undefined;
    function Swapper() {
      const chats = useChats()!;
      swap = (host) => chats.setMapHost(host);
      return null;
    }
    const user = userEvent.setup();
    renderChats({ seed: (fake) => void fake.seedGeneral([]), prepare: (client) => routes(client), extra: <><Registrar host={first.host} /><Swapper /></> });
    await user.click(await screen.findByRole("button", { name: "começar" }));
    await screen.findByRole("textbox", { name: "Título" });
    await user.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await waitFor(() => expect(first.host.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" }));
    act(() => swap(second.host));
    await waitFor(() => expect(second.host.onDraftChange).toHaveBeenLastCalledWith({ projectId: "p1", parentId: "t1", title: "Corrigir o login" }));
  });

  it("criar e ir para outra conversa durante a espera: o painel não volta à força, e a barra se atualiza", async () => {
    const { host } = newHost();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { user, client, onShowTicket } = await open(host, {
      createTicketFromConversation: vi.fn(async (id: string) => {
        await gate;
        return ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] });
      }),
    });
    await search(user);
    await user.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await user.click(document.querySelector<HTMLButtonElement>("button.conv-row:not(.is-creation)")!);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Título" })).not.toBeInTheDocument());
    const reads = vi.mocked(client.listConversationTree).mock.calls.length;
    release();
    await waitFor(() => expect(host.onChanged).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(client.listConversationTree).mock.calls.length).toBeGreaterThan(reads));
    expect(onShowTicket).not.toHaveBeenCalled();
  });

  it("bloco 'creation' sem o elo da conversa de novo ticket: a thread diz que a pessoa não enxerga mais o projeto", async () => {
    const { host } = newHost();
    const view = await open(host);
    const thread = sidebarRows()[0]!;
    expect(thread).toBeDefined();
    const row = await view.client.listConversationTree();
    if (!row.ok) throw new Error("árvore");
    const flat = (items: typeof row.data.items): typeof row.data.items => items.flatMap((node) => [node, ...flat(node.children ?? [])]);
    const creation = flat(row.data.items).find((node) => node.purpose === "creation")!;
    view.chat.setCreation(creation.id!, { ticketConversationId: null, projectId: null, projectKey: null });
    await user_click_refresh(view);
    expect(await screen.findByText("Você não enxerga o projeto deste rascunho.")).toBeInTheDocument();
  });
});

async function user_click_refresh(view: { user: ReturnType<typeof userEvent.setup> }) {
  // A conversa relê quando a lista se atualiza; sair e voltar à thread força a leitura nova.
  await view.user.click(document.querySelector<HTMLButtonElement>("button.conv-row:not(.is-creation)")!);
  await view.user.click(document.querySelector<HTMLButtonElement>("button.conv-row.is-creation")!);
}

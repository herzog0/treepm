import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, PlacementOutcome } from "../api/client.js";
import type { MapNode } from "../map/items.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { ChatHarness } from "../test/mountChat.js";
import type { MountProps } from "../test/mountChat.js";
import { RecentPlacesProvider } from "./RecentPlacesContext.js";
import { createRecentPlaces } from "./recentPlaces.js";
import type { RecentPlaces } from "./recentPlaces.js";
import { setTestLanguage } from "../test/i18n.js";
import type { MapPicker } from "./types.js";

// A pergunta sobre o lugar (ADR 0054, adendo): a prévia mostra a pergunta no lugar do destino.
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t3", "p1", 3, "Senha", { key: "ALFA-3", parentId: "t2" }),
    makeTicket("t4", "p1", 4, "Relatórios", { key: "ALFA-4", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t5", "p1", 5, "Solto", { key: "ALFA-5" }),
    makeTicket("t6", "p1", 6, "Cancelado", { key: "ALFA-6", status: "cancelled" }),
    makeTicket("t7", "p1", 7, "Sessão", { key: "ALFA-7", parentId: "t1" }),
    makeTicket("t8", "p1", 8, "Cobrança", { key: "ALFA-8", parentId: "t4" }),
    makeTicket("t9", "p1", 9, "Ideia solta", { key: "ALFA-9", idea: { root: true, stage: "new" } }),
    makeTicket("t10", "p1", 10, "Token", { key: "ALFA-10", parentId: "t2" }),
    makeTicket("t11", "p1", 11, "Dentro da ideia", { key: "ALFA-11", parentId: "t9", idea: { root: false, rootId: "t9", rootKey: "ALFA-9" } }),
    makeTicket("t12", "p1", 12, "Planos", { key: "ALFA-12", parentId: "t4", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t13", "p1", 13, "Anual", { key: "ALFA-13", parentId: "t12" }),
    makeTicket("t14", "p1", 14, "Filho do cancelado", { key: "ALFA-14", parentId: "t6" }),
    makeTicket("t16", "p1", 16, "Neto da ideia", { key: "ALFA-16", parentId: "t11" }),
  ],
};
const byId = (id: string) => tickets.p1.find((entry) => entry.id === id)!;
const pathOf = (id: string): { id: string; title: string }[] => {
  const chain: { id: string; title: string }[] = [];
  for (let at: typeof tickets.p1[number] | undefined = byId(id); at; at = at.parentId === null ? undefined : byId(at.parentId)) chain.unshift({ id: at.id, title: at.title });
  return chain;
};
const target = (id: string | null) => ({ parentId: id, path: id === null ? [] : pathOf(id) });
const option = (id: string) => ({ id, title: byId(id).title, path: pathOf(id) });
const question = (at: string | null, options: string[], extra: Partial<NonNullable<PlacementOutcome["question"]>> = {}): PlacementOutcome =>
  makePlacement({
    question: { level: at === null ? 1 : pathOf(at).length + 1, kind: "which", at: { id: at, title: at === null ? "Projeto Alfa" : byId(at).title, path: at === null ? [] : pathOf(at) }, options: options.map(option), ...extra },
    destinationConfirmed: false,
    uncertain: true,
    destination: target(options[0] ?? null),
  });
const confirmed = (id: string | null) => makePlacement({ destination: target(id) });

afterEach(() => window.localStorage.clear());

function clientWith(placements: PlacementOutcome[], extra: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const client = makeClient({ projects: [alfa] });
  const findPlacement = vi.fn();
  for (const placement of placements) findPlacement.mockResolvedValueOnce(ok(placement));
  findPlacement.mockResolvedValue(ok(placements.at(-1)!));
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c-new", projectId))),
    sendConversationMessage: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string }) => ok(makeConversation(id, "p1", { draft: body }))),
    findPlacement,
    createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("tn", "p1", 20, "Corrigir o login", { key: "ALFA-20" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] })),
    removeConversation: vi.fn(async () => ok(undefined)),
    ...extra,
  });
  return client;
}

function baseProps(client: ApiClient, extra: Partial<MountProps> = {}): MountProps {
  return {
    client,
    projects: [alfa],
    initialProjectId: "p1",
    tickets,
    resume: true,
    onCreated: vi.fn(),
    onManualCreate: vi.fn(),
    onDraftChange: vi.fn(),
    onChanged: vi.fn(),
    registerPicker: vi.fn(),
    ...extra,
  };
}

function setup(client: ApiClient, extra: Partial<MountProps> = {}, recents?: RecentPlaces) {
  const props = baseProps(client, extra);
  const panel = <ChatHarness {...props} />;
  render(recents ? <RecentPlacesProvider value={recents}>{panel}</RecentPlacesProvider> : panel);
  return props;
}

const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
const card = () => screen.getByRole("region", { name: "Caminho encontrado" });
const inCard = () => within(card());
const choice = (name: string | RegExp) => inCard().getByRole("button", { name });
const create = () => inCard().getByRole("button", { name: "Criar aqui" });
const noCreate = () => expect(inCard().queryByRole("button", { name: /^Criar/ })).not.toBeInTheDocument();
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const created = (client: ApiClient) => vi.mocked(client.createTicketFromConversation).mock.calls.at(-1)?.[1];
const lastPicker = (props: MountProps) => vi.mocked(props.registerPicker).mock.calls.filter(([picker]) => picker !== null).at(-1)![0] as MapPicker;
const ticketNode = (id: string): MapNode => ({ id, parentId: "p1", kind: "ticket", label: byId(id).title, color: "#fff", key: byId(id).key, ticket: byId(id), leafCount: 1 });

describe("the question in place of the destination", () => {
  it("asks 'Onde isto entra?' with where the doubt is, every option, 'fica aqui' and the map, and marks nothing", async () => {
    const props = setup(clientWith([question(null, ["t1", "t4"])]));
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    expect(card()).toHaveTextContent("Projeto Alfa");
    expect(choice(/^Acesso/)).toBeInTheDocument();
    expect(choice(/^Relatórios/)).toBeInTheDocument();
    expect(choice("Deixar solto no projeto")).toBeInTheDocument();
    expect(choice("Nenhum destes: escolher no mapa")).toBeInTheDocument();
    // Nenhuma opção marcada, nem palpite como destino: não há passos do caminho.
    expect(card().querySelector("[aria-pressed='true'], [aria-current], .is-selected")).toBeNull();
    expect(card()).not.toHaveTextContent("Entra aqui");
    // Sem destino, o mapa não recebe card tracejado.
    expect(props.onDraftChange).not.toHaveBeenCalledWith(expect.objectContaining({ title: expect.anything() }));
  });

  it("shows the path of a deeper question and 'Fica aqui, em «título»'", async () => {
    setup(clientWith([question("t2", ["t3", "t10"])]));
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    expect(card()).toHaveTextContent("Acesso › Login");
    expect(choice("Fica aqui, em «Login»")).toBeInTheDocument();
    expect(within(choice(/^Senha/)).getByText("Acesso › Login")).toBeInTheDocument();
  });

  it("gives every option the same weight: ramos, 'fica aqui', recents and the map are the same kind of button, none primary", async () => {
    setup(clientWith([question(null, ["t1", "t4"])]), {}, (() => {
      const recents = createRecentPlaces("org-1", "person-1");
      recents.record("p1", "t3");
      return recents;
    })());
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    const list = inCard().getByRole("list", { name: "Lugares possíveis" });
    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(["Acesso", "Relatórios", "Deixar solto no projeto"]);
    const all = [...within(list).getAllByRole("button"), ...within(inCard().getByRole("list", { name: "Lugares recentes" })).getAllByRole("button"), choice("Nenhum destes: escolher no mapa")];
    expect(all).toHaveLength(5);
    expect(all.every((button) => button.classList.contains("assistant-choice") && !button.classList.contains("primary"))).toBe(true);
  });

  it("takes Criar away while the question is open, leaving only a short phrase, and shows no group proposal", async () => {
    const withProposal = { ...question(null, ["t1", "t4"]), groupProposal: { title: "Grupo", description: "", tickets: [{ id: "t5", number: 5, title: "Solto" }] } };
    const client = clientWith([withProposal]);
    setup(client);
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    noCreate();
    expect(inCard().queryByRole("button", { name: "Criar sem esperar" })).not.toBeInTheDocument();
    expect(card()).toHaveTextContent("Falta escolher o lugar para criar.");
    expect(screen.queryByText("Criar ticket pai e mover")).not.toBeInTheDocument();
    expect(inCard().queryByRole("button", { name: "Um nível acima" })).not.toBeInTheDocument();
    expect(client.createTicketFromConversation).not.toHaveBeenCalled();
  });

  it("without a question the preview is exactly the destination, as before", async () => {
    setup(clientWith([confirmed("t2")]));
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(card()).toHaveTextContent("Entra aqui");
    expect(inCard().queryByRole("heading", { name: "Onde isto entra?" })).not.toBeInTheDocument();
    expect(create()).toBeEnabled();
  });
});

describe("what each answer does", () => {
  it("a branch searches again from it (startId, nothing else) and a confirmed result replaces the question", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), confirmed("t2")]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    expect(client.findPlacement).toHaveBeenLastCalledWith("c1", undefined, "t1");
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    expect(inCard().queryByRole("heading", { name: "Onde isto entra?" })).not.toBeInTheDocument();
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t2", placedBy: "option" }));
  });

  it("sends the scope along with startId", async () => {
    const client = clientWith([question("t1", ["t2", "t7"]), confirmed("t2")]);
    setup(client, { initialScopeId: "t1" });
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenLastCalledWith("c1", "t1", "t2"));
  });

  it("a deeper question after an answer replaces the first one", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), question("t1", ["t2", "t7"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await waitFor(() => expect(choice("Fica aqui, em «Acesso»")).toBeInTheDocument());
    expect(choice(/^Login/)).toBeInTheDocument();
    expect(choice(/^Sessão/)).toBeInTheDocument();
    noCreate();
  });

  it("'fica aqui' makes the question node the destination, with no server call, and creates with placedBy stay", async () => {
    const client = clientWith([question("t1", ["t2", "t7"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Fica aqui, em «Acesso»" }));
    expect(client.findPlacement).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(create()).toBeEnabled());
    // O palpite do servidor e o aviso de incerteza não voltam depois de a pessoa decidir.
    expect(card()).not.toHaveTextContent("Não tenho certeza");
    expect(inCard().queryByRole("heading", { name: "Onde isto entra?" })).not.toBeInTheDocument();
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t1", placedBy: "stay" }));
  });

  it("at the root, 'Deixar solto no projeto' puts the ticket at the root", async () => {
    const client = clientWith([question(null, ["t1", "t4"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Deixar solto no projeto" }));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: null, placedBy: "stay" }));
  });

  it("'Nenhum destes' opens the map choice; the clicked ticket is final with placedBy map", async () => {
    const client = clientWith([question(null, ["t1", "t4"])]);
    const props = setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Nenhum destes: escolher no mapa" }));
    expect(screen.getByText("Clique em um ticket ou no projeto, no mapa. Esc cancela.")).toBeInTheDocument();
    lastPicker(props).pick(ticketNode("t5"));
    await waitFor(() => expect(create()).toBeEnabled());
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t5", placedBy: "map" }));
  });

  it("sends placedBy search only for a confirmed result with no answer from the person", async () => {
    const client = clientWith([confirmed("t2")]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t2", placedBy: "search" }));
  });

  it("an answer followed by a deeper confirmation is still placedBy option", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), confirmed("t3")]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t3", placedBy: "option" }));
  });

  it("using an alternative or going one level up after an answer is option", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), makePlacement({ destination: target("t2"), alternatives: [target("t7")] })]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Usar: / }));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t7", placedBy: "option" }));
  });

  it("when the answer search fails the question stays and the error shows", async () => {
    const client = clientWith([question(null, ["t1", "t4"])]);
    vi.mocked(client.findPlacement).mockReset().mockResolvedValueOnce(ok(question(null, ["t1", "t4"]))).mockResolvedValueOnce(failed("unavailable", "assistant_unavailable"));
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(inCard().getByRole("heading", { name: "Onde isto entra?" })).toBeInTheDocument();
    noCreate();
  });
});

describe("the limit of three answers", () => {
  const deep = (at: string, options: string[]) => question(at, options);

  it("after the third answer a new question is not asked: the destination is the last branch the person confirmed", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), deep("t1", ["t2", "t7"]), deep("t2", ["t3", "t10"]), deep("t3", ["t10"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Senha/ }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(4));
    expect(vi.mocked(client.findPlacement).mock.calls.map((call) => call[2])).toEqual([undefined, "t1", "t2", "t3"]);
    await waitFor(() => expect(create()).toBeEnabled());
    expect(inCard().queryByRole("heading", { name: "Onde isto entra?" })).not.toBeInTheDocument();
    expect(card()).toHaveTextContent("Já perguntei três vezes. Dá para criar aqui ou escolher mais fundo no mapa.");
    expect(card()).toHaveTextContent("Acesso");
    expect(card()).toHaveTextContent("Senha");
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t3", placedBy: "option" }));
  });

  it("a confirmation on the third answer is not the limit", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), deep("t1", ["t2", "t7"]), deep("t2", ["t3", "t10"]), confirmed("t3")]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Senha/ }));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    expect(card()).not.toHaveTextContent("Já perguntei três vezes");
  });

  it("searching again starts the count over", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), deep("t1", ["t2", "t7"]), deep("t2", ["t3", "t10"]), question(null, ["t1", "t4"]), deep("t1", ["t2", "t7"]), deep("t2", ["t3", "t10"]), deep("t3", ["t10"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await screen.findByRole("button", { name: /^Senha/ });
    await userEvent.click(screen.getByRole("button", { name: "Procurar de novo" }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(4));
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    // Só duas respostas nesta procura: a terceira pergunta ainda aparece.
    expect(await screen.findByRole("heading", { name: "Onde isto entra?" })).toBeInTheDocument();
    expect(card()).not.toHaveTextContent("Já perguntei três vezes");
  });
});

describe("recent places in the question", () => {
  const seeded = (...ids: string[]) => {
    const recents = createRecentPlaces("org-1", "person-1");
    for (const id of [...ids].reverse()) recents.record("p1", id);
    return recents;
  };

  it("offers up to three live recents inside the doubt, with title and path, under a short label", async () => {
    setup(clientWith([question("t1", ["t2", "t7"])]), {}, seeded("t3", "t10", "t2", "t7", "t1", "t6", "t9", "t4", "t8"));
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    // t2 e t7 são opções do servidor, t1 é o próprio nó da pergunta, t6 está cancelado, t9 é ideia, t4 e t8 estão fora de «Acesso».
    expect(inCard().getByText("Lugares recentes")).toBeInTheDocument();
    const recents = inCard().getByRole("list", { name: "Lugares recentes" });
    expect(within(recents).getAllByRole("button").map((button) => button.textContent)).toEqual(["SenhaAcesso › Login", "TokenAcesso › Login"]);
  });

  it("at the root a recent from anywhere in the project counts, up to three, never the question's own options", async () => {
    setup(clientWith([question(null, ["t1", "t4"])]), {}, seeded("t4", "t3", "t8", "t10", "t5"));
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    const recents = inCard().getByRole("list", { name: "Lugares recentes" });
    expect(within(recents).getAllByRole("button").map((button) => button.textContent)).toEqual(["SenhaAcesso › Login", "CobrançaRelatórios", "TokenAcesso › Login"]);
  });

  it("respects the scope", async () => {
    setup(clientWith([question("t1", ["t2", "t7"])]), { initialScopeId: "t1" }, seeded("t3"));
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    expect(inCard().getByText("Senha")).toBeInTheDocument();
  });

  it("a recent that is outside the scope is not offered (scope t4, question at t4)", async () => {
    setup(clientWith([question("t4", ["t8", "t12"])]), { initialScopeId: "t4" }, seeded("t3", "t13"));
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    const recents = inCard().getByRole("list", { name: "Lugares recentes" });
    expect(within(recents).getAllByRole("button").map((button) => button.textContent)).toEqual(["AnualRelatórios › Planos"]);
  });

  it("with no recents there is no label and no list", async () => {
    setup(clientWith([question(null, ["t1", "t4"])]), {}, seeded());
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    expect(inCard().queryByText("Lugares recentes")).not.toBeInTheDocument();
  });

  it("choosing a recent searches from it (startId) and creating sends placedBy recent", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), confirmed("t3")]);
    setup(client, {}, seeded("t3"));
    await search();
    const recents = await screen.findByRole("list", { name: "Lugares recentes" });
    await userEvent.click(within(recents).getByRole("button", { name: /^Senha/ }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenLastCalledWith("c1", undefined, "t3"));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t3", placedBy: "recent" }));
  });

  it("a recent followed by a branch keeps the path as started at a recent place", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), question("t3", ["t10"]), confirmed("t10")]);
    setup(client, {}, seeded("t3"));
    await search();
    await userEvent.click(within(await screen.findByRole("list", { name: "Lugares recentes" })).getByRole("button", { name: /^Senha/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Token/ }));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t10", placedBy: "recent" }));
  });

  it("the screen works the same when localStorage throws", async () => {
    const client = clientWith([question(null, ["t1", "t4"]), confirmed("t2")]);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setup(client, {}, createRecentPlaces("org-1", "person-1"));
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t2", placedBy: "option" }));
    vi.restoreAllMocks();
  });

  it("records the parent of a ticket created from the conversation", async () => {
    const recents = createRecentPlaces("org-1", "person-1");
    const client = clientWith([confirmed("t2")], {
      createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("tn", "p1", 20, "Novo", { key: "ALFA-20", parentId: "t2" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] })),
    });
    setup(client, {}, recents);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(recents.read("p1")).toEqual(["t2"]));
  });

  it("does not record a root creation", async () => {
    const recents = createRecentPlaces("org-1", "person-1");
    const client = clientWith([question(null, ["t1"])]);
    setup(client, {}, recents);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Deixar solto no projeto" }));
    await userEvent.click(create());
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalled());
    expect(recents.read("p1")).toEqual([]);
  });
});

describe("an edited draft invalidates the place", () => {
  const edit = async (title: string) => {
    const field = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.clear(field);
    await userEvent.type(field, title);
  };

  it("saving the draft searches again, from zero but keeping the scope, and only then lets create", async () => {
    const client = clientWith([question("t1", ["t2", "t7"]), question("t2", ["t3", "t10"]), confirmed("t5")]);
    setup(client, { initialScopeId: "t1" });
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await edit("Outro título");
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(3));
    expect(client.updateConversationDraft).toHaveBeenCalled();
    // Procura de novo: sem startId e com o escopo.
    expect(client.findPlacement).toHaveBeenLastCalledWith("c1", "t1");
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t5", placedBy: "search" }));
  });

  it("'Criar' with an edited draft saves, searches again and does not create on that click", async () => {
    const client = clientWith([confirmed("t2"), confirmed("t3")]);
    setup(client);
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await edit("Outro título");
    await userEvent.click(create());
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(card()).toHaveTextContent("Senha"));
    expect(client.createTicketFromConversation).not.toHaveBeenCalled();
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t3", placedBy: "search" }));
  });

  it("a 409 placement_stale searches again once and does not loop", async () => {
    const client = clientWith([confirmed("t2"), confirmed("t3")], { createTicketFromConversation: vi.fn(async () => failed("conflict", "placement_stale")) });
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(card()).toHaveTextContent("Senha"));
    expect(client.createTicketFromConversation).toHaveBeenCalledTimes(1);
    expect(client.findPlacement).toHaveBeenCalledTimes(2);
  });
});

describe("a decision the server could not keep", () => {
  it("shows the destination as a guess with the usual actions, and creating sends option", async () => {
    const client = clientWith([makePlacement({ destination: target("t2"), alternatives: [target("t7")], uncertain: true, destinationConfirmed: false })]);
    setup(client);
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(inCard().queryByRole("heading", { name: "Onde isto entra?" })).not.toBeInTheDocument();
    expect(card()).toHaveTextContent("Não tenho certeza do lugar");
    expect(inCard().getByRole("button", { name: /Usar: / })).toBeInTheDocument();
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t2", placedBy: "option" }));
  });
});

describe("the three languages", () => {
  it.each([
    ["en", "Find the place", "Where does this go?", "Unsure at: Acesso", "Stays here, in «Acesso»", "Recent places", "None of these: choose on the map", "Choose the place before creating."],
    ["es-MX", "Buscar el lugar", "¿Dónde entra esto?", "Duda en: Acesso", "Se queda aquí, en «Acesso»", "Lugares recientes", "Ninguno de estos: elegir en el mapa", "Falta elegir el lugar para crear."],
  ])("%s", async (language, searchLabel, heading, at, stay, recent, map, needs) => {
    await setTestLanguage(language as "en" | "es-MX");
    try {
      const recents = createRecentPlaces("org-1", "person-1");
      recents.record("p1", "t3");
      setup(clientWith([question("t1", ["t2", "t7"])]), {}, recents);
      await userEvent.click(await screen.findByRole("button", { name: searchLabel }));
      await screen.findByRole("heading", { name: heading });
      // O nome da região também muda com o idioma: o cartão é achado pela classe.
      const element = document.querySelector<HTMLElement>(".assistant-card.is-path")!;
      const text = element.textContent ?? "";
      for (const expected of [at, recent, needs]) expect(text).toContain(expected);
      expect(within(element).getByRole("button", { name: stay })).toBeInTheDocument();
      expect(within(element).getByRole("button", { name: map })).toBeInTheDocument();
    } finally {
      await setTestLanguage("pt-BR");
    }
  });
});

describe("review 1: the shape of the question", () => {
  it("a thin line separates the branches from the 'stop here' answer", async () => {
    setup(clientWith([question(null, ["t1", "t4"])]));
    await search();
    const list = await screen.findByRole("list", { name: "Lugares possíveis" });
    const rule = list.querySelector("[role='separator']")!;
    expect(rule).not.toBeNull();
    expect(rule.previousElementSibling).toHaveTextContent("Relatórios");
    expect(rule.nextElementSibling).toHaveTextContent("Deixar solto no projeto");
  });

  it("no line when there are no branches", async () => {
    setup(clientWith([question("t3", [])]));
    await search();
    const list = await screen.findByRole("list", { name: "Lugares possíveis" });
    expect(list.querySelector("[role='separator']")).toBeNull();
  });

  it("a guess at the root with no stored decision asks with only 'Deixar solto' and the map, and no Criar", async () => {
    const client = clientWith([makePlacement({ destination: target(null), uncertain: false, destinationConfirmed: false })]);
    setup(client);
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    const list = inCard().getByRole("list", { name: "Lugares possíveis" });
    expect(within(list).getAllByRole("button").map((button) => button.textContent)).toEqual(["Deixar solto no projeto"]);
    expect(choice("Nenhum destes: escolher no mapa")).toBeInTheDocument();
    noCreate();
    await userEvent.click(choice("Deixar solto no projeto"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: null, placedBy: "stay" }));
  });

  it("a guess outside the root with no stored decision (uncertain false) keeps the usual actions and creates with option", async () => {
    const client = clientWith([makePlacement({ destination: target("t2"), uncertain: false, destinationConfirmed: false })]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t2", placedBy: "option" }));
  });
});

describe("review 1: a late result never overrides the person's last action", () => {
  const pending = () => {
    const late = deferred<ReturnType<typeof ok<PlacementOutcome>>>();
    const client = clientWith([question(null, ["t1", "t4"])]);
    vi.mocked(client.findPlacement).mockReset().mockResolvedValueOnce(ok(question(null, ["t1", "t4"]))).mockReturnValueOnce(late.promise as never);
    return { client, late };
  };

  it("while a search is in flight every option is off and a visible sign says it is searching", async () => {
    const { client, late } = pending();
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    for (const button of card().querySelectorAll<HTMLButtonElement>("button.assistant-choice")) expect(button).toBeDisabled();
    expect(screen.getAllByText(/Procurando o lugar/).length).toBeGreaterThan(0);
    late.resolve(ok(confirmed("t2")));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
  });

  it("a second option clicked before the answer arrives does nothing: one search only", async () => {
    const { client, late } = pending();
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(choice(/^Relatórios/));
    await userEvent.click(choice("Deixar solto no projeto"));
    expect(client.findPlacement).toHaveBeenCalledTimes(2);
    late.resolve(ok(confirmed("t2")));
    await waitFor(() => expect(card()).toHaveTextContent("Entra aqui"));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t2", placedBy: "option" }));
  });

  it("a message sent while the answer is in flight discards the late result", async () => {
    const { client, late } = pending();
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    await userEvent.type(screen.getByRole("textbox", { name: "Mensagem para o assistente" }), "outra coisa{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalled());
    late.resolve(ok(confirmed("t2")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: "Caminho encontrado" })).not.toBeInTheDocument();
    expect(created(client)).toBeUndefined();
  });
});

describe("review 1: focus, stale lists and the breadcrumb", () => {
  it.each([
    ["'fica aqui'", async () => userEvent.click(await screen.findByRole("button", { name: "Fica aqui, em «Acesso»" })), [question("t1", ["t2"])]],
    ["an answer that confirms", async () => userEvent.click(await screen.findByRole("button", { name: /^Acesso/ })), [question(null, ["t1"]), confirmed("t2")]],
  ])("after %s the focus goes to Criar aqui", async (_name, act, placements) => {
    setup(clientWith(placements as PlacementOutcome[]));
    await search();
    await act();
    await waitFor(() => expect(create()).toHaveFocus());
  });

  it("at the limit the focus goes to Criar aqui", async () => {
    setup(clientWith([question(null, ["t1"]), question("t1", ["t2"]), question("t2", ["t3"]), question("t3", ["t10"])]));
    await search();
    for (const name of [/^Acesso/, /^Login/, /^Senha/]) await userEvent.click(await screen.findByRole("button", { name }));
    await waitFor(() => expect(create()).toHaveFocus());
  });

  it("recents under a cancelled ancestor or inside an idea are not offered", async () => {
    const recents = createRecentPlaces("org-1", "person-1");
    for (const id of ["t14", "t16", "t11"]) recents.record("p1", id);
    setup(clientWith([question(null, ["t1", "t4"])]), {}, recents);
    await search();
    await screen.findByRole("heading", { name: "Onde isto entra?" });
    expect(inCard().queryByRole("list", { name: "Lugares recentes" })).not.toBeInTheDocument();
  });

  it("'fica aqui' builds the path from question.at.path, not from the local list", async () => {
    const asked = question("t2", ["t3"]);
    asked.question!.at = { id: "t2", title: "Login novo", path: [{ id: "t1", title: "Acesso novo" }, { id: "t2", title: "Login novo" }] };
    setup(clientWith([asked]));
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Fica aqui, em «Login novo»" }));
    await waitFor(() => expect(card()).toHaveTextContent("Acesso novo"));
    expect(card()).toHaveTextContent("Login novo");
    expect(card()).not.toHaveTextContent("Acesso Login");
  });

  it("records the real parent of the created ticket, not the destination asked for", async () => {
    const recents = createRecentPlaces("org-1", "person-1");
    const client = clientWith([confirmed("t2")], {
      createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: { ...makeTicket("tn", "p1", 20, "Novo", { key: "ALFA-20", parentId: "tg" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" }, children: [], warnings: [] })),
    });
    setup(client, {}, recents);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await waitFor(() => expect(recents.read("p1")).toEqual(["tg"]));
  });

  it("records nothing when the creation fails", async () => {
    const recents = createRecentPlaces("org-1", "person-1");
    setup(clientWith([confirmed("t2")], { createTicketFromConversation: vi.fn(async () => failed("conflict", "conversation_closed")) }), {}, recents);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar aqui" }));
    await screen.findByRole("alert");
    expect(recents.read("p1")).toEqual([]);
  });
});

describe("review 1: the limit notice and the placedBy table", () => {
  const limit = () => clientWith([question(null, ["t1", "t4"]), question("t1", ["t2", "t7"]), question("t2", ["t3", "t10"]), question("t3", ["t10"])]);
  const toLimit = async () => {
    await search();
    for (const name of [/^Acesso/, /^Login/, /^Senha/]) await userEvent.click(await screen.findByRole("button", { name }));
    await screen.findByText(/Já perguntei três vezes/);
  };

  it("the notice goes away with 'Um nível acima'", async () => {
    setup(limit());
    await toLimit();
    await userEvent.click(inCard().getByRole("button", { name: "Um nível acima" }));
    expect(screen.queryByText(/Já perguntei três vezes/)).not.toBeInTheDocument();
  });

  it("the notice goes away with the map choice", async () => {
    const props = setup(limit());
    await toLimit();
    await userEvent.click(inCard().getByRole("button", { name: "Escolher no mapa" }));
    lastPicker(props).pick(ticketNode("t5"));
    await waitFor(() => expect(screen.queryByText(/Já perguntei três vezes/)).not.toBeInTheDocument());
  });

  it("the notice goes away with 'Usar'", async () => {
    const client = clientWith([question(null, ["t1"]), question("t1", ["t2"]), question("t2", ["t3"]), makePlacement({ question: { level: 4, kind: "which", at: { id: "t3", title: "Senha", path: pathOf("t3") }, options: [option("t10")] }, destinationConfirmed: false, uncertain: true, destination: target("t10"), alternatives: [target("t7")] })]);
    setup(client);
    await search();
    for (const name of [/^Acesso/, /^Login/, /^Senha/]) await userEvent.click(await screen.findByRole("button", { name }));
    await screen.findByText(/Já perguntei três vezes/);
    expect(inCard().queryByRole("button", { name: /Usar: / })).not.toBeInTheDocument();
  });

  it("'fica aqui' after an answer is stay", async () => {
    const client = clientWith([question(null, ["t1"]), question("t1", ["t2"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Fica aqui, em «Acesso»" }));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t1", placedBy: "stay" }));
  });

  it("the limit on a path started at a recent place is recent", async () => {
    const recents = createRecentPlaces("org-1", "person-1");
    recents.record("p1", "t3");
    const client = clientWith([question(null, ["t1", "t4"]), question("t3", ["t10"]), question("t10", ["t10"]), question("t10", ["t10"])]);
    setup(client, {}, recents);
    await search();
    await userEvent.click(within(await screen.findByRole("list", { name: "Lugares recentes" })).getByRole("button", { name: /^Senha/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Token/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Token/ }));
    await screen.findByText(/Já perguntei três vezes/);
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t10", placedBy: "recent" }));
  });

  it.each([
    ["Usar", /Usar: /],
    ["Um nível acima", "Um nível acima"],
  ])("'%s' after a recent place is option", async (_name, button) => {
    const recents = createRecentPlaces("org-1", "person-1");
    recents.record("p1", "t3");
    const client = clientWith([question(null, ["t1", "t4"]), makePlacement({ destination: target("t3"), alternatives: [target("t7")] })]);
    setup(client, {}, recents);
    await search();
    await userEvent.click(within(await screen.findByRole("list", { name: "Lugares recentes" })).getByRole("button", { name: /^Senha/ }));
    await userEvent.click(await screen.findByRole("button", { name: button }));
    await userEvent.click(create());
    await waitFor(() => expect(created(client)?.placedBy).toBe("option"));
  });

  it("'Usar' and 'Um nível acima' after a branch answer are each option, with the right parent", async () => {
    for (const [button, parentId] of [[/Usar: /, "t7"], ["Um nível acima", "t2"]] as const) {
      const client = clientWith([question(null, ["t1"]), makePlacement({ destination: target("t3"), alternatives: [target("t7")] })]);
      const { unmount } = render(<ChatHarness {...baseProps(client)} />);
      await search();
      await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
      await userEvent.click(await screen.findByRole("button", { name: button }));
      await userEvent.click(create());
      await waitFor(() => expect(created(client)).toEqual({ parentId, placedBy: "option" }));
      unmount();
    }
  });
});

describe("review 1: the count starts over", () => {
  const twoAnswers = async () => {
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await screen.findByRole("button", { name: /^Senha/ });
  };
  const rounds = (...first: PlacementOutcome[]) => clientWith([...first, question(null, ["t1", "t4"]), question("t1", ["t2", "t7"]), question("t2", ["t3", "t10"]), question("t3", ["t10"])]);

  it("removing the scope with the chip", async () => {
    setup(rounds(question("t1", ["t2", "t7"]), question("t2", ["t3", "t10"])), { initialScopeId: "t1" });
    await search();
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    await screen.findByRole("button", { name: /^Senha/ });
    await userEvent.click(screen.getByRole("button", { name: "Tirar o escopo" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    expect(await screen.findByRole("heading", { name: "Onde isto entra?" })).toBeInTheDocument();
    expect(screen.queryByText(/Já perguntei três vezes/)).not.toBeInTheDocument();
  });

  it("sending a message", async () => {
    const client = rounds(question(null, ["t1", "t4"]), question("t1", ["t2", "t7"]), question("t2", ["t3", "t10"]));
    setup(client);
    await twoAnswers();
    await userEvent.type(screen.getByRole("textbox", { name: "Mensagem para o assistente" }), "mais um pouco{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Acesso/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Login/ }));
    expect(await screen.findByRole("heading", { name: "Onde isto entra?" })).toBeInTheDocument();
    expect(screen.queryByText(/Já perguntei três vezes/)).not.toBeInTheDocument();
  });

});

describe("review 1: the person's choice survives an edited draft", () => {
  const edit = async (title: string) => {
    const field = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.clear(field);
    await userEvent.type(field, title);
  };

  it("after 'fica aqui', Criar with an edited draft saves and creates in that click, keeping the place and placedBy", async () => {
    const client = clientWith([question("t1", ["t2"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Fica aqui, em «Acesso»" }));
    await edit("Outro título");
    await userEvent.click(create());
    await waitFor(() => expect(created(client)).toEqual({ parentId: "t1", placedBy: "stay" }));
    expect(client.updateConversationDraft).toHaveBeenCalled();
    expect(client.findPlacement).toHaveBeenCalledTimes(1);
  });

  it("saving the draft keeps a chosen place without searching again", async () => {
    const client = clientWith([question("t1", ["t2"])]);
    setup(client);
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Fica aqui, em «Acesso»" }));
    await edit("Outro título");
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalled());
    expect(client.findPlacement).toHaveBeenCalledTimes(1);
    expect(card()).toHaveTextContent("Acesso");
    expect(create()).toBeEnabled();
  });

  it("a place that came from the search is still searched again (unchanged)", async () => {
    const client = clientWith([confirmed("t2"), confirmed("t3")]);
    setup(client);
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await edit("Outro título");
    await userEvent.click(create());
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    expect(client.createTicketFromConversation).not.toHaveBeenCalled();
  });
});

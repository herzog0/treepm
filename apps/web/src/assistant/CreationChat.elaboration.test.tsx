import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElaborationOutcome } from "../api/client.js";
import { setTestLanguage } from "../test/i18n.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { ChatHarness } from "../test/mountChat.js";

/** Tarefas sugeridas pelo assistente e ligações propostas na prévia (ADR 0052, fatia 3; TREEPM-329). */
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets = { p1: [makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" }), makeTicket("t8", "p1", 8, "Guardar a origem de cada ticket", { key: "ALFA-8" })] };
const placement = makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] }, related: [{ id: "t8", key: "ALFA-8", title: "Guardar a origem de cada ticket", status: "todo", path: [] }] });
const elaboration = (extra: Partial<ElaborationOutcome> = {}): ElaborationOutcome => ({
  links: [{ de: "pai", dependeDe: "ALFA-8", dependeDeTitle: "Guardar a origem de cada ticket", motivo: "precisa saber de onde veio" }],
  suggested: [
    { title: "Guardar o cursor da última sincronização", description: "Para pedir só o diff", motivo: "sem isso não há diff" },
    { title: "Cadastrar o token do Jira", description: "", motivo: "o Jira exige" },
  ],
  unavailable: null,
  ...extra,
});

function setup(answers: ElaborationOutcome | (() => Promise<ElaborationOutcome>) | Error = elaboration(), children = [{ title: "Receber o diff", description: "" }]) {
  const client = makeClient({ projects: [alfa] });
  const conversation = makeConversation("c1", "p1", { draft: { title: "Sincronizar tickets", description: "Receber o diff", children } });
  const getElaboration = vi.fn(async () => {
    if (answers instanceof Error) throw answers;
    return ok(typeof answers === "function" ? await answers() : answers);
  });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    getConversationPreview: vi.fn(async () => ok({ title: "Sincronizar tickets", description: "Receber o diff", quote: "", children, idea: false, unknownKeys: [], descriptionTooLong: false })),
    findPlacement: vi.fn(async () => ok(placement)),
    getElaboration,
    updateConversationDraft: vi.fn(async (_id: string, body: { title: string; description: string; children?: { title: string; description: string }[] }) =>
      ok({ ...conversation, updatedAt: "later", draft: { ...conversation.draft!, title: body.title, description: body.description, children: body.children ?? conversation.draft!.children } })),
    createTicketFromConversation: vi.fn(async (id: string) =>
      ok({
        conversation: makeConversation(id, "p1", { status: "ticket_created" }),
        ticket: { ...makeTicket("t9", "p1", 9, "Sincronizar tickets", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" },
        children: [],
        warnings: [],
      })),
  });
  const props = {
    client, projects: [alfa], initialProjectId: "p1", tickets, resume: true, onCreated: vi.fn(), onOpenExisting: vi.fn(), onManualCreate: vi.fn(), onDraftChange: vi.fn(), onChanged: vi.fn(), registerPicker: vi.fn(),
  };
  render(<ChatHarness {...props} />);
  return { client, props, getElaboration };
}
const search = async () => userEvent.click(await screen.findByRole("button", { name: /Procurar o lugar|Find the place|Buscar el lugar/ }));
const suggestedGroup = () => screen.findByRole("region", { name: "Sugeridas pelo assistente" });
const linksGroup = () => screen.findByRole("region", { name: "Ligações propostas" });
const create = () => userEvent.click(screen.getByRole("button", { name: /^Criar (aqui|ticket e)/ }));

beforeEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("a elaboração na prévia", () => {
  it("depois da procura mostra os dois grupos, separados das partes, com tudo incluído por padrão", async () => {
    const { getElaboration } = setup();
    await search();
    const suggested = await suggestedGroup();
    expect(getElaboration).toHaveBeenCalledWith("c1");
    expect(within(suggested).getAllByRole("listitem")).toHaveLength(2);
    expect(within(suggested).getByText("Guardar o cursor da última sincronização")).toBeInTheDocument();
    expect(within(suggested).getByText("sem isso não há diff")).toBeInTheDocument();
    const links = await linksGroup();
    const box = within(links).getByRole("checkbox", { name: /Este ticket depende de ALFA-8 Guardar a origem de cada ticket/ });
    expect(box).toBeChecked();
    expect(links).toHaveTextContent("precisa saber de onde veio");
    // Fora do cartão das partes: um grupo próprio, depois do rascunho.
    expect(screen.getByRole("region", { name: "Rascunho do ticket" }).contains(suggested)).toBe(false);
  });

  it("uma parte da pessoa aparece como origem da ligação com o título dela", async () => {
    setup(elaboration({ links: [{ de: 0, deTitle: "Receber o diff", dependeDe: "ALFA-8", dependeDeTitle: "Guardar a origem de cada ticket", motivo: "ok" }] }));
    await search();
    expect(await screen.findByRole("checkbox", { name: /A parte "Receber o diff" depende de ALFA-8/ })).toBeChecked();
  });

  it("enquanto carrega: esqueleto com texto visível; criar espera ('Aguardando as sugestões…') e 'Criar sem esperar' cria sem elas", async () => {
    let release!: (value: ElaborationOutcome) => void;
    const { client } = setup(() => new Promise((resolve) => { release = resolve; }));
    await search();
    const skeleton = await screen.findByRole("status", { name: "Procurando ligações e tarefas" });
    expect(skeleton).toHaveTextContent("Procurando ligações e tarefas");
    const waiting = screen.getByRole("button", { name: "Aguardando as sugestões…" });
    expect(waiting).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Criar sem esperar" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1", placedBy: "search" }));
    release(elaboration());
  });

  it("quando a elaboração chega, o botão de criar volta e a chegada é anunciada em uma frase com as contagens", async () => {
    let release!: (value: ElaborationOutcome) => void;
    setup(() => new Promise((resolve) => { release = resolve; }));
    await search();
    await screen.findByRole("button", { name: "Aguardando as sugestões…" });
    release(elaboration());
    await suggestedGroup();
    expect(screen.queryByRole("button", { name: "Criar sem esperar" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Criar (aqui|ticket e)/ })).toBeEnabled();
    expect(screen.getByRole("status", { name: "Sugestões do assistente" })).toHaveTextContent("2 tarefas sugeridas e 1 ligação proposta.");
  });

  it.each([
    ["listas vazias", elaboration({ links: [], suggested: [] })],
    ["modelo indisponível", elaboration({ links: [], suggested: [], unavailable: "unavailable" })],
    ["erro na chamada", new Error("rede")],
  ])("%s: nada aparece e a criação segue normal", async (_n, answer) => {
    const { client } = setup(answer);
    await search();
    await screen.findByRole("button", { name: /^Criar (aqui|ticket e)/ });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Procurando ligações e tarefas" })).toBeNull());
    expect(screen.queryByRole("region", { name: "Sugeridas pelo assistente" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Ligações propostas" })).toBeNull();
    await create();
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1", placedBy: "search" }));
  });
});

describe("tirar e desmarcar", () => {
  it("criar leva as sugeridas que ficaram e as ligações marcadas", async () => {
    const { client, props } = setup();
    await search();
    const suggested = await suggestedGroup();
    await userEvent.click(within(suggested).getByRole("button", { name: "Tirar a tarefa sugerida: Cadastrar o token do Jira" }));
    expect(within(suggested).queryByText("Cadastrar o token do Jira")).toBeNull();
    await create();
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
    expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", {
      placedBy: "search",
      parentId: "t1",
      suggested: [{ title: "Guardar o cursor da última sincronização", description: "Para pedir só o diff", motivo: "sem isso não há diff" }],
      links: [{ de: "pai", dependeDe: "ALFA-8" }],
    });
  });

  it("desmarcar a ligação a tira do pedido; tirar todas as sugeridas some com o grupo", async () => {
    const { client } = setup();
    await search();
    const links = await linksGroup();
    await userEvent.click(within(links).getByRole("checkbox"));
    expect(within(links).getByRole("checkbox")).not.toBeChecked();
    await userEvent.click(within(await suggestedGroup()).getByRole("button", { name: "Tirar todas" }));
    expect(screen.queryByRole("region", { name: "Sugeridas pelo assistente" })).toBeNull();
    await create();
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1", placedBy: "search" }));
  });

  it("procurar de novo refaz a elaboração, mas o que a pessoa tirou não volta se a sugestão é a mesma", async () => {
    const { getElaboration, client } = setup();
    await search();
    const suggested = await suggestedGroup();
    await userEvent.click(within(suggested).getByRole("button", { name: "Tirar a tarefa sugerida: Cadastrar o token do Jira" }));
    await userEvent.click(within(await linksGroup()).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Procurar de novo" }));
    await waitFor(() => expect(getElaboration).toHaveBeenCalledTimes(2));
    const again = await suggestedGroup();
    await waitFor(() => expect(within(again).getAllByRole("listitem")).toHaveLength(1));
    expect(within(again).queryByText("Cadastrar o token do Jira")).toBeNull();
    expect(within(await linksGroup()).getByRole("checkbox")).not.toBeChecked();
    await create();
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1", placedBy: "search", suggested: [{ title: "Guardar o cursor da última sincronização", description: "Para pedir só o diff", motivo: "sem isso não há diff" }] }));
  });

  it("a descrição escrita pelo modelo aparece na prévia, recolhida e como texto puro", async () => {
    setup(elaboration({ suggested: [{ title: "Guardar o cursor", description: "**Não** é <b>markdown</b>", motivo: "sem isso não há diff" }] }));
    await search();
    const group = await suggestedGroup();
    const toggle = within(group).getByText("Ver a descrição");
    expect(toggle.closest("details")).not.toHaveAttribute("open");
    await userEvent.click(toggle);
    expect(toggle.closest("details")).toHaveAttribute("open");
    expect(within(group).getByText("**Não** é <b>markdown</b>")).toBeInTheDocument();
    expect(group.querySelector("b, strong")?.textContent ?? null).toBe("Guardar o cursor");
  });

  it("sugerida sem descrição não ganha o controle", async () => {
    setup(elaboration({ suggested: [{ title: "Cadastrar o token", description: "", motivo: "o Jira exige" }] }));
    await search();
    expect(within(await suggestedGroup()).queryByText("Ver a descrição")).toBeNull();
  });

  it("tirar a última sugerida leva o foco ao botão de criar", async () => {
    setup(elaboration({ suggested: [{ title: "Cadastrar o token", description: "", motivo: "o Jira exige" }] }));
    await search();
    await userEvent.click(within(await suggestedGroup()).getByRole("button", { name: "Tirar a tarefa sugerida: Cadastrar o token" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Criar (aqui|ticket e)/ })).toHaveFocus());
  });

  it("a ligação de uma parte leva o título da parte; o que foi desmarcado é lembrado pelo título, não pelo índice", async () => {
    const { client, getElaboration } = setup(elaboration({ links: [{ de: 0, deTitle: "Receber o diff", dependeDe: "ALFA-8", dependeDeTitle: "Guardar a origem de cada ticket", motivo: "ok" }], suggested: [] }));
    await search();
    await userEvent.click(within(await linksGroup()).getByRole("checkbox"));
    getElaboration.mockResolvedValueOnce(ok(elaboration({ links: [{ de: 1, deTitle: "Receber o diff", dependeDe: "ALFA-8", dependeDeTitle: "Guardar a origem de cada ticket", motivo: "ok" }], suggested: [] })));
    await userEvent.click(screen.getByRole("button", { name: "Procurar de novo" }));
    await waitFor(() => expect(getElaboration).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("checkbox", { name: /A parte "Receber o diff" depende de ALFA-8/ })).not.toBeChecked();
    expect(client.createTicketFromConversation).not.toHaveBeenCalled();
  });

  it("criar leva o título da parte junto de cada ligação de parte", async () => {
    const { client } = setup(elaboration({ links: [{ de: 0, deTitle: "Receber o diff", dependeDe: "ALFA-8", dependeDeTitle: "Guardar a origem de cada ticket", motivo: "ok" }], suggested: [] }));
    await search();
    await linksGroup();
    await create();
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1", placedBy: "search", links: [{ de: 0, deTitle: "Receber o diff", dependeDe: "ALFA-8" }] }));
  });

  it("a chave abre o ticket sem sair da conversa", async () => {
    const { props } = setup();
    await search();
    await userEvent.click(within(await linksGroup()).getByRole("button", { name: "Abrir ALFA-8 Guardar a origem de cada ticket" }));
    expect(props.onOpenExisting).toHaveBeenCalledWith("t8");
  });
});

describe("três idiomas", () => {
  it.each([
    ["en", "Suggested by the assistant", "Proposed links", "This ticket depends on"],
    ["es-MX", "Sugeridas por el asistente", "Vínculos propuestos", "Este ticket depende de"],
  ])("%s", async (language, suggestedName, linksName, depends) => {
    await setTestLanguage(language as "en");
    setup();
    await search();
    expect(await screen.findByRole("region", { name: suggestedName })).toBeInTheDocument();
    const links = await screen.findByRole("region", { name: linksName });
    expect(within(links).getByRole("checkbox", { name: new RegExp(depends) })).toBeChecked();
  });
});

describe("uma elaboração por estado", () => {
  const editTitle = async (value: string) => {
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.clear(title);
    await userEvent.type(title, value);
  };

  it("editar o título e procurar de novo chama a elaboração uma vez por procura, não duas", async () => {
    const { getElaboration } = setup();
    await search();
    await suggestedGroup();
    await editTitle("Sincronizar tickets do Jira");
    await userEvent.click(screen.getByRole("button", { name: "Procurar de novo" }));
    await waitFor(() => expect(getElaboration).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getElaboration).toHaveBeenCalledTimes(2);
  });

  it("rascunho salvo depois da elaboração: a procura e a elaboração recomeçam e a criação leva a nova", async () => {
    const { client, getElaboration } = setup();
    await search();
    await suggestedGroup();
    await editTitle("Sincronizar tickets do Jira");
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    // Salvar procura o lugar de novo (ADR 0054, adendo), e a elaboração acompanha a procura nova.
    await waitFor(() => expect(client.findPlacement).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getElaboration).toHaveBeenCalledTimes(2));
    await suggestedGroup();
    expect(screen.queryByText("O rascunho mudou: procure de novo para atualizar as sugestões e as ligações.")).toBeNull();
    await create();
    // A elaboração que vai é a da procura nova (a velha foi descartada com a procura velha).
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", expect.objectContaining({ parentId: "t1", placedBy: "search" })));
  });

  it("rascunho editado e ainda não salvo: a elaboração velha some e a tela diz para procurar de novo", async () => {
    const { getElaboration } = setup();
    await search();
    await suggestedGroup();
    await editTitle("Sincronizar tickets do Jira");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Sugeridas pelo assistente" })).toBeNull());
    expect(screen.queryByRole("region", { name: "Ligações propostas" })).toBeNull();
    expect(screen.getByText("O rascunho mudou: procure de novo para atualizar as sugestões e as ligações.")).toBeInTheDocument();
    expect(getElaboration).toHaveBeenCalledTimes(1);
  });
});

describe("avisos da criação", () => {
  it("com ligação ou sugerida descartada, a tela diz quantas e por quê, e só depois abre o ticket", async () => {
    const { client, props } = setup();
    client.createTicketFromConversation = vi.fn(async (id: string) =>
      ok({
        conversation: makeConversation(id, "p1", { status: "ticket_created" }),
        ticket: { ...makeTicket("t9", "p1", 9, "Sincronizar tickets", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" },
        children: [],
        warnings: [
          { code: "link_discarded" as const, de: "pai" as const, dependeDe: "ALFA-8", reason: "inactive_ticket" },
          { code: "suggested_discarded" as const, title: "Cadastrar o token", reason: "unknown_keys" as const },
        ],
      })) as never;
    await search();
    await suggestedGroup();
    await create();
    const notice = await screen.findByRole("status", { name: "Ticket criado" });
    expect(notice).toHaveTextContent("2 itens do assistente ficaram de fora");
    expect(notice).toHaveTextContent("ALFA-8");
    expect(notice).toHaveTextContent("Cadastrar o token");
    expect(props.onCreated).not.toHaveBeenCalled();
    await userEvent.click(within(notice).getByRole("button", { name: "Abrir o ticket" }));
    expect(props.onCreated).toHaveBeenCalledWith("t9");
  });

  it("sem avisos, abre o ticket direto, como antes", async () => {
    const { props } = setup();
    await search();
    await suggestedGroup();
    await create();
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
  });
});

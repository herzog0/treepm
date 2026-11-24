import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, DraftPreview } from "../api/client.js";
import { setTestLanguage } from "../test/i18n.js";
import { failed, makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";

/** A prévia da quebra do pedido em pai e filhos (ADR 0044, fatia 2; TREEPM-214 e 217). */
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets = { p1: [makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" })] };
const QUOTE = "Pedido original:\n\n> quero uma interface de chat no painel\n>\n> e uma branch por ticket";
const child = (title: string, description = `O que a pessoa disse sobre ${title}.\n\n## A definir\n\n- Como fica?`) => ({ title, description });
const FILHOS = ["Interface de chat", "Branch por ticket", "Histórico de conversas"].map((title) => child(title));
const preview = (extra: Partial<DraftPreview> = {}): DraftPreview => ({
  title: "Chat no painel",
  description: `${QUOTE}\n\nOrganizado pela IA.`,
  quote: QUOTE,
  children: [],
  idea: false,
  unknownKeys: [],
  descriptionTooLong: false,
  ...extra,
});

function setup(options: { children?: { title: string; description: string }[]; preview?: DraftPreview; extra?: Partial<Record<keyof ApiClient, unknown>> } = {}) {
  const children = options.children ?? [];
  const conversation = (id: string, draftChildren = children) => makeConversation(id, "p1", { draft: { title: "Chat no painel", description: "Organizado pela IA.", children: draftChildren } });
  const client = makeClient({ projects: [alfa] });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation("c1"), messages: undefined }])),
    getConversation: vi.fn(async (id: string) => ok(conversation(id))),
    getConversationPreview: vi.fn(async () => ok(options.preview ?? preview({ children }))),
    updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string; children?: { title: string; description: string }[] }) =>
      ok(makeConversation(id, "p1", { draft: { title: body.title, description: body.description, children: body.children ?? children } }))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] } }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({
      conversation: makeConversation(id, "p1", { status: "ticket_created" }),
      ticket: { ...makeTicket("t9", "p1", 9, "Chat no painel", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" },
      children: [],
        warnings: [],
    })),
    ...options.extra,
  });
  const props = {
    client,
    projects: [alfa],
    initialProjectId: "p1",
    tickets,
    expanded: true,
    resume: true,
    onCollapse: vi.fn(),
    onProgress: vi.fn(),
    onCreated: vi.fn(),
    onManualCreate: vi.fn(),
    onDraftChange: vi.fn(),
    onChanged: vi.fn(),
    registerPicker: vi.fn(),
  };
  render(<AssistantPanel {...props} />);
  return { client, props };
}
const parts = () => screen.getByRole("list", { name: "Partes do ticket" });
const partItems = () => Array.from(parts().querySelectorAll<HTMLElement>(":scope > li"));
const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
const save = () => userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));

describe("o pedido original", () => {
  it("aparece como será gravado, só para leitura, com o rótulo e aberto", async () => {
    const { client } = setup();
    const region = await screen.findByRole("region", { name: "Pedido original" });
    await waitFor(() => expect(region.textContent).toContain("quero uma interface de chat no painel"));
    expect(region.textContent).toContain("e uma branch por ticket");
    expect(region.querySelector("details")).toHaveAttribute("open");
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(client.getConversationPreview).toHaveBeenCalledWith("c1");
  });

  it("fica acima do rascunho", async () => {
    setup();
    const region = await screen.findByRole("region", { name: "Pedido original" });
    const draft = screen.getByRole("region", { name: "Rascunho do ticket" });
    expect(region.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("recolhe e abre de novo", async () => {
    setup();
    const region = await screen.findByRole("region", { name: "Pedido original" });
    const summary = region.querySelector("summary")!;
    await userEvent.click(summary);
    expect(region.querySelector("details")).not.toHaveAttribute("open");
    await userEvent.click(summary);
    expect(region.querySelector("details")).toHaveAttribute("open");
  });

  it("sem citação (pedido vazio) o bloco não aparece", async () => {
    setup({ preview: preview({ quote: "" }) });
    await screen.findByRole("textbox", { name: "Título" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Pedido original" })).toBeNull());
  });

  it("não aparece nem some o resto se a prévia não puder ser lida", async () => {
    setup({ extra: { getConversationPreview: vi.fn(async () => failed("unavailable")) } });
    expect(await screen.findByRole("textbox", { name: "Título" })).toHaveValue("Chat no painel");
    expect(screen.queryByRole("region", { name: "Pedido original" })).toBeNull();
  });

  it("a citação é lida de novo depois de salvar o rascunho", async () => {
    const { client } = setup();
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.type(title, " novo");
    await save();
    await waitFor(() => expect(client.getConversationPreview).toHaveBeenCalledTimes(2));
  });
});

describe("rascunho de um ticket só", () => {
  it("fica como antes: sem lista de partes, sem contador, e o PATCH sem filhos", async () => {
    const { client } = setup();
    const title = await screen.findByRole("textbox", { name: "Título" });
    expect(screen.queryByRole("list", { name: "Partes do ticket" })).toBeNull();
    expect(screen.queryByText(/\d+ partes?/)).toBeNull();
    await userEvent.type(title, "!");
    await save();
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", { title: "Chat no painel!", description: "Organizado pela IA." }));
  });

  it("o botão de criar continua sendo Criar aqui", async () => {
    setup();
    await search();
    expect(await screen.findByRole("button", { name: "Criar aqui" })).toBeInTheDocument();
  });
});

describe("rascunho com filhos", () => {
  it("mostra o pai e a lista dos filhos na ordem, com o contador", async () => {
    setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    expect(partItems()).toHaveLength(3);
    expect(within(partItems()[0]!).getByRole("textbox", { name: "Título da parte 1" })).toHaveValue("Interface de chat");
    expect(within(partItems()[2]!).getByRole("textbox", { name: "Título da parte 3" })).toHaveValue("Histórico de conversas");
    expect(screen.getByText("3 partes")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Chat no painel");
  });

  it("o contador diz 1 parte no singular e o de nove diz 9 partes", async () => {
    setup({ children: [child("Só uma")] });
    expect(await screen.findByText("1 parte")).toBeInTheDocument();
  });

  it("lê a descrição de cada filho como markdown, com A definir como subtítulo", async () => {
    setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    await waitFor(() => expect(within(partItems()[0]!).getByRole("heading", { name: "A definir" })).toBeInTheDocument());
    expect(within(partItems()[0]!).getByText(/O que a pessoa disse sobre Interface de chat/)).toBeInTheDocument();
  });

  it("editar o título de um filho e salvar manda a lista inteira de filhos", async () => {
    const { client } = setup({ children: FILHOS });
    const title = await screen.findByRole("textbox", { name: "Título da parte 2" });
    await userEvent.clear(title);
    await userEvent.type(title, "Uma branch por ticket");
    await save();
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", {
      title: "Chat no painel",
      description: "Organizado pela IA.",
      children: [FILHOS[0], { ...FILHOS[1], title: "Uma branch por ticket" }, FILHOS[2]],
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Salvar rascunho" })).toBeNull());
  });

  it("editar a descrição de um filho (em markdown) e salvar", async () => {
    const { client } = setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    await userEvent.click(within(partItems()[0]!).getByRole("button", { name: "Editar descrição" }));
    const field = within(partItems()[0]!).getByRole("textbox", { name: "Descrição da parte 1" });
    await userEvent.clear(field);
    await userEvent.type(field, "Texto novo");
    await userEvent.click(within(partItems()[0]!).getByRole("button", { name: "Concluir descrição" }));
    await save();
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", expect.objectContaining({ children: [{ title: "Interface de chat", description: "Texto novo" }, FILHOS[1], FILHOS[2]] })));
  });

  it("tirar um filho (sem confirmar) e salvar manda a lista sem ele; o contador cai na hora", async () => {
    const { client } = setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    await userEvent.click(screen.getByRole("button", { name: "Tirar «Branch por ticket»" }));
    expect(partItems()).toHaveLength(2);
    expect(screen.getByText("2 partes")).toBeInTheDocument();
    await save();
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", expect.objectContaining({ children: [FILHOS[0], FILHOS[2]] })));
  });

  it("tirar o último filho manda a lista vazia, que tira todos", async () => {
    const { client } = setup({ children: [child("Só uma")] });
    await screen.findByRole("list", { name: "Partes do ticket" });
    await userEvent.click(screen.getByRole("button", { name: "Tirar «Só uma»" }));
    await save();
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", { title: "Chat no painel", description: "Organizado pela IA.", children: [] }));
  });

  it("descer e subir pelo mouse trocam a ordem; o PATCH leva a ordem nova", async () => {
    const { client } = setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    await userEvent.click(screen.getByRole("button", { name: "Descer «Interface de chat»" }));
    expect(within(partItems()[1]!).getByRole("textbox", { name: "Título da parte 2" })).toHaveValue("Interface de chat");
    await userEvent.click(screen.getByRole("button", { name: "Subir «Histórico de conversas»" }));
    await save();
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", expect.objectContaining({ children: [FILHOS[1], FILHOS[2], FILHOS[0]] })));
  });

  it("subir e descer funcionam pelo teclado, e o foco acompanha a parte que se mexeu", async () => {
    setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    const down = screen.getByRole("button", { name: "Descer «Interface de chat»" });
    down.focus();
    await userEvent.keyboard("{Enter}");
    expect(partItems().map((item) => within(item).getByRole<HTMLInputElement>("textbox", { name: /Título da parte/ }).value)).toEqual(["Branch por ticket", "Interface de chat", "Histórico de conversas"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Descer «Interface de chat»" })).toHaveFocus());
    await userEvent.keyboard(" ");
    await waitFor(() => expect(screen.getByRole("button", { name: "Descer «Interface de chat»" })).toBeDisabled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Subir «Interface de chat»" })).toHaveFocus());
  });

  it("a primeira não sobe e a última não desce", async () => {
    setup({ children: FILHOS });
    await screen.findByRole("list", { name: "Partes do ticket" });
    expect(screen.getByRole("button", { name: "Subir «Interface de chat»" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Descer «Histórico de conversas»" })).toBeDisabled();
  });

  it("a procura do lugar continua sendo uma vez, para o pai, e diz que as partes nascem dentro do ticket", async () => {
    const { client } = setup({ children: FILHOS });
    await search();
    expect(await screen.findByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("As 3 partes nascem dentro do ticket");
    expect(client.findPlacement).toHaveBeenCalledTimes(1);
  });

  it("o botão de criar diz o que vai acontecer", async () => {
    setup({ children: FILHOS });
    await search();
    expect(await screen.findByRole("button", { name: "Criar ticket e 3 partes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Criar aqui" })).toBeNull();
  });

  it("depois de criar abre o pai e recarrega o mapa", async () => {
    const { client, props } = setup({ children: FILHOS });
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar ticket e 3 partes" }));
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1", placedBy: "search" }));
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("os textos dos filhos aparecem nos três idiomas", async () => {
    await setTestLanguage("en");
    setup({ children: FILHOS });
    expect(await screen.findByRole("list", { name: "Ticket parts" })).toBeInTheDocument();
    expect(screen.getByText("3 parts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move “Interface de chat” down" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Original request" })).toBeInTheDocument();
  });
});

describe("avisos da prévia", () => {
  it("chave inexistente: avisa com as chaves e desabilita o criar", async () => {
    setup({ children: FILHOS, preview: preview({ children: FILHOS, unknownKeys: ["ALFA-77", "ALFA-78"] }) });
    await search();
    const alert = await screen.findByText(/O rascunho cita tickets que não existem: ALFA-77, ALFA-78/);
    expect(alert).toHaveAttribute("role", "alert");
    expect(await screen.findByRole("button", { name: "Criar ticket e 3 partes" })).toBeDisabled();
  });

  it("o aviso aparece junto do rascunho, antes de procurar o lugar, e some quando a prévia limpa", async () => {
    const getConversationPreview = vi.fn()
      .mockResolvedValueOnce(ok(preview({ unknownKeys: ["ALFA-77"] })))
      .mockResolvedValue(ok(preview()));
    setup({ extra: { getConversationPreview } });
    expect(await screen.findByText(/não existem: ALFA-77/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Título" }), "!");
    await save();
    await waitFor(() => expect(screen.queryByText(/não existem/)).toBeNull());
  });

  it("descrição longa demais: pede para encurtar a descrição do pai e desabilita o criar", async () => {
    setup({ preview: preview({ descriptionTooLong: true }) });
    expect(await screen.findByText(/Encurte a descrição para criar/)).toHaveAttribute("role", "alert");
    await search();
    expect(await screen.findByRole("button", { name: "Criar aqui" })).toBeDisabled();
  });
});

describe("erros novos da criação", () => {
  const create = async (error: ReturnType<typeof failed>) => {
    const out = setup({ children: FILHOS, extra: { createTicketFromConversation: vi.fn(async () => error) } });
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar ticket e 3 partes" }));
    return out;
  };

  it("unknown_ticket_keys lista as chaves", async () => {
    const { props } = await create(failed("conflict", "unknown_ticket_keys", ["ALFA-77"]));
    expect(await screen.findByText("O rascunho cita tickets que não existem: ALFA-77.")).toHaveAttribute("role", "alert");
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it("description_too_long pede para encurtar a descrição do pai", async () => {
    await create(failed("conflict", "description_too_long"));
    expect(await screen.findByText(/Peça ao assistente para encurtar a descrição do ticket pai/)).toBeInTheDocument();
  });

  it("request_too_long pede para dividir o pedido em conversas menores", async () => {
    await create(failed("conflict", "request_too_long"));
    expect(await screen.findByText(/Divida o pedido em conversas menores/)).toBeInTheDocument();
  });

  it("nenhum deles vira o erro genérico de conflito", async () => {
    await create(failed("conflict", "request_too_long"));
    await screen.findByRole("alert");
    expect(screen.queryByText(/conflita com o estado atual/)).toBeNull();
  });
});

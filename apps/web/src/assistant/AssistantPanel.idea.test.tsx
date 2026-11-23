import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, DraftPreview } from "../api/client.js";
import { setTestLanguage } from "../test/i18n.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";

/** Registrar o rascunho como ideia pela conversa (ADR 0044, adendo; TREEPM-242). */
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" }),
    makeTicket("t5", "p1", 5, "Ideia mãe", { key: "ALFA-5", idea: { root: true, stage: "new" } }),
    makeTicket("t6", "p1", 6, "Dentro da ideia", { key: "ALFA-6", parentId: "t5", idea: { root: false, rootId: "t5", rootKey: "ALFA-5" } }),
  ],
};
const child = (title: string) => ({ title, description: "" });
const FILHOS = ["Menu", "Filtros", "Modo standup"].map(child);

function setup(options: { idea?: boolean; children?: { title: string; description: string }[]; destination?: { parentId: string | null; path: { id: string; title: string }[] } } = {}) {
  const children = options.children ?? [];
  const conversation = (id: string, idea = options.idea ?? false, kids = children) => makeConversation(id, "p1", { draft: { title: "Botão play", description: "Organizado.", children: kids, idea } });
  const preview: DraftPreview = { title: "Botão play", description: "x", quote: "", children, idea: options.idea ?? false, unknownKeys: [], descriptionTooLong: false };
  const client = makeClient({ projects: [alfa] });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation("c1"), messages: undefined }])),
    getConversation: vi.fn(async (id: string) => ok(conversation(id))),
    getConversationPreview: vi.fn(async () => ok(preview)),
    updateConversationDraft: vi.fn(async (id: string, body: { title: string; description: string; idea?: boolean; children?: { title: string; description: string }[] }) =>
      ok(makeConversation(id, "p1", { draft: { title: body.title, description: body.description, children: body.children ?? children, idea: body.idea ?? options.idea ?? false } }))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: options.destination ?? { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] } }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({
      conversation: makeConversation(id, "p1", { status: "ticket_created" }),
      ticket: { ...makeTicket("t9", "p1", 9, "Botão play", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" },
      children: [],
        warnings: [],
    })),
  } as Partial<Record<keyof ApiClient, unknown>>);
  const props = {
    client, projects: [alfa], initialProjectId: "p1", tickets, expanded: true, resume: true,
    onCollapse: vi.fn(), onProgress: vi.fn(), onCreated: vi.fn(), onManualCreate: vi.fn(), onDraftChange: vi.fn(), onChanged: vi.fn(), registerPicker: vi.fn(),
  };
  render(<AssistantPanel {...props} />);
  return { client, props };
}
const option = () => screen.findByRole("checkbox", { name: "Registrar como ideia" });
const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));

describe("a opção «Registrar como ideia»", () => {
  it("aparece na folha do rascunho, desligada por padrão e ligada quando o rascunho é ideia", async () => {
    setup();
    expect(await option()).not.toBeChecked();
  });

  it("vem ligada quando a IA ligou idea", async () => {
    setup({ idea: true });
    expect(await option()).toBeChecked();
  });

  it("liga e desliga pelo teclado (Tab e Espaço)", async () => {
    setup();
    const box = await option();
    box.focus();
    await userEvent.keyboard(" ");
    expect(box).toBeChecked();
    await userEvent.keyboard(" ");
    expect(box).not.toBeChecked();
  });

  it("mudar a opção é uma edição do rascunho: aparece «Salvar rascunho» e o PATCH leva idea, com os filhos", async () => {
    const { client } = setup({ children: FILHOS });
    await userEvent.click(await option());
    await userEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));
    await waitFor(() => expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", expect.objectContaining({ title: "Botão play", idea: true, children: FILHOS })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Salvar rascunho" })).toBeNull());
    expect(await option()).toBeChecked();
  });

  it("voltar ao valor salvo desfaz a edição", async () => {
    setup();
    const box = await option();
    await userEvent.click(box);
    expect(screen.getByRole("button", { name: "Salvar rascunho" })).toBeInTheDocument();
    await userEvent.click(box);
    expect(screen.queryByRole("button", { name: "Salvar rascunho" })).toBeNull();
  });

  it("some quando o lugar encontrado está dentro de uma ideia", async () => {
    setup({ idea: true, destination: { parentId: "t6", path: [{ id: "t5", title: "Ideia mãe" }, { id: "t6", title: "Dentro da ideia" }] } });
    await option();
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Registrar como ideia" })).toBeNull());
    // O que nasce ali já é parte da ideia: o botão volta a ser o de criar.
    expect(screen.getByRole("button", { name: "Criar aqui" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar ideia aqui" })).toBeNull();
  });

  it("volta quando a pessoa sobe para fora da ideia", async () => {
    setup({ destination: { parentId: "t6", path: [{ id: "t6", title: "Dentro da ideia" }] } });
    await option();
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(screen.queryByRole("checkbox", { name: "Registrar como ideia" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Um nível acima" }));
    expect(await option()).toBeInTheDocument();
  });
});

describe("criar como ideia", () => {
  it("o botão e o card do caminho dizem que é ideia; sem partes: «Registrar ideia aqui»", async () => {
    setup({ idea: true });
    await option();
    await search();
    const card = await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(within(card).getByRole("button", { name: "Registrar ideia aqui" })).toBeInTheDocument();
    expect(within(card).getByText("Ideia nova: Botão play")).toBeInTheDocument();
    expect(within(card).queryByText("Ticket novo: Botão play")).toBeNull();
    expect(within(card).getByText(/Entra como ideia no estágio «Nova»/)).toBeInTheDocument();
  });

  it("com partes: «Registrar ideia e 3 partes»", async () => {
    setup({ idea: true, children: FILHOS });
    await option();
    await search();
    expect(await screen.findByRole("button", { name: "Registrar ideia e 3 partes" })).toBeInTheDocument();
  });

  it("sem a opção, nada muda: «Criar aqui» e «Ticket novo»", async () => {
    setup();
    await option();
    await search();
    const card = await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(within(card).getByRole("button", { name: "Criar aqui" })).toBeInTheDocument();
    expect(within(card).getByText("Ticket novo: Botão play")).toBeInTheDocument();
    expect(within(card).queryByText(/Entra como ideia/)).toBeNull();
  });

  it("ligar a opção depois de achar o lugar muda o botão na hora e a criação salva a opção antes de criar; depois abre a ideia", async () => {
    const { client, props } = setup();
    await search();
    await screen.findByRole("region", { name: "Caminho encontrado" });
    await userEvent.click(await option());
    await userEvent.click(screen.getByRole("button", { name: "Registrar ideia aqui" }));
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("t9"));
    expect(client.updateConversationDraft).toHaveBeenCalledWith("c1", expect.objectContaining({ idea: true }));
    expect(client.createTicketFromConversation).toHaveBeenCalledWith("c1", { parentId: "t1" });
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("a opção fica desabilitada enquanto algo está sendo salvo ou criado", async () => {
    const { client } = setup({ idea: true });
    Object.assign(client, { createTicketFromConversation: vi.fn(() => new Promise(() => undefined)) });
    await option();
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Registrar ideia aqui" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Registrar como ideia" })).toBeDisabled());
  });
});

describe("idiomas", () => {
  it.each([
    ["en", "Register as an idea", "Register idea here", [], "Find the place", "New idea: Botão play"],
    ["en", "Register as an idea", "Register idea and 3 parts", FILHOS, "Find the place", "New idea: Botão play"],
    ["es-MX", "Registrar como idea", "Registrar idea aquí", [], "Buscar el lugar", "Idea nueva: Botão play"],
    ["es-MX", "Registrar como idea", "Registrar idea y 3 partes", FILHOS, "Buscar el lugar", "Idea nueva: Botão play"],
  ] as const)("%s: opção, botão e card vêm do catálogo (%s, %s)", async (language, label, button, kids, find, step) => {
    await setTestLanguage(language);
    try {
      setup({ idea: true, children: [...kids] });
      expect(await screen.findByRole("checkbox", { name: label })).toBeChecked();
      await userEvent.click(await screen.findByRole("button", { name: find }));
      expect(await screen.findByRole("button", { name: button })).toBeInTheDocument();
      expect(screen.getByText(step)).toBeInTheDocument();
    } finally {
      await setTestLanguage("pt-BR");
    }
  });
});

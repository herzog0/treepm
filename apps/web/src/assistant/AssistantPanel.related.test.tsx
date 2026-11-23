import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementOutcome } from "../api/client.js";
import { setTestLanguage } from "../test/i18n.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";

/** Tickets relacionados e aviso de duplicado na prévia da conversa (ADR 0052, fatia 2; TREEPM-328). */
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets = { p1: [makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" })] };
const related = [
  { id: "t7", key: "ALFA-7", title: "Importar de GitHub, Jira e Linear", status: "todo", path: [{ id: "t1", title: "Acesso" }] },
  { id: "t8", key: "ALFA-8", title: "Guardar a origem de cada ticket", status: "doing", path: [] },
];
const outcome = (extra: Partial<PlacementOutcome> = {}) => makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] }, ...extra });

function setup(placement: PlacementOutcome) {
  const client = makeClient({ projects: [alfa] });
  const conversation = makeConversation("c1", "p1", { draft: { title: "Sincronizar tickets", description: "Receber o diff", children: [] } });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    getConversationPreview: vi.fn(async () => ok({ title: "Sincronizar tickets", description: "Receber o diff", quote: "", children: [], idea: false, unknownKeys: [], descriptionTooLong: false })),
    findPlacement: vi.fn(async () => ok(placement)),
    createTicketFromConversation: vi.fn(async (id: string) =>
      ok({
        conversation: makeConversation(id, "p1", { status: "ticket_created" }),
        ticket: { ...makeTicket("t9", "p1", 9, "Sincronizar tickets", { key: "ALFA-9" }), description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "x", createdAt: "x", updatedAt: "y" },
        children: [],
      })),
  });
  const props = {
    client, projects: [alfa], initialProjectId: "p1", tickets, expanded: true, resume: true,
    onCollapse: vi.fn(), onProgress: vi.fn(), onCreated: vi.fn(), onOpenExisting: vi.fn(), onManualCreate: vi.fn(), onDraftChange: vi.fn(), onChanged: vi.fn(), registerPicker: vi.fn(),
  };
  render(<AssistantPanel {...props} />);
  return { client, props };
}
const search = async () => userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
const createButton = () => screen.getByRole("button", { name: "Criar aqui" });

beforeEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("aviso de duplicado", () => {
  const duplicate = { id: "t7", key: "ALFA-7", title: "Importar de GitHub, Jira e Linear", status: "done" };

  it("avisa antes do botão de criar e bloqueia criar até a pessoa escolher", async () => {
    setup(outcome({ related, duplicate }));
    await search();
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Já existe um ticket que parece ser este pedido: ALFA-7 Importar de GitHub, Jira e Linear");
    expect(notice).toHaveTextContent("Concluído");
    expect(screen.getByRole("button", { name: "Abrir o ticket" })).toBeInTheDocument();
    expect(within(notice).queryByRole("button")).toBeNull(); // só o parágrafo é anunciado; os botões ficam fora
    expect(createButton()).toBeDisabled();
    expect(notice.closest(".assistant-duplicate")!.compareDocumentPosition(createButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("\"Criar mesmo assim\" libera o botão de criar e esconde o aviso", async () => {
    const { client } = setup(outcome({ related, duplicate }));
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar mesmo assim" }));
    expect(screen.queryByRole("alert", { name: /Já existe/ })).toBeNull();
    expect(createButton()).toBeEnabled();
    await waitFor(() => expect(createButton()).toHaveFocus());
    await userEvent.click(createButton());
    await waitFor(() => expect(client.createTicketFromConversation).toHaveBeenCalled());
  });

  it("\"Abrir o ticket\" abre o duplicado e não cria nada", async () => {
    const { client, props } = setup(outcome({ related, duplicate }));
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Abrir o ticket" }));
    expect(props.onOpenExisting).toHaveBeenCalledWith("t7");
    expect(props.onCreated).not.toHaveBeenCalled(); // o painel do assistente não fecha
    expect(screen.getByRole("button", { name: "Criar aqui" })).toBeDisabled();
    expect(client.createTicketFromConversation).not.toHaveBeenCalled();
  });

  it("procurar de novo pede a escolha de novo", async () => {
    setup(outcome({ related, duplicate }));
    await search();
    await userEvent.click(await screen.findByRole("button", { name: "Criar mesmo assim" }));
    expect(createButton()).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Procurar de novo" }));
    await screen.findByRole("alert");
    expect(createButton()).toBeDisabled();
  });

  it("sem duplicado não há aviso e criar não é bloqueado", async () => {
    setup(outcome({ related }));
    await search();
    await screen.findByRole("button", { name: "Criar aqui" });
    expect(screen.queryByRole("button", { name: "Abrir o ticket" })).toBeNull();
    expect(createButton()).toBeEnabled();
  });

  it("o foco vai para o aviso quando ele aparece, e o aviso é anunciado", async () => {
    setup(outcome({ related, duplicate }));
    await search();
    const notice = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(notice.closest(".assistant-duplicate")));
  });
});

describe("tickets relacionados", () => {
  it("lista com chave e título, cada um abrindo o ticket", async () => {
    const { props } = setup(outcome({ related }));
    await search();
    const region = await screen.findByRole("region", { name: "Relacionados" });
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("ALFA-7");
    expect(items[0]).toHaveTextContent("Importar de GitHub, Jira e Linear");
    await userEvent.click(within(items[1]!).getByRole("button", { name: /ALFA-8/ }));
    expect(props.onOpenExisting).toHaveBeenCalledWith("t8");
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it("sem relacionados a lista não aparece", async () => {
    setup(outcome());
    await search();
    await screen.findByRole("button", { name: "Criar aqui" });
    expect(screen.queryByRole("region", { name: "Relacionados" })).toBeNull();
  });

  it("uma API antiga, sem os campos, continua funcionando", async () => {
    const legacy = makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] } });
    delete (legacy as Partial<PlacementOutcome>).related;
    delete (legacy as Partial<PlacementOutcome>).duplicate;
    setup(legacy);
    await search();
    expect(await screen.findByRole("button", { name: "Criar aqui" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Relacionados" })).toBeNull();
  });
});

describe("três idiomas", () => {
  it.each([
    ["en", "A ticket that looks like this request already exists: ALFA-7", "Open the ticket", "Create anyway", "Related"],
    ["es-MX", "Ya existe un ticket que parece ser este pedido: ALFA-7", "Abrir el ticket", "Crear de todos modos", "Relacionados"],
  ] as const)("%s", async (language, warning, open, anyway, heading) => {
    await setTestLanguage(language);
    setup(outcome({ related, duplicate: { id: "t7", key: "ALFA-7", title: "Importar", status: "todo" } }));
    await userEvent.click(await screen.findByRole("button", { name: /^(Find the place|Buscar el lugar|Procurar o lugar)/ }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(warning);
    expect(screen.getByRole("button", { name: open })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: anyway })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: heading })).toBeInTheDocument();
  });
});

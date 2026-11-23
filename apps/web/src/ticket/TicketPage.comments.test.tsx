import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ActivityPage, ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0040, fatia 2: os comentários na seção "Atividade". O que depende de digitar no editor de verdade fica na suíte de navegador.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Outro ticket", { key: "ALFA-2" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno", avatarUrl: null };
const NOW = new Date("2026-11-22T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
let counter = 0;
type Comment = Extract<ActivityEntry, { type: "comment" }>;
const comment = (data: Partial<Comment> = {}): Comment => ({
  id: `c${++counter}`, type: "comment", occurredAt: at(5), actor: ana, body: "Texto do comentário", editedAt: null, removed: false, canEdit: false, canRemove: false, area: null, ...data,
});
const page = (entries: ActivityEntry[], canComment = false): ActivityPage => ({ entries, before: null, canComment });

function setup(entries: ActivityEntry[], options: { canComment?: boolean; archived?: boolean; reader?: boolean } = {}) {
  const proj = options.archived ? makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project;
  const client = makeClient({ projects: [proj], people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")], tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    ticketActivity: vi.fn(async () => ok(page(entries, options.canComment ?? false))),
    createTicketComment: vi.fn(async () => failed("unavailable")),
    updateComment: vi.fn(async () => failed("unavailable")),
    removeComment: vi.fn(async () => failed("unavailable")),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe(options.reader ? "member" : "admin")} projects={[proj]} ticketId="t1" creating={null} {...handlers} />);
  return { client: client as ApiClient & Record<"createTicketComment" | "updateComment" | "removeComment", ReturnType<typeof vi.fn>>, ...handlers };
}
const section = () => screen.findByRole("region", { name: "Atividade" });
const blocks = async () => {
  const region = await section();
  await waitFor(() => expect(region.querySelector(".ticket-activity-comment")).not.toBeNull());
  return Array.from(region.querySelectorAll<HTMLElement>(".ticket-activity-comment"));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  await setTestLanguage("pt-BR");
});

describe("comentário na lista", () => {
  it("é um bloco com o autor, a data e o corpo desenhado como markdown", async () => {
    setup([comment({ body: "Veja **isto** e `aquilo`", actor: bruno, occurredAt: at(90) })]);
    const [block] = await blocks();
    expect(block).toBeDefined();
    expect(within(block!).getByText("Bruno")).toBeInTheDocument();
    expect(block!.querySelector("time")).toHaveAttribute("datetime", at(90));
    expect(await within(block!).findByText("isto", { selector: "strong" })).toBeInTheDocument();
    expect(block!.querySelector("code")).toHaveTextContent("aquilo");
    expect(block!.querySelector(".ticket-avatar")).toBeInTheDocument();
    expect(block!.textContent).not.toContain("editado");
  });

  it("não deixa o corpo ser editado no próprio texto: a leitura é só leitura", async () => {
    setup([comment({ canEdit: true, canRemove: true })]);
    const [block] = await blocks();
    await within(block!).findByText("Texto do comentário");
    expect(block!.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it("mostra «editado» só quando houve edição", async () => {
    // A API entrega da mais nova para a mais antiga; a tela inverte.
    setup([comment({ body: "Outro", editedAt: null }), comment({ editedAt: at(1) })]);
    const [first, second] = await blocks();
    expect(within(first!).getByText("editado")).toBeInTheDocument();
    expect(within(second!).queryByText("editado")).toBeNull();
  });

  it("a chave de um ticket do projeto vira a etiqueta clicável da descrição, e abre o ticket", async () => {
    const view = setup([comment({ body: "Depende de ALFA-2 para sair." })]);
    const [block] = await blocks();
    const mention = await within(block!).findByRole("link", { name: /ALFA-2 Outro ticket/ });
    fireEvent.click(mention);
    expect(view.onOpenTicket).toHaveBeenCalledWith("t2");
  });

  it("removido: «Comentário removido» com autor e data, sem corpo e sem ações", async () => {
    setup([comment({ body: null, removed: true, canEdit: false, canRemove: false, actor: bruno })]);
    const [block] = await blocks();
    expect(within(block!).getByText("Comentário removido")).toBeInTheDocument();
    expect(within(block!).getByText("Bruno")).toBeInTheDocument();
    expect(block!.querySelector("time")).toBeInTheDocument();
    expect(within(block!).queryByRole("button")).toBeNull();
    expect(block!.querySelector(".tiptap")).toBeNull();
  });

  it("autor sem nome (pessoa que saiu do diretório) não derruba a lista", async () => {
    setup([comment({ actor: null })]);
    const [block] = await blocks();
    expect(block).toBeDefined();
    expect(await within(block!).findByText("Texto do comentário")).toBeInTheDocument();
  });

  it("mistura comentários e mudanças na ordem da API (do mais antigo para o mais novo na tela)", async () => {
    setup([
      comment({ body: "Segundo", occurredAt: at(2) }),
      { id: "e1", type: "title_changed", occurredAt: at(3), actor: ana, from: "a", to: "b" },
      comment({ body: "Primeiro", occurredAt: at(4) }),
    ]);
    const items = await within(await section()).findAllByRole("listitem");
    expect(items.map((item) => (item.classList.contains("ticket-activity-comment") ? "comment" : "change"))).toEqual(["comment", "change", "comment"]);
    await within(items[0]!).findByText("Primeiro");
    await within(items[2]!).findByText("Segundo");
  });
});

describe("ações do comentário conforme a permissão", () => {
  it.each([
    ["só editar", { canEdit: true, canRemove: false }, ["Editar"]],
    ["só remover", { canEdit: false, canRemove: true }, ["Remover"]],
    ["as duas", { canEdit: true, canRemove: true }, ["Editar", "Remover"]],
    ["nenhuma", { canEdit: false, canRemove: false }, []],
  ])("%s", async (_name, rights, expected) => {
    setup([comment(rights)]);
    const [block] = await blocks();
    await within(block!).findByText("Texto do comentário");
    expect(within(block!).queryAllByRole("button").map((button) => button.textContent)).toEqual(expected);
  });

  it("Remover pede confirmação; confirmar chama a API e o comentário vira «Comentário removido»", async () => {
    const entry = comment({ canEdit: true, canRemove: true, body: "Vai sumir" });
    const view = setup([entry]);
    view.client.removeComment.mockResolvedValue(ok(undefined));
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const [block] = await blocks();
    await user.click(await within(block!).findByRole("button", { name: "Remover" }));
    expect(view.client.removeComment).not.toHaveBeenCalled();
    expect(within(block!).getByText(/não pode ser desfeito/i)).toBeInTheDocument();
    await user.click(within(block!).getByRole("button", { name: /Confirmar/ }));
    expect(view.client.removeComment).toHaveBeenCalledWith(entry.id);
    expect(await within(block!).findByText("Comentário removido")).toBeInTheDocument();
    expect(within(block!).queryByText("Vai sumir")).toBeNull();
    expect(within(block!).queryByRole("button")).toBeNull();
  });

  it("cancelar a confirmação não chama a API", async () => {
    const view = setup([comment({ canRemove: true })]);
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const [block] = await blocks();
    await user.click(await within(block!).findByRole("button", { name: "Remover" }));
    await user.click(within(block!).getByRole("button", { name: "Cancelar" }));
    expect(view.client.removeComment).not.toHaveBeenCalled();
    expect(within(block!).getByRole("button", { name: "Remover" })).toBeInTheDocument();
  });

  it("erro ao remover mostra a mensagem e mantém o comentário", async () => {
    const view = setup([comment({ canRemove: true, body: "Fica" })]);
    view.client.removeComment.mockResolvedValue(failed("forbidden"));
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const [block] = await blocks();
    await user.click(await within(block!).findByRole("button", { name: "Remover" }));
    await user.click(within(block!).getByRole("button", { name: /Confirmar/ }));
    expect(await within(block!).findByRole("alert")).toBeInTheDocument();
    expect(within(block!).getByText("Fica")).toBeInTheDocument();
  });
});

describe("campo para escrever", () => {
  it("quem pode comentar vê o campo com «Escreva um comentário» e o botão «Comentar», desligado enquanto vazio", async () => {
    setup([comment()], { canComment: true });
    const field = await screen.findByRole("textbox", { name: "Novo comentário" });
    expect(field).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.ticket-comment-composer .is-empty[data-placeholder="Escreva um comentário"]')).not.toBeNull());
    expect(screen.getByRole("button", { name: "Comentar" })).toBeDisabled();
  });

  it("o campo vem depois da lista, no fim da seção", async () => {
    setup([comment()], { canComment: true });
    const field = await screen.findByRole("textbox", { name: "Novo comentário" });
    const list = within(await section()).getByRole("list", { name: "Atividade do ticket" });
    expect(list.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("quem só lê o projeto (canComment verdadeiro, ADR 0040 adendo) vê o campo e as ações do próprio comentário, e só elas", async () => {
    const view = setup([comment({ canEdit: true, canRemove: true }), comment({ body: "Do colega", canEdit: false, canRemove: false })], { canComment: true, reader: true });
    const [theirs, mine] = await blocks();
    expect(await screen.findByRole("textbox", { name: "Novo comentário" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comentar" })).toBeDisabled();
    expect(within(mine!).getAllByRole("button").map((button) => button.textContent)).toEqual(["Editar", "Remover"]);
    expect(within(theirs!).queryByRole("button")).toBeNull();
    expect(view.client.createTicketComment).not.toHaveBeenCalled();
    // O resto da página continua só leitura para ele: nenhum campo editável fora do de comentar.
    expect(screen.queryByRole("button", { name: /Excluir|Mover|Concluir/ })).toBeNull();
  });

  it("leitor (canComment falso) lê os comentários, sem o campo e sem ações", async () => {
    setup([comment({ canEdit: false, canRemove: false })], { canComment: false, reader: true });
    const [block] = await blocks();
    await within(block!).findByText("Texto do comentário");
    expect(screen.queryByRole("textbox", { name: "Novo comentário" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Comentar" })).toBeNull();
    expect(within(block!).queryByRole("button")).toBeNull();
  });

  it("projeto arquivado: sem o campo e sem ações", async () => {
    setup([comment()], { archived: true, canComment: false });
    const [block] = await blocks();
    await within(block!).findByText("Texto do comentário");
    expect(screen.queryByRole("textbox", { name: "Novo comentário" })).toBeNull();
    expect(within(block!).queryByRole("button")).toBeNull();
  });

  it("o campo de comentário não oferece «Pedir ao assistente para escrever»", async () => {
    setup([comment()], { canComment: true });
    await screen.findByRole("textbox", { name: "Novo comentário" });
    expect(screen.queryByText(/assistente para escrever/i)).toBeNull();
  });

  it("o comentário não salva sozinho: nada é chamado só por abrir a página, e nada vai ao armazenamento do navegador", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem");
    const view = setup([comment()], { canComment: true });
    await screen.findByRole("textbox", { name: "Novo comentário" });
    expect(view.client.createTicketComment).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("textos nos três idiomas", () => {
  it.each([
    ["pt-BR", { region: "Atividade", edited: "editado", edit: "Editar", remove: "Remover", removed: "Comentário removido", field: "Novo comentário", send: "Comentar" }],
    ["en", { region: "Activity", edited: "edited", edit: "Edit", remove: "Remove", removed: "Comment removed", field: "New comment", send: "Comment" }],
    ["es-MX", { region: "Actividad", edited: "editado", edit: "Editar", remove: "Eliminar", removed: "Comentario eliminado", field: "Nuevo comentario", send: "Comentar" }],
  ] as const)("%s", async (language, words) => {
    await setTestLanguage(language);
    setup([comment({ body: null, removed: true }), comment({ canEdit: true, canRemove: true, editedAt: at(1) })], { canComment: true });
    const region = await screen.findByRole("region", { name: words.region });
    await waitFor(() => expect(region.querySelectorAll(".ticket-activity-comment")).toHaveLength(2));
    const [live, gone] = Array.from(region.querySelectorAll<HTMLElement>(".ticket-activity-comment"));
    expect(within(live!).getByText(words.edited)).toBeInTheDocument();
    expect(within(live!).getByRole("button", { name: words.edit })).toBeInTheDocument();
    expect(within(live!).getByRole("button", { name: words.remove })).toBeInTheDocument();
    expect(within(gone!).getByText(words.removed)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: words.field })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: words.send })).toBeInTheDocument();
    await waitFor(() => expect(region.querySelector(".tiptap")).not.toBeNull());
  });
});

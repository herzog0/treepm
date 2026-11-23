import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

/** A conversa de novo ticket dentro da barra de pedidos (ADR 0036, fatia 3). */
// Prazo dos testes que montam o mapa inteiro: 2-4 s com a máquina em uso normal, e mais de 8 s com ela saturada (TREEPM-101).
const SLOW = 20_000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", status: "todo" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "todo" }),
  ],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const manager = () => withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]));

const created = makeTicket("t9", "p1", 9, "Corrigir o login", { key: "ALFA-9", parentId: "t1" });
function makeFullClient(extra: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const client = makeClient({ projects, tickets, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf([...tickets.p1!, created].find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c1", projectId))),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Acesso" }] } }))),
    createTicketFromConversation: vi.fn(async (id: string) => ok({ conversation: makeConversation(id, "p1", { status: "ticket_created" }), ticket: detailOf(created), children: [], warnings: [] })),
    ...extra,
  });
  return client;
}

function Host({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const bar = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" });
const sheet = () => screen.queryByRole("region", { name: "Novo ticket com o assistente" });
const message = () => screen.findByRole("textbox", { name: "Mensagem para o assistente" });
/** O texto da resposta também vai para a região viva; as buscas de mensagem olham só a lista. */
const thread = () => within(sheet()!.querySelector<HTMLElement>(".assistant-scroll")!);
const inProgress = () => screen.queryByRole("button", { name: "Conversa em andamento" });
async function node(name: RegExp) {
  const found = await screen.findByRole("button", { name }, { timeout: SLOW });
  await waitFor(() => expect(found).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
  return found;
}
async function exploreAlfa() {
  await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
  await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
}
/** Digita na barra e aperta Ctrl+Enter: "Criar ticket «texto»". */
async function createFromBar(text: string) {
  const field = await bar();
  await userEvent.click(field);
  await userEvent.type(field, text);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
}
/** Abre a conversa, manda uma mensagem e procura o lugar: o rascunho e o caminho aparecem. */
async function placed(text = "O login quebra") {
  await createFromBar(text);
  await userEvent.click(await screen.findByRole("button", { name: "Procurar o lugar" }));
  await screen.findByRole("region", { name: "Caminho encontrado" });
}

describe("the conversation lives in the bar", () => {
  it("'Criar ticket' opens the conversation sheet: no side panel and no floating button on the map", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await createFromBar("exportar csv");
    expect(await screen.findByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "exportar csv", scopeId: null }));
    expect(document.querySelector("aside.assistant-panel")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Novo ticket com o assistente" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Novo ticket" })).not.toBeInTheDocument();
    expect(document.querySelector(".map-new-ticket")).toBeNull();
    expect(document.querySelector(".has-assistant")).toBeNull();
    // A sheet mora dentro da barra, com o mesmo corpo da conversa de antes.
    expect(screen.getByRole("region", { name: "Barra de pedidos" })).toContainElement(sheet());
    expect(await message()).toBeInTheDocument();
  }, SLOW);

  it("the top row carries the conversation name, the project, 'Nova conversa', 'Apagar conversa' and 'Recolher'; the field comes back when it folds", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    const region = await screen.findByRole("region", { name: "Novo ticket com o assistente" });
    const top = screen.getByRole("region", { name: "Barra de pedidos" });
    await within(region.querySelector<HTMLElement>(".assistant-scroll")!).findByText("Entendi. Isso acontece em todas as versões?");
    expect(top).toHaveTextContent("Novo ticket");
    expect(top).toHaveTextContent("ALFA · Projeto Alfa");
    expect(within(top).getByRole("button", { name: "Nova conversa" })).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "Apagar conversa" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Peça qualquer coisa" })).not.toBeInTheDocument();
    await userEvent.click(within(top).getByRole("button", { name: "Recolher" }));
    expect(sheet()).not.toBeInTheDocument();
    expect(await bar()).toBeInTheDocument();
  }, SLOW);

  it("without the assistant, 'Criar ticket' still opens manual creation and the bar offers no conversation", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }]), false)} />);
    await createFromBar("exportar csv");
    expect(await screen.findByDisplayValue("exportar csv")).toBeInTheDocument();
    expect(sheet()).not.toBeInTheDocument();
    await userEvent.click(await bar());
    expect(screen.queryByRole("option", { name: /Nova conversa/ })).not.toBeInTheDocument();
  }, SLOW);
});

describe("an empty field with the focus in the bar", () => {
  it("without an earlier conversation, offers only 'Nova conversa', which opens an empty conversation", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await userEvent.click(await bar());
    expect(await screen.findByRole("option", { name: /Nova conversa/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Continuar conversa/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: /Nova conversa/ }));
    expect(await message()).toBeInTheDocument();
    expect(sheet()).toHaveTextContent("Descreva a tarefa.");
    expect(client.openConversation).not.toHaveBeenCalled();
  }, SLOW);

  it("with an earlier conversation, shows 'Continuar conversa' with the draft title, and opening it resumes the same conversation", async () => {
    const earlier = makeConversation("old", "p1");
    const client = makeFullClient({
      listConversations: vi.fn(async () => ok([{ ...earlier, messages: undefined }])),
      getConversation: vi.fn(async () => ok(earlier)),
    });
    render(<Host client={client} me={manager()} />);
    await userEvent.click(await bar());
    const resume = await screen.findByRole("option", { name: /Continuar conversa/ });
    expect(resume).toHaveTextContent("Corrigir o login");
    expect(screen.getByRole("option", { name: /Nova conversa/ })).toBeInTheDocument();
    await userEvent.click(resume);
    expect(await screen.findByText("O login quebra no Safari")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
    expect(client.openConversation).not.toHaveBeenCalled();
  }, SLOW);

  it("without a draft, the earlier conversation is named by the start of its first message", async () => {
    const earlier = makeConversation("old", "p1", { draft: null });
    const client = makeFullClient({
      listConversations: vi.fn(async () => ok([{ ...earlier, messages: undefined }])),
      getConversation: vi.fn(async () => ok(earlier)),
    });
    render(<Host client={client} me={manager()} />);
    await userEvent.click(await bar());
    expect(await screen.findByRole("option", { name: /Continuar conversa/ })).toHaveTextContent("O login quebra no Safari");
  }, SLOW);

  it("'Nova conversa' ignores the earlier conversation and starts empty", async () => {
    const earlier = makeConversation("old", "p1");
    const client = makeFullClient({
      listConversations: vi.fn(async () => ok([{ ...earlier, messages: undefined }])),
      getConversation: vi.fn(async () => ok(earlier)),
    });
    render(<Host client={client} me={manager()} />);
    await userEvent.click(await bar());
    await userEvent.click(await screen.findByRole("option", { name: /Nova conversa/ }));
    await message();
    expect(sheet()).toHaveTextContent("Descreva a tarefa.");
    expect(screen.queryByText("O login quebra no Safari")).not.toBeInTheDocument();
  }, SLOW);

  it("offers nothing to a person who cannot create anywhere", async () => {
    const reader = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }]));
    render(<Host client={makeFullClient()} me={reader} />);
    await userEvent.click(await bar());
    // Nenhuma ação de criar: só a navegação "Próximo ticket para trabalhar" (ADR 0047), que quem só lê também usa.
    expect(screen.queryByRole("option", { name: /conversa/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Próximo ticket para trabalhar"]);
  }, SLOW);

  it("does not highlight anything by default, so Enter does not start a conversation by accident", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await bar());
    await screen.findByRole("option", { name: /Nova conversa/ });
    await userEvent.keyboard("{Enter}");
    expect(sheet()).not.toBeInTheDocument();
  }, SLOW);
});

describe("the scope chip", () => {
  it("shows 'Dentro de CHAVE' for the selected ticket, and the × takes the scope off", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await createFromBar("exportar csv");
    const chip = await screen.findByText("Dentro de ALFA-3");
    expect(chip).toBeInTheDocument();
    await waitFor(() => expect(client.openConversation).toHaveBeenCalledWith("p1", { message: "exportar csv", scopeId: "t3" }));
    await userEvent.click(screen.getByRole("button", { name: "Tirar o escopo" }));
    expect(screen.queryByText("Dentro de ALFA-3")).not.toBeInTheDocument();
    await userEvent.type(await message(), "outra coisa{Enter}");
    await waitFor(() => expect(client.sendConversationMessage).toHaveBeenCalledWith("c1", { message: "outra coisa", scopeId: null }));
  }, SLOW);

  it("no chip when nothing is selected or a project is", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await createFromBar("exportar csv");
    await message();
    expect(screen.queryByRole("button", { name: "Tirar o escopo" })).not.toBeInTheDocument();
  }, SLOW);
});

describe("a conversation under way and the rest of the map", () => {
  it("opening a ticket folds the sheet without ending the conversation; 'Conversa em andamento' brings back the same one", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await exploreAlfa();
    await createFromBar("exportar csv");
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    const lookups = vi.mocked(client.listConversations).mock.calls.length;
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await screen.findByRole("complementary", { name: "Página do ticket" });
    expect(sheet()).not.toBeInTheDocument();
    const again = await screen.findByRole("button", { name: "Conversa em andamento" });
    await userEvent.click(again);
    expect(await screen.findByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument();
    expect(client.openConversation).toHaveBeenCalledTimes(1);
    // Reabrir não consulta a API de novo: é a mesma conversa montada, não uma conversa retomada.
    expect(vi.mocked(client.listConversations).mock.calls.length).toBe(lookups);
    expect(client.getConversation).not.toHaveBeenCalled();
    expect(inProgress()).not.toBeInTheDocument();
  }, SLOW);

  it("keeps the draft being edited while folded", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    const title = await screen.findByRole("textbox", { name: "Título" });
    await userEvent.type(title, " agora");
    await userEvent.click(screen.getByRole("button", { name: "Recolher" }));
    await userEvent.click(await screen.findByRole("button", { name: "Conversa em andamento" }));
    expect(await screen.findByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login agora");
  }, SLOW);

  it("typing in the field keeps searching tickets while the conversation is folded", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    await screen.findByRole("button", { name: "Recolher" });
    await userEvent.click(screen.getByRole("button", { name: "Recolher" }));
    const field = await bar();
    await userEvent.click(field);
    await userEvent.type(field, "publicar");
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("ALFA-3");
    expect(inProgress()).toBeInTheDocument();
  }, SLOW);

  it("folding a conversation with nothing in it ends it: no 'Conversa em andamento'", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await userEvent.click(await bar());
    await userEvent.click(await screen.findByRole("option", { name: /Nova conversa/ }));
    await message();
    await userEvent.click(screen.getByRole("button", { name: "Recolher" }));
    expect(sheet()).not.toBeInTheDocument();
    expect(inProgress()).not.toBeInTheDocument();
  }, SLOW);

  it("opening Áreas e projetos folds the sheet too, and opening the sheet does not close the areas panel", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    await message();
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    expect(sheet()).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Conversa em andamento" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Conversa em andamento" }));
    expect(await screen.findByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();
  }, SLOW);

  it("opening the sheet with the ticket page open does not close the page", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={manager()} onChange={onChange} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await screen.findByRole("complementary", { name: "Página do ticket" });
    await createFromBar("exportar csv");
    expect(await screen.findByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(null);
  }, SLOW);

  it("opening the manual creation folds the sheet", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    await message();
    await userEvent.click(screen.getByRole("button", { name: "Áreas e projetos" }));
    expect(sheet()).not.toBeInTheDocument();
  }, SLOW);

  it("ending the conversation with 'Criar aqui' removes the bar's conversation state", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Criar aqui" }));
    await screen.findByRole("heading", { level: 1, name: "Corrigir o login" });
    expect(sheet()).not.toBeInTheDocument();
    expect(inProgress()).not.toBeInTheDocument();
  }, SLOW);
});

describe("Escolher no mapa from the bar", () => {
  it("folds the sheet, tells what to do in the bar, and reopens it with the place chosen", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await exploreAlfa();
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    expect(sheet()).not.toBeInTheDocument();
    const top = screen.getByRole("region", { name: "Barra de pedidos" });
    expect(top).toHaveTextContent("Clique em um ticket ou no projeto, no mapa. Esc cancela.");
    expect(within(top).getByRole("button", { name: "Cancelar escolha" })).toBeInTheDocument();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    const path = await screen.findByRole("region", { name: "Caminho encontrado" });
    expect(path).toHaveTextContent("Publicar");
    expect(sheet()).toBeInTheDocument();
    expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
  }, SLOW);

  it("'Cancelar escolha' reopens the sheet where it was", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar escolha" }));
    expect(sheet()).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Caminho encontrado" })).toHaveTextContent("Acesso");
  }, SLOW);
});

describe("Esc, in order", () => {
  it("first cancels the choice on the map and reopens the sheet; the next Esc folds the sheet", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await placed();
    await userEvent.click(screen.getByRole("button", { name: "Escolher no mapa" }));
    expect(screen.getByText(/Clique em um ticket ou no projeto/)).toBeInTheDocument();
    screen.getByRole("region", { name: "Mapa da organização" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText(/Clique em um ticket ou no projeto/)).not.toBeInTheDocument();
    expect(sheet()).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(sheet()).not.toBeInTheDocument();
    expect(inProgress()).toBeInTheDocument();
  }, SLOW);

  it("then folds the sheet without losing the conversation, and hands the focus back to the map", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await createFromBar("exportar csv");
    await message();
    await userEvent.keyboard("{Escape}");
    expect(sheet()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.querySelector(".spatial-stage"));
    await userEvent.click(await screen.findByRole("button", { name: "Conversa em andamento" }));
    await waitFor(() => expect(thread().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument());
    expect(client.openConversation).toHaveBeenCalledTimes(1);
  }, SLOW);

  it("and only then closes the ticket page", async () => {
    const onChange = vi.fn();
    render(<Host client={makeFullClient()} me={manager()} onChange={onChange} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await screen.findByRole("complementary", { name: "Página do ticket" });
    await createFromBar("exportar csv");
    await message();
    await userEvent.keyboard("{Escape}");
    expect(sheet()).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalledWith(null);
    screen.getByRole("region", { name: "Mapa da organização" }).focus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null));
  }, SLOW);
});

describe("shortcuts", () => {
  it("with the focus in the sheet, the map shortcuts do not fire", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    const field = await message();
    const toggle = screen.getByRole("button", { name: "Cores" });
    const before = toggle.getAttribute("aria-pressed");
    await userEvent.click(field);
    await userEvent.keyboard("c");
    expect(field).toHaveValue("c");
    expect(toggle.getAttribute("aria-pressed")).toBe(before);
  }, SLOW);

  it("Ctrl+K takes the focus to the message field while the sheet is open", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await createFromBar("exportar csv");
    const field = await message();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(field).toHaveFocus();
  }, SLOW);
});

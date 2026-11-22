import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, ApiResult, AskAnswer, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeConversation, makeProject, makeTicket, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

/** "Perguntar ao assistente sobre o projeto": a folha da pergunta dentro da barra de pedidos (ADR 0037, fatia 5). */
const SLOW = 8000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1", progress: { done: 0, total: 1, excluded: 0 } }),
    makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1", status: "todo" }),
    makeTicket("t3", "p1", 3, "Publicar", { key: "ALFA-3", status: "todo" }),
  ],
  p2: [makeTicket("t4", "p2", 1, "Relatório", { key: "BETA-1" })],
};
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const manager = () => withAssistant(makePanelMe("member", [{ projectId: "p1", role: "manager" }, { projectId: "p2", role: "manager" }]));
const reader = () => withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }, { projectId: "p2", role: "reader" }]));
const answer = (text: string): ApiResult<AskAnswer> => ok({ text, model: "claude-opus-5-5" });

type Ask = (projectId: string, body: { question: string; history?: { author: "person" | "assistant"; body: string }[] }, options?: { signal?: AbortSignal }) => Promise<ApiResult<AskAnswer>>;
function makeFullClient(options: { ask?: Ask; only?: "p1"; extra?: Partial<Record<keyof ApiClient, unknown>> } = {}): ApiClient {
  const list = options.only ? projects.filter((project) => project.id === options.only) : projects;
  const client = makeClient({ projects: list, tickets, people: [makePerson("person-1", "Ana")] });
  const all = Object.values(tickets).flat();
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(all.find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async (projectId: string) => ok(makeConversation("c1", projectId))),
    askProject: vi.fn(options.ask ?? (async () => answer("Resposta."))),
    ...options.extra,
  });
  return client;
}

function Host({ client, me, onChange }: { client: ApiClient; me: Me; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const bar = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" });
const sheet = () => screen.queryByRole("region", { name: "Pergunta sobre o projeto" });
const conversationSheet = () => screen.queryByRole("region", { name: "Novo ticket com o assistente" });
const field = () => screen.findByRole("textbox", { name: "Pergunte mais sobre este projeto" });
const thread = () => within(sheet()!.querySelector<HTMLElement>(".assistant-scroll")!);
const askInProgress = () => screen.queryByRole("button", { name: "Pergunta em andamento" });
const conversationInProgress = () => screen.queryByRole("button", { name: "Conversa em andamento" });
const optionNames = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
async function typed(text: string) {
  const input = await bar();
  await userEvent.click(input);
  await userEvent.type(input, text);
  return input;
}
/** Digita na barra e aperta Shift+Enter: "Perguntar ao assistente". */
async function ask(text: string) {
  await typed(text);
  await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
}
/** Cola a pergunta no campo da folha e envia com Enter. */
async function followUp(text: string) {
  const input = await field();
  await userEvent.click(input);
  await userEvent.paste(text);
  await userEvent.keyboard("{Enter}");
}
async function node(name: RegExp) {
  const found = await screen.findByRole("button", { name }, { timeout: SLOW });
  await waitFor(() => expect(found).toHaveAttribute("tabindex", "0"), { timeout: SLOW });
  return found;
}
async function exploreAlfa() {
  await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
  await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
}

describe("the 'Perguntar ao assistente' line", () => {
  it("comes after the results and 'Criar ticket', with the Shift Enter hint", async () => {
    render(<Host client={makeFullClient()} me={manager()} />);
    await typed("login");
    const names = optionNames();
    expect(names).toHaveLength(4);
    expect(names[0]).toContain("ALFA-2");
    expect(names[1]).toContain("Criar ticket «login»");
    expect(names[2]).toContain("Registrar ideia «login»");
    expect(names[3]).toContain("Perguntar ao assistente sobre «login»");
    expect(names[3]).toContain("Shift Enter");
  }, SLOW);

  it("does not exist without the assistant", async () => {
    render(<Host client={makeFullClient()} me={withAssistant(manager(), false)} />);
    await typed("login");
    expect(screen.queryByRole("option", { name: /Perguntar ao assistente/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Criar ticket/ })).toBeInTheDocument();
  }, SLOW);

  it("a reader asks too: the line exists although they cannot create tickets", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={reader()} />);
    await typed("login");
    expect(screen.queryByRole("option", { name: /Criar ticket/ })).not.toBeInTheDocument();
    const names = optionNames();
    expect(names.at(-1)).toContain("Perguntar ao assistente sobre «login»");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(client.askProject).toHaveBeenCalled());
  }, SLOW);

  it("is there when nothing matches and no ticket can be created", async () => {
    render(<Host client={makeFullClient()} me={reader()} />);
    await typed("zzzz");
    expect(optionNames()).toEqual([expect.stringContaining("Perguntar ao assistente sobre «zzzz»")]);
  }, SLOW);
});

describe("how the question is fired", () => {
  it("Enter on the line, reached with the arrow keys", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await typed("login");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: /Perguntar ao assistente/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(client.askProject).toHaveBeenCalledWith("p1", { question: "login", history: [] }, expect.anything()));
    expect(client.openConversation).not.toHaveBeenCalled();
  }, SLOW);

  it("a click on the line", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await typed("login");
    await userEvent.click(screen.getByRole("option", { name: /Perguntar ao assistente/ }));
    await waitFor(() => expect(client.askProject).toHaveBeenCalledWith("p1", { question: "login", history: [] }, expect.anything()));
  }, SLOW);

  it("Shift+Enter in the field, whichever line is highlighted", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await typed("login");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(client.askProject).toHaveBeenCalledTimes(1));
    expect(client.askProject).toHaveBeenCalledWith("p1", { question: "login", history: [] }, expect.anything());
  }, SLOW);

  it("plain Enter still opens the highlighted ticket and Ctrl+Enter still creates, neither asks", async () => {
    const onChange = vi.fn();
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} onChange={onChange} />);
    await typed("login");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("t2"));
    await typed("exportar");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(client.openConversation).toHaveBeenCalled());
    expect(client.askProject).not.toHaveBeenCalled();
  }, SLOW);

  it("Shift+Enter with an empty field does nothing", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await userEvent.click(await bar());
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(sheet()).not.toBeInTheDocument();
    expect(client.askProject).not.toHaveBeenCalled();
  }, SLOW);
});

describe("which project is asked", () => {
  it("the project of the open ticket page", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await exploreAlfa();
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await userEvent.click(await node(/ALFA-3 · Publicar/));
    await screen.findByRole("complementary", { name: "Página do ticket" });
    await ask("quem mexe nisso");
    await waitFor(() => expect(client.askProject).toHaveBeenCalledWith("p1", expect.objectContaining({ question: "quem mexe nisso" }), expect.anything()));
  }, SLOW);

  it("the project of the selected node", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await userEvent.click(await screen.findByRole("button", { name: /BETA · Projeto Beta/ }));
    await ask("e o relatório?");
    await waitFor(() => expect(client.askProject).toHaveBeenCalledWith("p2", expect.objectContaining({ question: "e o relatório?" }), expect.anything()));
    expect(screen.queryByRole("heading", { name: "Em qual projeto?" })).not.toBeInTheDocument();
  }, SLOW);

  it("the only visible project, even for someone who cannot create tickets there", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={reader()} />);
    await ask("login");
    await waitFor(() => expect(client.askProject).toHaveBeenCalledWith("p1", expect.anything(), expect.anything()));
  }, SLOW);

  it("with several projects and nothing selected, the sheet asks 'Em qual projeto?' and then sends the question", async () => {
    const client = makeFullClient();
    render(<Host client={client} me={manager()} />);
    await ask("login");
    expect(await screen.findByRole("heading", { name: "Em qual projeto?" })).toBeInTheDocument();
    expect(client.askProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "BETA · Projeto Beta" }));
    await waitFor(() => expect(client.askProject).toHaveBeenCalledWith("p2", { question: "login", history: [] }, expect.anything()));
    expect(await thread().findByText("Resposta.")).toBeInTheDocument();
  }, SLOW);
});

describe("the question sheet", () => {
  it("has the top row, shows the question and the answer as markdown, and keeps the field at the bottom", async () => {
    const client = makeFullClient({ only: "p1", ask: async () => answer("Faltam **dois** itens:\n\n- um\n- dois") });
    render(<Host client={client} me={manager()} />);
    await ask("o que falta?");
    const region = await screen.findByRole("region", { name: "Pergunta sobre o projeto" });
    const top = screen.getByRole("region", { name: "Barra de pedidos" });
    expect(top).toHaveTextContent("ALFA");
    expect(within(top).getByRole("button", { name: "Nova pergunta" })).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "Recolher" })).toBeInTheDocument();
    expect(await thread().findByText("o que falta?")).toBeInTheDocument();
    await waitFor(() => expect(region.querySelector(".assistant-scroll strong")).toHaveTextContent("dois"));
    expect(region.querySelectorAll(".assistant-scroll li")).toHaveLength(2);
    expect(await field()).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Peça qualquer coisa" })).not.toBeInTheDocument();
  }, SLOW);

  it("shows 'Consultando o projeto…' in a live region while waiting", async () => {
    const client = makeFullClient({ only: "p1", ask: () => new Promise(() => undefined) });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    expect(await screen.findByText("Consultando o projeto…")).toBeInTheDocument();
    expect(screen.getByText("Consultando o projeto…")).toHaveAttribute("role", "status");
  }, SLOW);

  it("Esc cancels the request and hands the question back to the field; the next Esc folds the sheet", async () => {
    let signal: AbortSignal | undefined;
    const client = makeFullClient({ only: "p1", ask: (_project, _body, options) => new Promise((resolve) => { signal = options?.signal; options?.signal?.addEventListener("abort", () => resolve(failed("unavailable"))); }) });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await screen.findByText("Consultando o projeto…");
    await userEvent.keyboard("{Escape}");
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText("Consultando o projeto…")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await field()).toHaveValue("login");
    expect(sheet()).toBeInTheDocument();
    expect(thread().queryByText("login")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(sheet()).not.toBeInTheDocument();
    expect(askInProgress()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.querySelector(".spatial-stage"));
  }, SLOW);

  it("an assistant that is down shows a short alert and 'Tentar de novo', which repeats the same question", async () => {
    const calls = vi.fn<Ask>()
      .mockResolvedValueOnce(failed("unavailable", "assistant_unavailable"))
      .mockResolvedValueOnce(answer("Agora sim."));
    const client = makeFullClient({ only: "p1", ask: calls });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("O assistente não respondeu");
    expect(thread().getByText("login")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await thread().findByText("Agora sim.")).toBeInTheDocument();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1]![1]).toEqual({ question: "login", history: [] });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(thread().getAllByText("login")).toHaveLength(1);
  }, SLOW);

  it("a follow-up with Enter sends the earlier messages of the sheet as history", async () => {
    const client = makeFullClient({ only: "p1", ask: vi.fn<Ask>().mockResolvedValueOnce(answer("Primeira.")).mockResolvedValueOnce(answer("Segunda.")) });
    render(<Host client={client} me={manager()} />);
    await ask("primeira pergunta");
    await thread().findByText("Primeira.");
    await followUp("e a segunda?");
    await thread().findByText("Segunda.");
    expect(client.askProject).toHaveBeenLastCalledWith(
      "p1",
      { question: "e a segunda?", history: [{ author: "person", body: "primeira pergunta" }, { author: "assistant", body: "Primeira." }] },
      expect.anything(),
    );
    expect(await field()).toHaveValue("");
  }, SLOW);

  it("sends only the 20 most recent messages as history, while the older ones stay on screen", async () => {
    let turn = 0;
    const client = makeFullClient({ only: "p1", ask: async () => answer(`resposta ${++turn}`) });
    render(<Host client={client} me={manager()} />);
    await ask("pergunta 1");
    await thread().findByText("resposta 1");
    for (let n = 2; n <= 11; n += 1) {
      await followUp(`pergunta ${n}`);
      await thread().findByText(`resposta ${n}`);
    }
    await followUp("pergunta 12");
    await thread().findByText("resposta 12");
    const body = vi.mocked(client.askProject).mock.calls.at(-1)![1];
    expect(body.question).toBe("pergunta 12");
    expect(body.history).toHaveLength(20);
    expect(body.history![0]).toEqual({ author: "person", body: "pergunta 2" });
    expect(body.history!.at(-1)).toEqual({ author: "assistant", body: "resposta 11" });
    expect(thread().getByText("pergunta 1")).toBeInTheDocument();
  }, 30000);

  it("a mention in the answer is a clickable label: it opens the ticket and folds the sheet", async () => {
    const onChange = vi.fn();
    const client = makeFullClient({ only: "p1", ask: async () => answer("Veja ALFA-2 e ALFA-3.") });
    render(<Host client={client} me={manager()} onChange={onChange} />);
    await ask("o que falta?");
    const second = await screen.findByRole("link", { name: /ALFA-2/ });
    expect(screen.getByRole("link", { name: /ALFA-3/ })).toBeInTheDocument();
    // O editor de leitura trata o mousedown com medidas de layout que o jsdom não tem: o clique de verdade vai na suíte de navegador.
    fireEvent.click(second);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("t2"));
    expect(sheet()).not.toBeInTheDocument();
    expect(askInProgress()).toBeInTheDocument();
  }, SLOW);

  it("'Nova pergunta' clears the sheet and puts the focus on the bar field", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await thread().findByText("Resposta.");
    await userEvent.click(screen.getByRole("button", { name: "Nova pergunta" }));
    expect(sheet()).not.toBeInTheDocument();
    expect(askInProgress()).not.toBeInTheDocument();
    const input = await bar();
    expect(input).toHaveValue("");
    await waitFor(() => expect(input).toHaveFocus());
    await ask("outra");
    await waitFor(() => expect(client.askProject).toHaveBeenLastCalledWith("p1", { question: "outra", history: [] }, expect.anything()));
  }, SLOW);

  it("a question past 2000 characters stays in the field instead of being sent", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    const input = await bar();
    await userEvent.click(input);
    await userEvent.paste("x".repeat(2001));
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(await field()).toHaveValue("x".repeat(2001));
    expect(client.askProject).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(client.askProject).not.toHaveBeenCalled();
  }, SLOW);

  it("keeps nothing in localStorage", async () => {
    const snapshot = () => JSON.stringify(Object.entries(localStorage).sort());
    const before = snapshot();
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await thread().findByText("Resposta.");
    expect(snapshot()).toBe(before);
    expect(sessionStorage.length).toBe(0);
  }, SLOW);

  it("a new mount of the map starts without the earlier questions", async () => {
    const client = makeFullClient({ only: "p1" });
    const first = render(<Host client={client} me={manager()} />);
    await ask("login");
    await thread().findByText("Resposta.");
    first.unmount();
    render(<Host client={client} me={manager()} />);
    await bar();
    expect(sheet()).not.toBeInTheDocument();
    expect(askInProgress()).not.toBeInTheDocument();
  }, SLOW);
});

describe("folding and living together with the new-ticket conversation", () => {
  it("folding a sheet with messages leaves 'Pergunta em andamento' on the bar; it reopens with the messages", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await thread().findByText("Resposta.");
    await userEvent.click(within(screen.getByRole("region", { name: "Barra de pedidos" })).getByRole("button", { name: "Recolher" }));
    expect(sheet()).not.toBeInTheDocument();
    expect(await bar()).toBeInTheDocument();
    await userEvent.click(askInProgress()!);
    expect(await thread().findByText("Resposta.")).toBeInTheDocument();
    expect(client.askProject).toHaveBeenCalledTimes(1);
  }, SLOW);

  it("folding a sheet without any message ends it", async () => {
    const client = makeFullClient({ only: "p1", ask: () => new Promise(() => undefined) });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await screen.findByText("Consultando o projeto…");
    // Com a pergunta a caminho a folha já tem uma mensagem; cancelada, volta a não ter nenhuma.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(screen.getByRole("region", { name: "Barra de pedidos" })).getByRole("button", { name: "Recolher" }));
    expect(sheet()).not.toBeInTheDocument();
    expect(askInProgress()).not.toBeInTheDocument();
  }, SLOW);

  it("the Esc order: cancels the wait first, then folds the sheet and hands the focus to the map", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await thread().findByText("Resposta.");
    await userEvent.keyboard("{Escape}");
    expect(sheet()).not.toBeInTheDocument();
    expect(askInProgress()).toBeInTheDocument();
    expect(document.activeElement).toBe(document.querySelector(".spatial-stage"));
  }, SLOW);

  it("both can be in progress at once: the bar shows both buttons, and opening one folds the other", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await typed("exportar csv");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await screen.findByRole("region", { name: "Novo ticket com o assistente" });
    await userEvent.click(within(screen.getByRole("region", { name: "Barra de pedidos" })).getByRole("button", { name: "Recolher" }));
    expect(conversationInProgress()).toBeInTheDocument();
    await ask("login");
    await thread().findByText("Resposta.");
    // Abrir a folha da pergunta recolhe a conversa, que continua em andamento.
    expect(conversationSheet()).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "Barra de pedidos" })).getByRole("button", { name: "Recolher" }));
    expect(conversationInProgress()).toBeInTheDocument();
    expect(askInProgress()).toBeInTheDocument();
    // O contrário: reabrir a conversa recolhe a pergunta.
    await userEvent.click(conversationInProgress()!);
    expect(await screen.findByRole("region", { name: "Novo ticket com o assistente" })).toBeInTheDocument();
    expect(sheet()).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "Barra de pedidos" })).getByRole("button", { name: "Recolher" }));
    await userEvent.click(askInProgress()!);
    expect(await thread().findByText("Resposta.")).toBeInTheDocument();
    expect(conversationSheet()).not.toBeInTheDocument();
    // Com a folha da pergunta à vista o campo da barra some, e com ele os dois botões.
    expect(conversationInProgress()).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(conversationInProgress()).toBeInTheDocument();
    expect(askInProgress()).toBeInTheDocument();
  }, SLOW);

  it("starting a new-ticket conversation from the bar while a question is folded keeps the question in progress", async () => {
    const client = makeFullClient({ only: "p1" });
    render(<Host client={client} me={manager()} />);
    await ask("login");
    await thread().findByText("Resposta.");
    await userEvent.keyboard("{Escape}");
    await typed("exportar csv");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await screen.findByRole("region", { name: "Novo ticket com o assistente" });
    expect(sheet()).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("region", { name: "Barra de pedidos" })).getByRole("button", { name: "Recolher" }));
    expect(askInProgress()).toBeInTheDocument();
    expect(conversationInProgress()).toBeInTheDocument();
  }, SLOW);
});

describe("shortcuts", () => {
  it("with the focus in the sheet, the map shortcuts do not fire", async () => {
    render(<Host client={makeFullClient({ only: "p1" })} me={manager()} />);
    await ask("login");
    const input = await field();
    const toggle = screen.getByRole("button", { name: "Cores" });
    const before = toggle.getAttribute("aria-pressed");
    await userEvent.click(input);
    await userEvent.keyboard("c");
    expect(input).toHaveValue("c");
    expect(toggle.getAttribute("aria-pressed")).toBe(before);
  }, SLOW);

  it("Ctrl+K takes the focus to the question field while the sheet is open", async () => {
    render(<Host client={makeFullClient({ only: "p1" })} me={manager()} />);
    await ask("login");
    const input = await field();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(input).toHaveFocus();
  }, SLOW);
});

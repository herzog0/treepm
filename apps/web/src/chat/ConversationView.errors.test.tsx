import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../api/client.js";
import { ALFA1, renderChats } from "./chatTesting.js";
import { mention } from "./mentionTesting.js";
import { composer, composerShown, typeInComposer } from "./composerTesting.js";

const panel = () => screen.findByRole("complementary", { name: "Conversa" });
const refuse = (code: string, details?: Record<string, unknown>, kind = "conflict"): ApiResult<never> =>
  ({ ok: false, error: { kind, code, ...(details ? { details } : {}) } }) as ApiResult<never>;
const write = async (text: string) => {
  await composer();
  typeInComposer(text);
};
const ownedThread = (c: Parameters<NonNullable<Parameters<typeof renderChats>[0]>["seed"] & {}>[0]) => {
  const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
  c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
};

describe("a recusa do servidor tem texto próprio na tela", () => {
  it.each([
    ["max_depth", "Esta conversa está no último nível: não dá para abrir outra thread aqui dentro."],
    ["participant_cannot_view_ticket", "Alguém desta conversa não enxerga o projeto deste ticket."],
  ])("ao abrir uma thread: %s", async (code, text) => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await write("Bia, olha");
    await mention("Bia");
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(refuse(code));
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await within(await panel()).findByRole("alert")).toHaveTextContent(text);
    // A mensagem não se perde: continua no campo, com a pessoa marcada.
    expect(composerShown()).toBe("Bia, olha @Bia ");
    expect(screen.getByText(/abre uma thread com Bia/)).toBeInTheDocument();
    // O texto do cartão não nomeia ninguém.
    if (code === "participant_cannot_view_ticket") expect(document.body).not.toHaveTextContent(/Caio|Duda/);
  });

  it("mention_not_allowed diz quem não pode ser marcado, pelos ids", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await write("oi");
    await mention("Bia");
    await mention("Caio");
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(refuse("mention_not_allowed", { personIds: ["person-3"] }));
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    const alert = await within(await panel()).findByRole("alert");
    expect(alert).toHaveTextContent(/não pode participar desta conversa/);
    // O texto serve a qualquer conversa: não fala de "este ticket".
    expect(alert).not.toHaveTextContent(/este ticket/);
    const caio = screen.getByText("Caio").closest("li")!;
    expect(caio).toHaveTextContent("não pode ser marcada aqui");
    expect(screen.getByText("Bia").closest("li")).not.toHaveTextContent("não pode ser marcada aqui");
  });

  it("mention_not_allowed no chat geral sem ticket também não fala de ticket", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedGeneral([{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await write("oi");
    await mention("Bia");
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(refuse("mention_not_allowed", { personIds: ["person-2"] }));
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await within(await panel()).findByRole("alert")).not.toHaveTextContent(/ticket/i);
  });

  it.each([
    ["thread_full", "Esta thread já tem o máximo de 25 participantes."],
    ["not_thread_owner", "Só quem abriu a thread pode incluir pessoas nela."],
  ])("ao incluir pessoas: %s (a janela fica aberta e o foco volta ao botão ao fechar)", async (code, text) => {
    const { client } = renderChats({ seed: ownedThread });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    const open = await screen.findByRole("button", { name: "Incluir pessoas" });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Incluir pessoas na thread" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Caio" }));
    vi.mocked(client.addConversationParticipants).mockResolvedValueOnce(refuse(code, { personIds: ["person-3"] }));
    await user.click(within(dialog).getByRole("button", { name: "Incluir" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(text);
    expect(dialog).toHaveTextContent("(Caio)");
    // O foco precisa estar dentro da janela para o Esc chegar a ela (o botão que enviou ficou desligado durante o envio).
    within(dialog).getByRole("searchbox", { name: "Buscar pessoa" }).focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Incluir pessoas na thread" })).toBeNull());
    expect(open).toHaveFocus();
  });

  it("incluir pessoas nunca mostra um id cru quando a pessoa não está no diretório", async () => {
    const { client } = renderChats({ seed: ownedThread });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await user.click(await screen.findByRole("button", { name: "Incluir pessoas" }));
    const dialog = await screen.findByRole("dialog", { name: "Incluir pessoas na thread" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Caio" }));
    vi.mocked(client.addConversationParticipants).mockResolvedValueOnce(refuse("thread_full", { personIds: ["person-desconhecida"] }));
    await user.click(within(dialog).getByRole("button", { name: "Incluir" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("(Alguém)");
    expect(alert).not.toHaveTextContent("person-desconhecida");
  });

  it("chat_changed: recarrega a conversa, devolve a mensagem ao campo e avisa", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByText("olá")).toBeInTheDocument();
    await write("pergunta");
    const reads = vi.mocked(client.getConversationView).mock.calls.length;
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(refuse("chat_changed"));
    await user.keyboard("{Enter}");
    expect(await within(await panel()).findByRole("alert")).toHaveTextContent("A conversa mudou em outro aparelho enquanto o assistente respondia.");
    expect(composerShown()).toBe("pergunta");
    await waitFor(() => expect(vi.mocked(client.getConversationView).mock.calls.length).toBeGreaterThan(reads));
  });

  it("uma conversa que sumiu (404) diz isso e a barra se atualiza, sem 'tentar de novo'", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    const lists = vi.mocked(client.listConversationTree).mock.calls.length;
    vi.mocked(client.getConversationView).mockResolvedValue(refuse("not_found", undefined, "not_found"));
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByRole("alert")).toHaveTextContent("Esta conversa não existe mais. Escolha outra na barra.");
    expect(within(await panel()).queryByRole("button", { name: "Tentar de novo" })).toBeNull();
    await waitFor(() => expect(vi.mocked(client.listConversationTree).mock.calls.length).toBeGreaterThan(lists + 1));
  });
});

describe("o primeiro envio cria a conversa e a mensagem pode falhar depois", () => {
  it("a tela se recupera, o reenvio não cria de novo e a barra é atualizada mesmo na falha", async () => {
    const { client } = renderChats();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await write("primeira");
    const lists = vi.mocked(client.listConversationTree).mock.calls.length;
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>);
    await user.keyboard("{Enter}");
    expect(await within(await panel()).findByText("Tentar de novo")).toBeInTheDocument();
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
    // A barra já mostra a conversa que nasceu.
    await waitFor(() => expect(vi.mocked(client.listConversationTree).mock.calls.length).toBeGreaterThan(lists));
    await user.click(within(await panel()).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(await panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
  });

  it("um envio ao assistente e uma thread durante o mesmo POST esperam a mesma criação: a conversa nasce uma vez só", async () => {
    const { client } = renderChats();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    let release: () => void = () => undefined;
    const real = vi.mocked(client.openTicketConversation).getMockImplementation()!;
    vi.mocked(client.openTicketConversation).mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return real(...args);
    });
    await write("pergunta ao assistente");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(client.openTicketConversation).toHaveBeenCalledTimes(1));
    // Com o POST ainda preso, a pessoa abre uma thread: o segundo envio não cria outra conversa, espera a mesma.
    await write("Bia, olha");
    await mention("Bia");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(2));
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
    const ids = vi.mocked(client.sendChatMessage).mock.calls.map((call) => call[0]);
    expect(new Set(ids).size).toBe(1);
  });
});

describe("uma conversa que passa de 30 mensagens", () => {
  const pairs = (n: number) => Array.from({ length: n }, (_, index) => ({ person: `pergunta ${index + 1}`, assistant: `resposta ${index + 1}` }));

  it("não repete mensagens quando a atualização traz a página mais nova e depois se pedem as anteriores", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", pairs(14)) }); // 28 mensagens
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByText("resposta 14")).toBeInTheDocument();
    expect(within(await panel()).queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();
    const reads = vi.mocked(client.getConversationView).mock.calls.length;
    for (const text of ["a", "b"]) {
      await write(text);
      await user.keyboard("{Enter}");
      await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Conversa" })).getAllByText("Resposta do assistente.").length).toBeGreaterThan(0));
    }
    // A atualização que se segue ao último envio traz a página mais nova (30 de 32): espera por ela.
    await waitFor(() => expect(vi.mocked(client.getConversationView).mock.calls.length).toBeGreaterThanOrEqual(reads + 2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 32 mensagens à vista, todas já carregadas: não há nada "anterior" a buscar e nenhuma aparece duas vezes.
    // Só as mensagens da lista (o anúncio para o leitor de tela repete a última resposta fora dela).
    await waitFor(() => expect(within(screen.getByRole("log", { name: "Mensagens" })).getAllByText("Resposta do assistente.")).toHaveLength(2));
    expect(within(await panel()).queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();
    expect(within(await panel()).getAllByText("pergunta 1")).toHaveLength(1);
    expect(within(await panel()).getAllByText("resposta 14")).toHaveLength(1);
  });

  it("pede a página anterior uma vez, mesmo que o scroll dispare várias", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", pairs(40)) }); // 80 mensagens
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const log = within(await panel()).getByRole("log");
    await within(await panel()).findByText("resposta 40");
    const before = vi.mocked(client.getConversationView).mock.calls.length;
    fireEvent.scroll(log);
    fireEvent.scroll(log);
    fireEvent.scroll(log);
    await waitFor(() => expect(within(log).getAllByRole("listitem").length).toBeGreaterThan(31));
    const olderCalls = vi.mocked(client.getConversationView).mock.calls.slice(before).filter((call) => call[1]?.before !== undefined);
    expect(olderCalls).toHaveLength(1);
    const texts = within(log).getAllByText(/^(pergunta|resposta) \d+$/).map((node) => node.textContent);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("thread em projeto arquivado", () => {
  it("avisa que o projeto está arquivado e só deixa ler", async () => {
    renderChats({ tickets: [{ ...ALFA1, archived: true }], seed: ownedThread });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    const view = await panel();
    expect(await within(view).findByText("O projeto está arquivado e só aceita leitura.")).toBeInTheDocument();
    expect(within(view).queryByRole("button", { name: "Incluir pessoas" })).toBeNull();
  });
});

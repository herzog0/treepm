import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../api/client.js";
import { ALFA1, renderChats } from "./chatTesting.js";

const panel = () => screen.findByRole("complementary", { name: "Conversa" });
const write = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const field = await screen.findByRole("textbox", { name: /^(Mensagem|Responder na thread)$/ });
  await user.type(field, text);
};

describe("o convidado e a linha do ticket sem conversa", () => {
  it("clicar na linha do ticket só lê, mostra a thread dele e nada do que há acima", async () => {
    const { client } = renderChats({
      as: "person-3",
      seed: (c) => {
        const main = c.seedConversation("t1", [{ person: "segredo do dono", assistant: "resposta secreta" }]);
        const first = c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        c.openThreadIn(first, { from: "person-2", body: "Caio, e você?", to: ["person-3"], replies: [{ from: "person-3", body: "Posso sim" }] });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const view = await panel();
    await waitFor(() => expect(client.getTicketConversationView).toHaveBeenCalled());
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(await within(view).findByRole("button", { name: /Thread com/ })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/segredo|secreta|Bia, olha/);
    // Só o cartão da thread dele: nenhuma mensagem de cima, nenhum "Carregar anteriores".
    expect(within(view).queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();
    expect(within(view).getAllByRole("button", { name: /Thread com/ })).toHaveLength(1);
  });
});

describe("o chat geral que ainda não existe", () => {
  it("mostra, no painel, o cartão da thread que alguém abriu com a pessoa, como no ticket, e não cria nada", async () => {
    const { client } = renderChats({
      seed: (c) => {
        void c.methods("person-2").openGeneralConversation();
        c.openThreadIn(c.generalOf("person-2")!, { from: "person-2", body: "Ana, uma coisa", to: ["person-1"], replies: [{ from: "person-2", body: "me diz" }] });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    const view = await panel();
    expect(await within(view).findByRole("button", { name: /Thread com Bia/ })).toBeInTheDocument();
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    await user.click(within(view).getByRole("button", { name: /Thread com Bia/ }));
    expect(await within(await panel()).findByText("me diz")).toBeInTheDocument();
  });
});

describe("o que falha na leitura tenta de novo", () => {
  it("getMe que falhou é tentado de novo na atualização seguinte: o título da thread deixa de mostrar o próprio nome", async () => {
    let meDown = true;
    const { client } = renderChats({
      seed: (c) => {
        const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
      },
      prepare: (c) => {
        const real = vi.mocked(c.getMe).getMockImplementation()!;
        vi.mocked(c.getMe).mockImplementation(async () => (meDown ? ({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>) : real()));
      },
    });
    const user = userEvent.setup();
    // Sem saber quem é, a barra nomeia a primeira pessoa da thread, que é a própria.
    expect(await screen.findByRole("button", { name: /Thread com Ana/ })).toBeInTheDocument();
    meDown = false;
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Thread com Ana/ })).toBeNull());
    expect(screen.getAllByRole("button", { name: /Thread com Bia/ }).length).toBeGreaterThan(0);
    expect(vi.mocked(client.getMe).mock.calls.length).toBeGreaterThan(1);
  });

  it("a lista de tickets do 'sobre o ticket…' que falhou volta a tentar", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedGeneral([{ person: "oi", assistant: "olá" }]) });
    vi.mocked(client.listTickets).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await write(user, "Bia, olha");
    await user.click(await screen.findByRole("button", { name: "Mencionar" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Mencionar pessoas" })).getByRole("button", { name: "Bia" }));
    await user.click(await screen.findByRole("button", { name: "Sobre o ticket…" }));
    expect(await screen.findByText("Não foi possível carregar os tickets.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await user.type(screen.getByRole("searchbox", { name: "Sobre o ticket (opcional)" }), "ALFA-1");
    expect(await within(screen.getByRole("searchbox", { name: "Sobre o ticket (opcional)" }).closest(".chat-topic") as HTMLElement).findByRole("button", { name: /ALFA-1/ })).toBeInTheDocument();
  });

  it("uma leitura atrasada (e velha) não sobrescreve uma mais nova", async () => {
    const t1 = { ...ALFA1 };
    const { client } = renderChats({ tickets: [t1], seed: (c) => void c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByText("olá")).toBeInTheDocument();
    const real = vi.mocked(client.getConversationView).getMockImplementation()!;
    // A leitura antiga lê o ticket ainda ativo e fica presa; o projeto é arquivado; a leitura nova vê o arquivamento e responde logo.
    let releaseOld: () => void = () => undefined;
    vi.mocked(client.getConversationView).mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      await new Promise<void>((resolve) => { releaseOld = resolve; });
      return result;
    });
    await user.click(screen.getByRole("button", { name: "Fechar a conversa" }));
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await waitFor(() => expect(vi.mocked(client.getConversationView).mock.calls.length).toBeGreaterThanOrEqual(3));
    t1.archived = true;
    await user.click(screen.getByRole("button", { name: "Fechar a conversa" }));
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByText("O projeto está arquivado e só aceita leitura.")).toBeInTheDocument();
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(await panel()).getByText("O projeto está arquivado e só aceita leitura.")).toBeInTheDocument();
  });
});

describe("clicar na linha da conversa que acabou de nascer", () => {
  it("não remonta o painel: o rascunho e o 'aguardando' continuam", async () => {
    renderChats();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await write(user, "primeira");
    await user.keyboard("{Enter}");
    expect(await within(await panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    await write(user, "rascunho em andamento");
    // A barra agora tem a linha da conversa (com id): clicar nela é o mesmo que já estar nela.
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(screen.getByRole("textbox", { name: "Mensagem" })).toHaveValue("rascunho em andamento");
    expect(screen.getByRole("button", { name: /^ALFA-1/ })).toHaveAttribute("aria-current", "true");
  });
});

describe("o cabeçalho de uma thread sem ticket", () => {
  it("mostra 'Meu chat' em vez de ficar vazio", async () => {
    renderChats({
      seed: (c) => {
        const general = c.seedGeneral([{ person: "oi", assistant: "olá" }]);
        c.openThreadIn(general, { from: "person-1", body: "Bia, uma coisa", to: ["person-2"] });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    const view = await panel();
    await within(view).findByRole("navigation", { name: "Onde você está" });
    expect(view.querySelector(".chat-header .chat-ticket-title")).toHaveTextContent("Meu chat");
  });
});

describe("a conversa que some enquanto está aberta (404 numa atualização)", () => {
  it("a tela diz que sumiu, atualiza a barra uma vez e para de ler (sem laço), sem deixar a conversa velha nem o campo", async () => {
    const { client } = renderChats({ seed: (c) => void c.seedConversation("t1", [{ person: "oi", assistant: "olá velho" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByText("olá velho")).toBeInTheDocument();
    vi.mocked(client.getConversationView).mockResolvedValue({ ok: false, error: { kind: "not_found" } } as ApiResult<never>);
    // Fechar e abrir de novo atualiza a lista e a conversa: a leitura recebe o 404 com a conversa já na tela.
    await user.click(screen.getByRole("button", { name: "Fechar a conversa" }));
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    expect(await within(await panel()).findByRole("alert")).toHaveTextContent("Esta conversa não existe mais.");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const reads = vi.mocked(client.getConversationView).mock.calls.length;
    const lists = vi.mocked(client.listConversationTree).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(vi.mocked(client.getConversationView).mock.calls.length).toBe(reads);
    expect(vi.mocked(client.listConversationTree).mock.calls.length).toBe(lists);
    expect(within(await panel()).queryByText("olá velho")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Mensagem" })).toBeNull();
  });
});

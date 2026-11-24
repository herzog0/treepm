import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketSummary } from "../api/client.js";
import { ChatPanel } from "../chat/ChatPanel.js";
import { ChatsProvider } from "../chat/ChatsContext.js";
import { ConversationList } from "../chat/ConversationList.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { createFakeChat } from "../test/chatFakes.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import { composerShown } from "../chat/composerTesting.js";

// A barra de pedidos manda o texto livre ao Meu chat (ADR 0056): quais chamadas cada tecla faz.
const SLOW = 8000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa")];
const tickets: Record<string, TicketSummary[]> = { p1: [makeTicket("t1", "p1", 1, "Login com Google", { key: "ALFA-1" })] };
const me = { ...makePanelMe("admin"), assistant: { enabled: true } };

function Host({ client, strict = true, me: who = me }: { client: ApiClient; strict?: boolean; me?: typeof me }) {
  const [open, setOpen] = useState<string | null>(null);
  const tree: ReactElement = (
    <ChatsProvider client={client} onShowTicket={() => {}}>
      <ConversationList />
      <ChatPanel />
      <OrganizationMap client={client} me={who} openTicketId={open} onOpenTicketChange={setOpen} />
    </ChatsProvider>
  );
  return strict ? <StrictMode>{tree}</StrictMode> : tree;
}
function setup(options: { reply?: (text: string) => string; seed?: (chat: ReturnType<typeof createFakeChat>) => void } = {}) {
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Login com Google", projectId: "p1" }], people: [makePerson("person-1", "Ana")], ...(options.reply ? { reply: options.reply } : {}) });
  options.seed?.(chat);
  const client = makeClient({ projects, tickets, people: [makePerson("person-1", "Ana")], chat });
  return { chat, client };
}
const sendCalls = (client: ApiClient) => (client.sendChatMessage as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls;
const bar = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" });
async function typed(text: string) {
  const field = await bar();
  await userEvent.click(field);
  await userEvent.type(field, text);
  return field;
}
const zone = () => document.querySelector<HTMLElement>(".command-zone")!;
const panel = () => document.getElementById("chat-panel")!;

describe("a barra de pedidos e o Meu chat", () => {
  it("sem ticket encontrado o Enter manda o texto ao Meu chat como assunto novo: cria o chat geral uma vez, manda `topic: true` e a coluna abre na thread", async () => {
    const { client, chat } = setup();
    render(<Host client={client} />);
    const field = await typed("como divido a migração");
    // A linha destacada é a do Meu chat.
    expect(screen.getByRole("option", { name: /Conversar no Meu chat/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(sendCalls(client)).toHaveLength(1));
    expect(client.openGeneralConversation).toHaveBeenCalledTimes(1);
    expect(sendCalls(client)[0]).toEqual([chat.generalOf()!, { body: "como divido a migração", topic: true }, expect.anything()]);
    expect(client.createTicket).not.toHaveBeenCalled();
    expect(field).toHaveValue("");
    // A coluna passa para a thread nova: a trilha e a resposta do assistente.
    expect(await within(panel()).findByRole("navigation", { name: "Onde você está" })).toBeInTheDocument();
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
  }, SLOW);

  it("a coluna abre já com a mensagem e o 'respondendo…' enquanto a chamada não volta", async () => {
    const { client } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = client.sendChatMessage;
    client.sendChatMessage = vi.fn(async (...args: Parameters<ApiClient["sendChatMessage"]>) => {
      await gate;
      return real(...args);
    }) as ApiClient["sendChatMessage"];
    render(<Host client={client} />);
    await typed("pergunta demorada");
    await userEvent.keyboard("{Enter}");
    const column = within(panel());
    expect(await column.findByText("pergunta demorada")).toBeInTheDocument();
    expect(column.getByRole("status", { name: "" })).toHaveTextContent(/respondendo|Aguardando|Pensando/i);
    release();
    expect(await column.findByText("Resposta do assistente.")).toBeInTheDocument();
  }, SLOW);

  it("com ticket encontrado o Enter abre o ticket e não fala com o chat; Shift+Enter manda ao chat mesmo assim", async () => {
    const { client } = setup();
    render(<Host client={client} />);
    await typed("login");
    expect(screen.getByRole("option", { name: /ALFA-1/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(sendCalls(client)).toHaveLength(0);
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    await typed("login outra vez");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(sendCalls(client)).toHaveLength(1));
    expect(sendCalls(client)[0]![1]).toEqual({ body: "login outra vez", topic: true });
  }, SLOW);

  it("Ctrl+Enter abre uma thread de criação no Meu chat (`creation: true`), não uma conversa comum", async () => {
    const { client } = setup();
    render(<Host client={client} />);
    await typed("zzz criar isto");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(sendCalls(client)).toHaveLength(1));
    expect(sendCalls(client)[0]![1]).toMatchObject({ creation: true });
  }, SLOW);

  it("campo vazio: 'Abrir o Meu chat' é a primeira linha e abre a coluna no chat geral, sem criar nada", async () => {
    const { client } = setup({ seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]) });
    render(<Host client={client} />);
    await userEvent.click(await bar());
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Abrir o Meu chat");
    await userEvent.click(options[0]!);
    expect(await within(panel()).findByText("olá")).toBeInTheDocument();
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(sendCalls(client)).toHaveLength(0);
  }, SLOW);

  it("falha (sem provedor): a coluna abre no Meu chat com o texto de volta no campo e o erro; nada fica pela metade", async () => {
    const { client } = setup();
    client.sendChatMessage = vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const, code: "assistant_not_configured" } })) as unknown as ApiClient["sendChatMessage"];
    render(<Host client={client} />);
    await typed("texto que não pode se perder");
    await userEvent.keyboard("{Enter}");
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    await waitFor(() => expect(composerShown()).toBe("texto que não pode se perder"));
    expect(within(panel()).getAllByRole("alert").length).toBeGreaterThan(0);
    expect(within(panel()).queryByRole("navigation", { name: "Onde você está" })).toBeNull();
  }, SLOW);

  it("duplo Enter não abre duas threads", async () => {
    const { client } = setup();
    render(<Host client={client} strict />);
    await typed("assunto único");
    await userEvent.keyboard("{Enter}{Enter}");
    await within(panel()).findByText("Resposta do assistente.");
    expect(sendCalls(client).filter(([, body]) => body.topic === true)).toHaveLength(1);
    expect(client.openGeneralConversation).toHaveBeenCalledTimes(1);
  }, SLOW);

  it("com um assunto ainda esperando a resposta, o segundo texto fica no campo e nada é mandado", async () => {
    const { client } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = client.sendChatMessage;
    client.sendChatMessage = vi.fn(async (...args: Parameters<ApiClient["sendChatMessage"]>) => {
      await gate;
      return real(...args);
    }) as ApiClient["sendChatMessage"];
    render(<Host client={client} />);
    await typed("primeiro assunto");
    await userEvent.keyboard("{Enter}");
    const field = await typed("segundo assunto");
    await userEvent.keyboard("{Enter}");
    expect(field).toHaveValue("segundo assunto");
    expect(sendCalls(client)).toHaveLength(1);
    release();
    await within(panel()).findByText("Resposta do assistente.");
  }, SLOW);

  it("sob StrictMode a thread nasce uma vez só", async () => {
    const { client } = setup();
    render(<Host client={client} strict />);
    await typed("só uma");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(sendCalls(client)).toHaveLength(1));
    await within(panel()).findByText("Resposta do assistente.");
    expect(sendCalls(client)).toHaveLength(1);
    const tree = await client.listConversationTree();
    expect(tree.ok && tree.data.items[0]!.children.filter((child) => child.purpose === "topic")).toHaveLength(1);
  }, SLOW);

  const held = (client: ApiClient) => {
    let release: (outcome?: unknown) => void = () => {};
    const gate = new Promise<unknown>((resolve) => { release = resolve; });
    const real = client.sendChatMessage;
    client.sendChatMessage = vi.fn(async (...args: Parameters<ApiClient["sendChatMessage"]>) => {
      const outcome = await gate;
      return (outcome as Awaited<ReturnType<ApiClient["sendChatMessage"]>> | undefined) ?? real(...args);
    }) as ApiClient["sendChatMessage"];
    return release;
  };

  it("o segundo envio com um assunto esperando mostra a frase na barra, nos três idiomas do catálogo", async () => {
    const { client } = setup();
    const release = held(client);
    render(<Host client={client} />);
    await typed("primeiro");
    await userEvent.keyboard("{Enter}");
    await typed("segundo");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("O assistente ainda está respondendo ao assunto anterior.");
    release();
    await within(panel()).findByText("Resposta do assistente.");
  }, SLOW);

  it("Cancelar solta o estado de ocupado e devolve o texto ao campo do Meu chat; a barra aceita outro assunto", async () => {
    const { client } = setup();
    held(client);
    render(<Host client={client} />);
    await typed("texto cancelado");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await within(panel()).findByRole("button", { name: "Cancelar" }));
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    await waitFor(() => expect(composerShown()).toBe("texto cancelado"));
    await typed("outro assunto");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(sendCalls(client).length).toBe(2));
  }, SLOW);

  it("o prazo estourado solta a barra e devolve o texto com o aviso", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { client } = setup();
      held(client);
      render(<Host client={client} />);
      await typed("texto que demora");
      await userEvent.keyboard("{Enter}");
      await within(panel()).findByRole("button", { name: "Cancelar" });
      await vi.advanceTimersByTimeAsync(91_000);
      await within(panel()).findByRole("combobox", { name: "Mensagem" });
      await waitFor(() => expect(composerShown()).toBe("texto que demora"));
      expect(within(panel()).getAllByRole("alert").some((el) => /não respondeu a tempo/.test(el.textContent ?? ""))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, SLOW);

  it("a falha que chega depois de fechar o painel vira a linha ✦ 'Não respondida'; clicar nela abre o Meu chat com o texto e o erro", async () => {
    const { client } = setup();
    const release = held(client);
    render(<Host client={client} />);
    await typed("texto perdido");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await within(panel()).findByRole("button", { name: /Fechar/ }));
    expect(screen.getByRole("button", { name: /respondendo/ })).toBeInTheDocument();
    release({ ok: false, error: { kind: "unavailable", code: "assistant_not_configured" } });
    const line = await screen.findByRole("button", { name: /Não respondida/ });
    await userEvent.click(line);
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    await waitFor(() => expect(composerShown()).toBe("texto perdido"));
    expect(within(panel()).getAllByRole("alert").some((el) => /não está configurada/i.test(el.textContent ?? ""))).toBe(true);
  }, SLOW);

  it("sem aceite (403) pela barra: o texto volta e o aviso do aceite aparece", async () => {
    const { client } = setup();
    held(client)({ ok: false, error: { kind: "forbidden", code: "assistant_consent_required" } });
    render(<Host client={client} />);
    await typed("sem aceite");
    await userEvent.keyboard("{Enter}");
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    await waitFor(() => expect(composerShown()).toBe("sem aceite"));
    expect(within(panel()).getAllByRole("alert").some((el) => /desligada/i.test(el.textContent ?? ""))).toBe(true);
  }, SLOW);

  it("a criação do chat geral falhando devolve o texto e solta a barra", async () => {
    const { client } = setup();
    client.openGeneralConversation = vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } })) as unknown as ApiClient["openGeneralConversation"];
    render(<Host client={client} />);
    await typed("sem chat geral");
    await userEvent.keyboard("{Enter}");
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    await waitFor(() => expect(composerShown()).toBe("sem chat geral"));
    expect(sendCalls(client)).toHaveLength(0);
  }, SLOW);

  it("texto acima de 4.000 caracteres é recusado na barra antes de criar o chat geral", async () => {
    const { client } = setup();
    render(<Host client={client} />);
    const field = await bar();
    await userEvent.click(field);
    await userEvent.paste("x".repeat(4001));
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/passou do limite/);
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(field).not.toHaveValue("");
  }, SLOW);

  it("Ctrl+Enter de quem não pode criar ticket não faz nada; de quem pode, abre a thread de criação (limpa a barra)", async () => {
    const { client } = setup();
    const reader = { ...makePanelMe("member", [{ projectId: "p1", role: "reader" }]), assistant: { enabled: true } };
    const view = render(<Host client={client} me={reader} />);
    const field = await typed("zzz não cria");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(sendCalls(client)).toHaveLength(0);
    expect(field).toHaveValue("zzz não cria");
    view.unmount();
    render(<Host client={client} />);
    const admin = await typed("zzz cria");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(admin).toHaveValue(""));
    await waitFor(() => expect(sendCalls(client)).toHaveLength(1));
  }, SLOW);

  it("o rodapé diz o que o Enter faz: 'Enter conversar' no Meu chat, 'Enter abrir' num ticket", async () => {
    const { client } = setup();
    render(<Host client={client} />);
    await typed("zzz nada");
    expect(zone().querySelector(".command-footer")).toHaveTextContent("Enter conversar");
    await userEvent.clear(await bar());
    await userEvent.type(await bar(), "login");
    expect(zone().querySelector(".command-footer")).toHaveTextContent("Enter abrir");
  }, SLOW);

  it("IME: Enter durante a composição não manda nada", async () => {
    const { client } = setup();
    render(<Host client={client} />);
    const field = await typed("zzz composição");
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(sendCalls(client)).toHaveLength(0);
  }, SLOW);

  it("'Abrir o Meu chat' sem chat geral não cria nada; Shift+Enter sem ticket manda ao chat; Enter num ticket abre o ticket", async () => {
    const { client } = setup();
    render(<Host client={client} />);
    await userEvent.click(await bar());
    await userEvent.click(screen.getAllByRole("option")[0]!);
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(sendCalls(client)).toHaveLength(0);
    await typed("zzz sem ticket");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(sendCalls(client)).toHaveLength(1));
    const field = await typed("login");
    await userEvent.keyboard("{Enter}");
    // Abriu o ticket: a barra se esvaziou e fechou, e nada foi mandado ao chat.
    await waitFor(() => expect(field).toHaveValue(""));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(sendCalls(client)).toHaveLength(1);
  }, SLOW);

  it("a falha com a pessoa já dentro do Meu chat (conversa montada) põe o texto no campo e o erro, com o chat geral nascido neste envio", async () => {
    const { client } = setup();
    const release = held(client);
    render(<Host client={client} />);
    await typed("texto no chat aberto");
    await userEvent.keyboard("{Enter}");
    await within(panel()).findByRole("button", { name: "Cancelar" });
    release({ ok: false, error: { kind: "unavailable", code: "assistant_unavailable" } });
    await within(panel()).findByRole("combobox", { name: "Mensagem" });
    await waitFor(() => expect(composerShown()).toBe("texto no chat aberto"));
    expect(client.openGeneralConversation).toHaveBeenCalledTimes(1);
    expect(within(panel()).getAllByRole("alert").length).toBeGreaterThan(0);
  }, SLOW);
});

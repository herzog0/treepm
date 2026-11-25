import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult, ConversationNode } from "../api/client.js";
import { makeProject, makeTicket } from "../test/fakes.js";
import { linkOf, mention } from "./mentionTesting.js";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";
import type { ChatSetup } from "./chatTesting.js";
import { selectInComposer, composerNow, composerShown, fillComposer, pasteInComposer, typeInComposer, newThreadHead } from "./composerTesting.js";

afterEach(() => vi.restoreAllMocks());

const field = () => composerNow("Mensagem").dom;
const combo = field;
const panel = () => screen.getByRole("complementary", { name: "Conversa" });
const fail = (code: string): ApiResult<never> => ({ ok: false, error: { kind: "conflict", code } }) as ApiResult<never>;

/** O Meu chat, com uma conversa já existente (a barra a mostra), aberto pela linha dela. */
async function openGeneral(setup: ChatSetup = {}) {
  const user = userEvent.setup();
  const view = renderChats({ ...setup, seed: (chat) => { chat.seedGeneral([{ person: "oi", assistant: "olá" }]); setup.seed?.(chat); } });
  await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
  await screen.findByRole("combobox", { name: "Mensagem" });
  return { user, ...view };
}
async function openTicket(setup: ChatSetup = {}) {
  const user = userEvent.setup();
  const view = renderChats({ ...setup, seed: (chat) => { chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); setup.seed?.(chat); } });
  await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
  await screen.findByRole("combobox", { name: "Mensagem" });
  return { user, ...view };
}
const options = (list: HTMLElement) => within(list).getAllByRole("option");

describe("o seletor de pessoas no ponto do texto", () => {
  it("abre com @, filtra pelo que se digita, deixa o texto visível e confirma com Enter virando pastilha", async () => {
    const { user } = await openGeneral();
    typeInComposer("olá @");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(options(list).map((option) => option.textContent)).toEqual([expect.stringContaining("Bia"), expect.stringContaining("Caio")]);
    expect(composerShown()).toBe("olá @");
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    expect(combo()).toHaveAttribute("aria-activedescendant", options(list)[0]!.id);
    typeInComposer("bi");
    expect(composerShown()).toBe("olá @bi");
    expect(options(await screen.findByRole("listbox", { name: "Pessoas" }))).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(composerShown()).toBe("olá @Bia ");
    expect(field()).toHaveFocus();
    expect(newThreadHead()).toHaveTextContent("Bia");
  });

  it("a pessoa de teste leva o selo 'teste' na lista e no cabeçalho da thread (ADR 0057)", async () => {
    const { user } = await openGeneral({ testPeople: ["person-2"] });
    typeInComposer("@");
    const [bia, caio] = options(await screen.findByRole("listbox", { name: "Pessoas" }));
    expect(within(bia!).getByText("teste")).toBeInTheDocument();
    expect(within(caio!).queryByText("teste")).toBeNull();
    await user.click(bia!);
    // A faixa de pastilhas saiu (ADR 0059): o campo passa a mostrar a thread que vai nascer, com a pessoa escolhida e o selo dela.
    expect(newThreadHead()).toHaveTextContent("com Bia");
    expect(within(newThreadHead()!).getByText("teste")).toBeInTheDocument();
  });

  it("escolhe com as setas e confirma com Tab, sem tirar o foco do campo", async () => {
    const { user } = await openGeneral();
    typeInComposer("@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    await user.keyboard("{ArrowDown}");
    expect(combo()).toHaveAttribute("aria-activedescendant", options(list)[1]!.id);
    expect(options(list)[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Tab}");
    expect(field()).toHaveFocus();
    expect(newThreadHead()).toHaveTextContent("Caio");
    expect(composerShown()).toBe("@Caio ");
  });

  it("Esc fecha só o seletor e o texto digitado fica como texto", async () => {
    const { user } = await openGeneral();
    typeInComposer("olá @bi");
    await screen.findByRole("listbox", { name: "Pessoas" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(panel()).toBeInTheDocument();
    expect(composerShown()).toBe("olá @bi");
    expect(field()).toHaveFocus();
  });

  it("não abre no meio de uma palavra, e @Bia colado fica como texto, sem menção", async () => {
    const { user, client } = await openGeneral();
    typeInComposer("a@");
    expect(screen.queryByRole("listbox")).toBeNull();
    fillComposer("@Bia oi");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(composerShown()).toBe("@Bia oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledWith(expect.any(String), { body: "@Bia oi" }, expect.anything()));
  });

  it("não existe o botão Mencionar nem o 'Sobre o ticket…'", async () => {
    const { user } = await openGeneral();
    typeInComposer("Bia");
    typeInComposer(" @");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Mencionar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sobre o ticket…" })).toBeNull();
    expect(screen.queryByText("Sobre o ticket")).toBeNull();
  });

  it("quem não enxerga o projeto do ticket aparece apagado, com o motivo, e não se escolhe", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }, { personId: "person-2", role: "reader" }] });
    const { user } = await openTicket({ projects: [project] });
    typeInComposer("@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    const [bia, caio] = options(list);
    expect(bia).not.toHaveAttribute("aria-disabled");
    expect(caio).toHaveAttribute("aria-disabled", "true");
    expect(caio).toHaveTextContent("Não enxerga o projeto deste ticket");
    await user.click(caio!);
    expect(newThreadHead()?.textContent ?? "").not.toContain("Caio");
    // As setas passam também pela opção apagada (o leitor de tela ouve o motivo), mas `Enter` nela não confirma nem envia.
    await user.keyboard("{ArrowDown}");
    expect(combo()).toHaveAttribute("aria-activedescendant", caio!.id);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox", { name: "Pessoas" })).toBeInTheDocument();
    expect(newThreadHead()).toBeNull();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(newThreadHead()).toHaveTextContent("Bia");
    expect(newThreadHead()?.textContent ?? "").not.toContain("Caio");
  });

  it("no último nível o @ abre o seletor: quem já participa pode ser marcado (mensagem comum), quem é de fora aparece apagado, com o motivo", async () => {
    const user = userEvent.setup();
    renderChats({
      seed: (c) => {
        let parent = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        for (let depth = 1; depth <= 9; depth++) parent = c.openThreadIn(parent, { from: "person-1", body: `nível ${depth}`, to: ["person-2"] });
      },
    });
    const rows = await screen.findAllByRole("button", { name: /^Thread com Bia/ });
    await user.click(rows.at(-1)!);
    expect(await within(panel()).findByText(/último nível/)).toBeInTheDocument();
    typeInComposer("@", composerNow("Responder na thread"));
    const picker = await screen.findByRole("listbox", { name: "Pessoas" });
    const [bia, caio] = [within(picker).getByRole("option", { name: /Bia/ }), within(picker).getByRole("option", { name: /Caio/ })];
    expect(bia).not.toHaveAttribute("aria-disabled", "true");
    expect(caio).toHaveAttribute("aria-disabled", "true");
    expect(caio).toHaveTextContent("Último nível: só quem já participa");
    await user.click(bia);
    // Quem já participa vira só destaque: sem cabeçalho de thread e o botão segue "Enviar".
    expect(newThreadHead()).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
  });
});

describe("o seletor de tickets", () => {
  it("abre com #, carrega os tickets na primeira vez, mostra chave, título e caminho, filtra e confirma com #CHAVE e um espaço", async () => {
    const { user, client } = await openGeneral();
    expect(client.listTickets).not.toHaveBeenCalled();
    typeInComposer("Como está o #");
    const list = await screen.findByRole("listbox", { name: "Tickets" });
    await waitFor(() => expect(options(list).length).toBeGreaterThan(0));
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    expect(client.listTickets).toHaveBeenCalledWith("p1");
    typeInComposer("publ");
    await waitFor(() => expect(options(screen.getByRole("listbox", { name: "Tickets" }))).toHaveLength(1));
    const [only] = options(screen.getByRole("listbox", { name: "Tickets" }));
    expect(only).toHaveTextContent("ALFA-2");
    expect(only).toHaveTextContent("Publicar a versão");
    expect(only).toHaveTextContent("Projeto Alfa");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(composerShown()).toBe("Como está o #ALFA-2 ");
    expect(field()).toHaveFocus();
  });

  it("procura também pela chave, e Esc deixa o #texto como texto", async () => {
    const { user } = await openGeneral();
    typeInComposer("#alfa-1");
    const list = await screen.findByRole("listbox", { name: "Tickets" });
    await waitFor(() => expect(options(list)).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(composerShown()).toBe("#alfa-1");
  });

  it("avisa quando a lista não carrega e deixa tentar de novo", async () => {
    // Abrir a lista pode recarregar por baixo (a carga "stale" refaz a que falhou): a lista falha até o botão, e só a carga do botão acerta.
    let failing = true;
    const { user, client } = await openGeneral({
      prepare: (api) => {
        const original = vi.mocked(api.listTickets).getMockImplementation();
        vi.mocked(api.listTickets).mockImplementation((...args) => (failing ? Promise.resolve({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>) : (original as (...a: typeof args) => ReturnType<typeof api.listTickets>)(...args)));
      },
    });
    typeInComposer("#");
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os tickets.");
    const before = vi.mocked(client.listTickets).mock.calls.length;
    failing = false;
    await user.click(await screen.findByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(vi.mocked(client.listTickets).mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(options(screen.getByRole("listbox", { name: "Tickets" })).length).toBeGreaterThan(0));
  });
});

describe("a linha que diz o que vai acontecer", () => {
  const notice = () => screen.getByRole("status", { name: "O que vai acontecer" });
  it("não aparece sem @ nem #", async () => {
    await openGeneral();
    typeInComposer("oi");
    expect(notice()).toBeEmptyDOMElement();
  });

  it("um ticket no Meu chat: vai para a conversa dele (a chave digitada inteira vale sem a lista; colada também)", async () => {
    await openGeneral();
    typeInComposer("Como está o #ALFA-1 ");
    await waitFor(() => expect(notice()).toHaveTextContent("Vai para a conversa do ALFA-1."));
    fillComposer("olha #ALFA-2");
    await waitFor(() => expect(notice()).toHaveTextContent("Vai para a conversa do ALFA-2."));
  });

  it("um ticket e uma pessoa no Meu chat: abre a conversa do ticket e, dentro dela, a thread", async () => {
    const { user } = await openGeneral();
    typeInComposer("#ALFA-1 consegue ver, ");
    typeInComposer("@");
    await user.keyboard("{Enter}");
    // O campo vira a thread que vai nascer, dentro da conversa do ticket citado (ADR 0059): sem linha de aviso em texto.
    await waitFor(() => expect(newThreadHead()).toHaveTextContent("Nova thread em ALFA-1"));
    expect(newThreadHead()).toHaveTextContent("com Bia");
    expect(notice()).toBeEmptyDOMElement();
  });

  it("só uma pessoa: abre uma thread com ela", async () => {
    const { user } = await openGeneral();
    typeInComposer("oi @");
    await user.keyboard("{Enter}");
    expect(newThreadHead()).toHaveTextContent("Nova thread");
    expect(newThreadHead()).toHaveTextContent("com Bia");
    expect(notice()).toBeEmptyDOMElement();
  });

  it("dois tickets no Meu chat, ou um # no chat de um ticket: fica na conversa e o assistente lê os tickets", async () => {
    const general = await openGeneral();
    typeInComposer("#ALFA-1 depende do #ALFA-2 ");
    await waitFor(() => expect(notice()).toHaveTextContent("Fica nesta conversa. O assistente lê os tickets citados."));
    general.unmount();
    await openTicket();
    typeInComposer("e o #ALFA-2? ");
    await waitFor(() => expect(notice()).toHaveTextContent("Fica nesta conversa. O assistente lê os tickets citados."));
  });

  it("numa thread entre pessoas o # é só referência, sem dizer que o assistente lê", async () => {
    const user = userEvent.setup();
    renderChats({ seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] }); } });
    await user.click(await screen.findByRole("button", { name: /^Thread com Bia/ }));
    typeInComposer("veja o #ALFA-2 ", composerNow("Responder na thread"));
    await waitFor(() => expect(notice()).toHaveTextContent("Fica nesta thread. Os tickets citados são só referência."));
  });

  it("chave que a pessoa não enxerga ou que não existe é só texto: sem aviso", async () => {
    await openGeneral();
    typeInComposer("veja o #ZZZ-9 ");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(notice()).toBeEmptyDOMElement();
  });
});

describe("o caminho do # no Meu chat", () => {
  const sentIds = (client: ReturnType<typeof renderChats>["client"]) => vi.mocked(client.sendChatMessage).mock.calls.map(([id]) => id);

  it("um ticket: abre a conversa dele, manda a mensagem para lá (nunca para o Meu chat) e leva o painel até ela", async () => {
    const { user, client, chat } = await openGeneral();
    typeInComposer("Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.openTicketConversation).toHaveBeenCalledWith("t1");
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    const ticketConversation = chat.principalOf("t1")!;
    expect(sentIds(client)).toEqual([ticketConversation]);
    expect(client.sendChatMessage).toHaveBeenCalledWith(ticketConversation, { body: "Como está o #ALFA-1 ?" }, expect.anything());
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(chat.conversationOf("t1").map((message) => message.body)).toContain("Como está o #ALFA-1 ?");
  });

  it("um ticket e uma pessoa: manda com as menções para a conversa do ticket e leva o painel à thread nova", async () => {
    const { user, client, chat } = await openGeneral();
    typeInComposer("#ALFA-1 consegue ver, ");
    typeInComposer("@bi");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.sendChatMessage).toHaveBeenCalledWith(chat.principalOf("t1"), { body: `#ALFA-1 consegue ver, ${linkOf("person-2", "Bia")}`, mentions: ["person-2"] }, expect.anything());
    const trail = await within(panel()).findByRole("navigation", { name: "Onde você está" });
    expect(within(trail).getByRole("button", { name: "ALFA-1" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Responder na thread" })).toBeInTheDocument();
  });

  it("dois tickets: a mensagem fica no Meu chat e nenhuma conversa de ticket é aberta", async () => {
    const { user, client, chat } = await openGeneral();
    typeInComposer("#ALFA-1 depende do #ALFA-2 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sentIds(client)).toEqual([chat.generalOf()]);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /Abrir o ticket/ })).toBeNull();
  });

  it("no chat de um ticket o # é referência: a mensagem fica onde está, mesmo citando outro ticket", async () => {
    const { user, client, chat } = await openTicket();
    typeInComposer("e o #ALFA-2? ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sentIds(client)).toEqual([chat.principalOf("t1")]);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
  });

  it("numa thread o # é referência: a resposta fica na thread", async () => {
    const user = userEvent.setup();
    const { client, chat } = renderChats({ seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] }); } });
    await user.click(await screen.findByRole("button", { name: /^Thread com Bia/ }));
    typeInComposer("veja o #ALFA-2 ", composerNow("Responder na thread"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(chat.principalOf("t1")).toBeDefined();
  });

  it("chave que não é de ticket visível não leva a lugar nenhum", async () => {
    const { user, client, chat } = await openGeneral();
    typeInComposer("veja o #ZZZ-9 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sentIds(client)).toEqual([chat.generalOf()]);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
  });

  it("falha depois de abrir a conversa: o texto volta ao campo, na conversa do ticket, e reenviar não duplica", async () => {
    const { user, client, chat } = await openGeneral();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(fail("chat_busy"));
    typeInComposer("Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    await waitFor(() => expect(composerShown()).toBe("Como está o #ALFA-1 ?"));
    expect(within(panel()).getByRole("alert")).toBeInTheDocument();
    const ticketConversation = chat.principalOf("t1")!;
    // O texto continua com a chave citada, mas na conversa do ticket a mensagem fica onde está: o reenvio vai para a mesma conversa.
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sentIds(client)).toEqual([ticketConversation, ticketConversation]);
    expect(client.openTicketConversation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(chat.conversationOf("t1").filter((message) => message.body === "Como está o #ALFA-1 ?")).toHaveLength(1));
  });

  it("falha ao abrir a conversa do ticket: fica no Meu chat com o texto no campo e o erro", async () => {
    const { user, client } = await openGeneral();
    vi.mocked(client.openTicketConversation).mockResolvedValueOnce(fail("not_found"));
    typeInComposer("Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("alert")).toBeInTheDocument();
    expect(composerShown()).toBe("Como está o #ALFA-1 ?");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it("nenhuma chamada manda ticketId", async () => {
    const { user, client } = await openGeneral();
    typeInComposer("#ALFA-1 vê, ");
    typeInComposer("@");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    for (const [, body] of vi.mocked(client.sendChatMessage).mock.calls) expect(body).not.toHaveProperty("ticketId");
  });
});

describe("os elos nas mensagens", () => {
  it("#CHAVE de ticket visível vira elo que abre o ticket; o que não existe fica texto", async () => {
    const { user, onShowTicket } = await openGeneral({ seed: (chat) => void chat.seedConversation("t1", [{ person: "veja o #ALFA-2 e o #ZZZ-9", assistant: "ok" }]) });
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const link = await within(panel()).findByRole("link", { name: /^ALFA-2.*Publicar a versão/ });
    expect(link).toHaveTextContent("ALFA-2");
    expect(link).not.toHaveTextContent("#");
    await user.click(link);
    expect(onShowTicket).toHaveBeenCalledWith("t2");
    expect(within(panel()).getByText(/#ZZZ-9/)).toBeInTheDocument();
    expect(within(panel()).queryByRole("link", { name: /ZZZ-9/ })).toBeNull();
  });

  it("chave sem # numa mensagem de pessoa continua sendo texto", async () => {
    const { user } = await openGeneral({ seed: (chat) => void chat.seedConversation("t1", [{ person: "veja o ALFA-2", assistant: "ok" }]) });
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await within(panel()).findByText(/veja o ALFA-2/);
    expect(within(panel()).queryByRole("button", { name: /Publicar a versão/ })).toBeNull();
  });

  it("na resposta do assistente a chave vira elo com ou sem #", async () => {
    const { onShowTicket } = await openGeneral({ reply: () => "Veja ALFA-2 e também #ALFA-1." });
    typeInComposer("o que falta?{Enter}");
    const first = await within(panel()).findByRole("link", { name: /^ALFA-2/ });
    const second = await within(panel()).findByRole("link", { name: /^ALFA-1/ });
    expect(first).toHaveTextContent("ALFA-2");
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onShowTicket).toHaveBeenCalledWith("t1");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Revisão 1
// ---------------------------------------------------------------------------------------------------------------------

/** Uma promessa que o teste solta quando quiser. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
const sent = (client: ReturnType<typeof renderChats>["client"]) => vi.mocked(client.sendChatMessage).mock.calls;

describe("Enter e foco com a lista aberta", () => {
  it("@zed sem resultado: Enter só fecha a lista, o texto fica e nada é enviado", async () => {
    const { user, client } = await openGeneral();
    typeInComposer("oi @zed");
    expect(await screen.findByText("Ninguém para mencionar.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(composerShown()).toBe("oi @zed");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    // Sem a lista, o Enter seguinte envia.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
  });

  it("com as pessoas ainda carregando, Enter não envia o @ cru", async () => {
    const hold = gate();
    const { user, client } = await openGeneral({ prepare: (api) => { const listPeople = api.listPeople; api.listPeople = vi.fn(async () => { await hold.opened; return listPeople(); }); } });
    typeInComposer("@bi");
    expect(await screen.findByText("Carregando as pessoas…")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(composerShown()).toBe("@bi");
    hold.open();
  });

  it("com todas as opções apagadas, Enter não confirma nem envia", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }] });
    const { user, client } = await openTicket({ projects: [project] });
    typeInComposer("@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(options(list).every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(newThreadHead()).toBeNull();
    expect(composerShown()).toBe("@");
  });

  it("a lista fecha quando o campo perde o foco (Tab ou clique fora), e o campo deixa de estar expandido", async () => {
    const { user } = await openGeneral();
    typeInComposer("oi @");
    await screen.findByRole("listbox", { name: "Pessoas" });
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combo()).toHaveAttribute("aria-expanded", "false");
    await user.click(field());
    expect(screen.queryByRole("listbox")).toBeNull();
    typeInComposer("#");
    await screen.findByRole("listbox", { name: "Tickets" });
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicar numa opção continua valendo (o foco não sai do campo)", async () => {
    const { user } = await openGeneral();
    typeInComposer("@");
    await user.click(within(await screen.findByRole("listbox", { name: "Pessoas" })).getByRole("option", { name: /Bia/ }));
    expect(newThreadHead()).toHaveTextContent("Bia");
    expect(field()).toHaveFocus();
  });

  it("o campo é sempre uma caixa de combinação: o papel não muda no meio da digitação", async () => {
    await openGeneral();
    expect(combo()).toHaveAttribute("aria-expanded", "false");
    expect(combo()).not.toHaveAttribute("aria-controls");
    typeInComposer("@");
    expect(screen.getByRole("combobox", { name: "Mensagem" })).toBeInTheDocument();
    expect(combo()).toHaveAttribute("aria-controls", (await screen.findByRole("listbox")).id);
  });
});

describe("o gatilho e o texto em volta", () => {
  it("com o cursor no meio do trecho (@bi|a), confirmar troca o trecho inteiro", async () => {
    const { user } = await openGeneral();
    typeInComposer("olá @bia");
    await user.keyboard("{ArrowLeft}");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(options(list)).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(composerShown()).toBe("olá @Bia ");
    expect(newThreadHead()).toHaveTextContent("Bia");
  });

  it("@ digitado sobre uma seleção a substitui e abre a lista", async () => {
    await openGeneral();
    typeInComposer("texto velho");
    selectInComposer(1, 12);
    typeInComposer("@");
    expect(await screen.findByRole("listbox", { name: "Pessoas" })).toBeInTheDocument();
    expect(composerShown()).toBe("@");
  });

  it("C# não abre a lista, e # no começo de uma linha abre", async () => {
    await openGeneral();
    typeInComposer("C#");
    expect(screen.queryByRole("listbox")).toBeNull();
    typeInComposer(" e outra{Shift>}{Enter}{/Shift}#");
    expect(await screen.findByRole("listbox", { name: "Tickets" })).toBeInTheDocument();
  });
});

describe("os destinos do # só valem para citações de verdade", () => {
  it("# dentro de endereço, de código ou colado numa palavra não leva a lugar nenhum e não pede a lista", async () => {
    const { user, client, chat } = await openGeneral();
    await user.click(field());
    pasteInComposer("veja https://app/p#ALFA-1 e `#ALFA-1` e abc#ALFA-1 ");
    expect(screen.getByRole("status", { name: "O que vai acontecer" })).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.generalOf());
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(client.listTickets).not.toHaveBeenCalled();
  });

  it("a mesma chave repetida conta uma vez: ainda vai para a conversa do ticket", async () => {
    const { user, client, chat } = await openGeneral();
    typeInComposer("#ALFA-1 e de novo #ALFA-1 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
  });

  it("UTF-8, COVID-19 e GPT-4 (de outro projeto) numa mensagem não disparam carga nenhuma", async () => {
    const { client } = await openGeneral({ seed: (chat) => void chat.seedConversation("t1", [{ person: "veja UTF-8 e COVID-19 e #GPT-4", assistant: "GPT-4 e UTF-8" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await within(panel()).findByText(/COVID-19/);
    await user.click(field());
    pasteInComposer("#UTF-8 ");
    expect(client.listTickets).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    expect(client.listTickets).not.toHaveBeenCalled();
  });

  it("no Meu chat, uma chave com `#` de outro projeto (UTF-8) não espera carga e fica onde está", async () => {
    const { user, client, chat } = await openGeneral();
    await user.click(field());
    pasteInComposer("#UTF-8 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.generalOf());
    expect(client.listTickets).not.toHaveBeenCalled();
  });
});

describe("o caminho do # com a lista de tickets decidindo o destino", () => {
  const twoProjects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];

  it("lista em erro no envio: tenta de novo e, se falhar, mostra o erro com o texto no campo e não envia", async () => {
    const { user, client } = await openGeneral({
      prepare: (api) => {
        api.listTickets = vi.fn(async () => ({ ok: false, error: { kind: "unavailable" } }) as ApiResult<never>);
      },
    });
    typeInComposer("#ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent("Não foi possível conferir os tickets citados");
    expect(composerShown()).toBe("#ALFA-1 oi ");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    const first = vi.mocked(client.listTickets).mock.calls.length;
    // Cada envio tenta de novo (a lista que falhou não fica em erro até alguém abrir o #).
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(vi.mocked(client.listTickets).mock.calls.length).toBeGreaterThan(first));
  });

  it("a lista que falhou e volta no envio decide certo: vai para a conversa do ticket", async () => {
    let failing = true;
    const { user, client, chat } = await openGeneral({
      prepare: (api) => {
        const original = api.listTickets;
        api.listTickets = vi.fn(async (projectId: string) => (failing ? ({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>) : original(projectId)));
      },
    });
    typeInComposer("#");
    await screen.findByText("Não foi possível carregar os tickets.");
    await user.keyboard("{Escape}");
    failing = false;
    typeInComposer("ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
  });

  it("falha parcial por projeto: a chave do projeto que carregou vale, a do que falhou não decide e avisa", async () => {
    const setup = {
      projects: twoProjects,
      prepare: (api: Parameters<NonNullable<ChatSetup["prepare"]>>[0]) => {
        const original = api.listTickets;
        api.listTickets = vi.fn(async (projectId: string) => (projectId === "p2" ? ({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>) : original(projectId)));
      },
    };
    const { user, client, chat } = await openGeneral(setup);
    typeInComposer("#ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
    // Uma chave do projeto que não carregou não se trata como "não existe".
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    typeInComposer("#BETA-1 e depois ", composerNow("Mensagem"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent("Não foi possível conferir os tickets citados");
    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("ticket criado depois de a lista carregar: #A depende de #NOVO fica no Meu chat (dois tickets), não vai para o A", async () => {
    const list = { current: [makeTicket("t1", "p1", 1, "Corrigir o login", { key: "ALFA-1" }), makeTicket("t2", "p1", 2, "Publicar a versão", { key: "ALFA-2" })] };
    const { user, client, chat } = await openGeneral({
      tickets: [ALFA1, ALFA2, { id: "t3", key: "ALFA-3", title: "Novo", projectId: "p1" }],
      prepare: (api) => {
        api.listTickets = vi.fn(async () => ({ ok: true, data: list.current }) as ApiResult<never>);
      },
    });
    typeInComposer("#");
    await waitFor(() => expect(options(screen.getByRole("listbox", { name: "Tickets" })).length).toBe(2));
    await user.keyboard("{Escape}");
    fillComposer("");
    list.current = [...list.current, makeTicket("t3", "p1", 3, "Novo", { key: "ALFA-3" })];
    const loads = vi.mocked(client.listTickets).mock.calls.length;
    typeInComposer("#ALFA-1 depende de #ALFA-3 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.listTickets).mock.calls.length).toBeGreaterThan(loads);
    expect(sent(client)[0]![0]).toBe(chat.generalOf());
    expect(client.openTicketConversation).not.toHaveBeenCalled();
  });

  it("abrir o # lê a lista de novo quando ela passou de 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { user, client } = await openGeneral();
      typeInComposer("#");
      await screen.findByRole("listbox", { name: "Tickets" });
      await waitFor(() => expect(client.listTickets).toHaveBeenCalledTimes(1));
      await user.keyboard("{Escape}");
      fillComposer("");
      vi.setSystemTime(Date.now() + 31_000);
      typeInComposer("#");
      await waitFor(() => expect(client.listTickets).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("envio antes de a lista e o diretório chegarem: espera com aviso e não manda ao lugar errado", async () => {
    const hold = gate();
    const { user, client, chat } = await openGeneral({
      prepare: (api) => {
        const listProjects = api.listProjects;
        api.listProjects = vi.fn(async () => { await hold.opened; return listProjects(); });
      },
    });
    typeInComposer("#ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Conferindo os tickets citados…")).toBeInTheDocument();
    expect(field()).toHaveAttribute("contenteditable", "false");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    hold.open();
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
  });
});

describe("o caminho do # dá retorno e não perde a mensagem", () => {
  it("o assistente responde na conversa do ticket, com a bolha pendente e o 'aguardando', e o campo não aceita digitação perdida", async () => {
    const hold = gate();
    const { user, client } = await openGeneral({
      prepare: (api) => {
        const original = api.sendChatMessage;
        api.sendChatMessage = vi.fn(async (...args: Parameters<typeof original>) => { await hold.opened; return original(...args); });
      },
    });
    typeInComposer("Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    expect(await within(panel()).findByText("O assistente está respondendo…")).toBeInTheDocument();
    expect(within(panel()).getAllByText("Como está o #ALFA-1 ?").length).toBeGreaterThan(0);
    expect(composerShown()).toBe("");
    hold.open();
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("falha do provedor na conversa do ticket: a mensagem fica 'sem resposta' com 'Tentar de novo', e repetir não duplica", async () => {
    const { user, client, chat } = await openGeneral();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>);
    typeInComposer("Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await user.click(await within(panel()).findByRole("button", { name: "Tentar de novo" }));
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(sent(client).map(([id]) => id)).toEqual([chat.principalOf("t1"), chat.principalOf("t1")]);
  });

  it("sair da conversa no meio do caminho: a mensagem é entregue uma vez, a barra se atualiza e o painel não é puxado de volta", async () => {
    const hold = gate();
    const { user, client, chat } = await openGeneral({
      seed: (c) => void c.seedConversation("t2", [{ person: "oi", assistant: "olá" }]),
      prepare: (api) => {
        const original = api.openTicketConversation;
        api.openTicketConversation = vi.fn(async (...args: Parameters<typeof original>) => { await hold.opened; return original(...args); });
      },
    });
    typeInComposer("Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.openTicketConversation).toHaveBeenCalledTimes(1));
    const treeReads = vi.mocked(client.listConversationTree).mock.calls.length;
    await user.click(await screen.findByRole("button", { name: /^ALFA-2/ }));
    await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-2/ });
    hold.open();
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
    await waitFor(() => expect(vi.mocked(client.listConversationTree).mock.calls.length).toBeGreaterThan(treeReads));
    expect(within(panel()).getByRole("button", { name: /Abrir o ticket ALFA-2/ })).toBeInTheDocument();
    await waitFor(() => expect(chat.conversationOf("t1").filter((message) => message.body === "Como está o #ALFA-1 ?")).toHaveLength(1));
  });

  it("chat geral que ainda não existe com # de um ticket: não cria o chat geral", async () => {
    const user = userEvent.setup();
    const { client, chat } = renderChats();
    await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
    typeInComposer("Como está o #ALFA-1 ?", composerNow("Mensagem"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
    expect(chat.generalOf()).toBeUndefined();
  });

  it("a recusa do servidor chega marcada também no caminho do #: a pastilha fica recusada e o texto volta ao campo", async () => {
    const { user, client } = await openGeneral();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce({ ok: false, error: { kind: "conflict", code: "mention_not_allowed", details: { personIds: ["person-2"] } } } as ApiResult<never>);
    typeInComposer("#ALFA-1 olha, ");
    await mention("Bia");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    await waitFor(() => expect(composerShown()).toBe("#ALFA-1 olha, @Bia "));
    expect(await screen.findByText("Bia não pode ser marcada aqui.")).toBeInTheDocument();
    expect(newThreadHead()).toHaveTextContent("Bia");
  });

  it("pessoa marcada antes do #: se ela não enxerga o projeto do ticket citado, a pastilha fica recusada, com o motivo, antes do envio", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }, { personId: "person-2", role: "reader" }] });
    const { client } = await openGeneral({ projects: [project] });
    typeInComposer("oi ");
    await mention("Caio");
    expect(screen.getByRole("button", { name: "Abrir thread" })).toBeEnabled();
    typeInComposer("olha o #ALFA-1 ");
    expect(await screen.findByText("Caio não enxerga o projeto deste ticket.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir thread" })).toBeDisabled();
    // Tirar a pessoa recusada, com um clique na própria linha da recusa.
    await userEvent.setup().click(screen.getByRole("button", { name: "Tirar Caio" }));
    expect(screen.queryByText("Caio não enxerga o projeto deste ticket.")).toBeNull();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("a thread e o chat de um ticket guardam o destino", () => {
  it("numa thread, o # é referência: a resposta vai para a própria thread", async () => {
    const user = userEvent.setup();
    let threadId = "";
    const { client } = renderChats({ seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); threadId = c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] }); } });
    await user.click(await screen.findByRole("button", { name: /^Thread com Bia/ }));
    typeInComposer("veja o #ALFA-2 ", composerNow("Responder na thread"));
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(threadId);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(client.listTickets).toHaveBeenCalled();
  });
});

describe("a barra e o cabeçalho", () => {
  it("a thread que repete as pessoas da linha de cima se diz pelo assunto (label); sem label, fica como antes", async () => {
    const withLabel = (nodes: ConversationNode[], label: string | undefined): ConversationNode[] =>
      nodes.map((node) => ({ ...node, ...(node.kind === "thread" && label !== undefined ? { label } : {}), children: withLabel(node.children, label) }));
    renderChats({
      seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); const first = c.openThreadIn(main, { from: "person-1", body: "Bia, olha o login", to: ["person-2"] }); c.openThreadIn(first, { from: "person-1", body: "Bia, e o prazo?", to: ["person-2"] }); },
      prepare: (api) => {
        const original = api.listConversationTree;
        api.listConversationTree = vi.fn(async () => { const result = await original(); return result.ok ? ({ ok: true, data: { items: withLabel(result.data.items, "o prazo do login") } } as const) : result; });
      },
    });
    const rows = await screen.findAllByRole("button", { name: /^Thread com Bia|o prazo do login/ });
    // A primeira thread está debaixo do ticket (outras pessoas na linha de cima): ficou pelos nomes. A segunda repete a Bia.
    expect(rows[0]).toHaveTextContent("Thread com Bia");
    expect(rows[1]).toHaveTextContent("o prazo do login");
    expect(rows[1]).not.toHaveTextContent("Thread com Bia");
  });
});

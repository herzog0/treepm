import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiResult, ConversationNode } from "../api/client.js";
import { makeProject, makeTicket } from "../test/fakes.js";
import { mention } from "./mentionTesting.js";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";
import type { ChatSetup } from "./chatTesting.js";

afterEach(() => vi.restoreAllMocks());

const field = () => screen.getByRole("combobox", { name: "Mensagem" });
const combo = field;
const panel = () => screen.getByRole("complementary", { name: "Conversa" });
const fail = (code: string): ApiResult<never> => ({ ok: false, error: { kind: "conflict", code } }) as ApiResult<never>;

/** O Meu chat, com uma conversa já existente (a barra a mostra), aberto pela linha dela. */
async function openGeneral(setup: ChatSetup = {}) {
  const user = userEvent.setup();
  const view = renderChats({ ...setup, seed: (chat) => { chat.seedGeneral([{ person: "oi", assistant: "olá" }]); setup.seed?.(chat); } });
  await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
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
    await user.type(field(), "olá @");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(options(list).map((option) => option.textContent)).toEqual([expect.stringContaining("Bia"), expect.stringContaining("Caio")]);
    expect(combo()).toHaveValue("olá @");
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    expect(combo()).toHaveAttribute("aria-activedescendant", options(list)[0]!.id);
    await user.type(combo(), "bi");
    expect(combo()).toHaveValue("olá @bi");
    expect(options(await screen.findByRole("listbox", { name: "Pessoas" }))).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("olá ");
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
  });

  it("escolhe com as setas e confirma com Tab, sem tirar o foco do campo", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    await user.keyboard("{ArrowDown}");
    expect(combo()).toHaveAttribute("aria-activedescendant", options(list)[1]!.id);
    expect(options(list)[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Tab}");
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remover menção a Caio" })).toBeInTheDocument();
    expect(field()).toHaveValue("");
  });

  it("Esc fecha só o seletor e o texto digitado fica como texto", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "olá @bi");
    await screen.findByRole("listbox", { name: "Pessoas" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(panel()).toBeInTheDocument();
    expect(field()).toHaveValue("olá @bi");
    expect(field()).toHaveFocus();
  });

  it("não abre no meio de uma palavra, e @Bia colado fica como texto, sem menção", async () => {
    const { user, client } = await openGeneral();
    await user.type(field(), "a@");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(field(), { target: { value: "@Bia oi" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("@Bia oi");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledWith(expect.any(String), { body: "@Bia oi" }, expect.anything()));
  });

  it("não existe o botão Mencionar nem o 'Sobre o ticket…'", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "Bia");
    await user.type(field(), " @");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "Mencionar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sobre o ticket…" })).toBeNull();
    expect(screen.queryByText("Sobre o ticket")).toBeNull();
  });

  it("quem não enxerga o projeto do ticket aparece apagado, com o motivo, e não se escolhe", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }, { personId: "person-2", role: "reader" }] });
    const { user } = await openTicket({ projects: [project] });
    await user.type(field(), "@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    const [bia, caio] = options(list);
    expect(bia).not.toHaveAttribute("aria-disabled");
    expect(caio).toHaveAttribute("aria-disabled", "true");
    expect(caio).toHaveTextContent("Não enxerga o projeto deste ticket");
    await user.click(caio!);
    expect(screen.queryByRole("button", { name: "Remover menção a Caio" })).toBeNull();
    // As setas passam também pela opção apagada (o leitor de tela ouve o motivo), mas `Enter` nela não confirma nem envia.
    await user.keyboard("{ArrowDown}");
    expect(combo()).toHaveAttribute("aria-activedescendant", caio!.id);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox", { name: "Pessoas" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remover menção/ })).toBeNull();
    await user.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remover menção a Caio" })).toBeNull();
  });

  it("no último nível o @ não abre seletor (a conversa explica por quê)", async () => {
    const user = userEvent.setup();
    renderChats({
      seed: (c) => {
        let parent = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        for (let depth = 1; depth <= 9; depth++) parent = c.openThreadIn(parent, { from: "person-1", body: `nível ${depth}`, to: ["person-2"] });
      },
    });
    const rows = await screen.findAllByRole("button", { name: /Thread com Bia/ });
    await user.click(rows.at(-1)!);
    expect(await within(panel()).findByText(/último nível/)).toBeInTheDocument();
    await user.type(await screen.findByRole("combobox", { name: "Responder na thread" }), "@");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mencionar" })).toBeNull();
  });
});

describe("o seletor de tickets", () => {
  it("abre com #, carrega os tickets na primeira vez, mostra chave, título e caminho, filtra e confirma com #CHAVE e um espaço", async () => {
    const { user, client } = await openGeneral();
    expect(client.listTickets).not.toHaveBeenCalled();
    await user.type(field(), "Como está o #");
    const list = await screen.findByRole("listbox", { name: "Tickets" });
    await waitFor(() => expect(options(list).length).toBeGreaterThan(0));
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    expect(client.listTickets).toHaveBeenCalledWith("p1");
    await user.type(combo(), "publ");
    await waitFor(() => expect(options(screen.getByRole("listbox", { name: "Tickets" }))).toHaveLength(1));
    const [only] = options(screen.getByRole("listbox", { name: "Tickets" }));
    expect(only).toHaveTextContent("ALFA-2");
    expect(only).toHaveTextContent("Publicar a versão");
    expect(only).toHaveTextContent("Projeto Alfa");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("Como está o #ALFA-2 ");
    expect(field()).toHaveFocus();
  });

  it("procura também pela chave, e Esc deixa o #texto como texto", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "#alfa-1");
    const list = await screen.findByRole("listbox", { name: "Tickets" });
    await waitFor(() => expect(options(list)).toHaveLength(1));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("#alfa-1");
  });

  it("avisa quando a lista não carrega e deixa tentar de novo", async () => {
    const { user, client } = await openGeneral({ prepare: (api) => void vi.mocked(api.listTickets).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>) });
    await user.type(field(), "#");
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os tickets.");
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(client.listTickets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(options(screen.getByRole("listbox", { name: "Tickets" })).length).toBeGreaterThan(0));
  });
});

describe("a linha que diz o que vai acontecer", () => {
  const notice = () => screen.getByRole("status", { name: "O que vai acontecer" });
  it("não aparece sem @ nem #", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "oi");
    expect(notice()).toBeEmptyDOMElement();
  });

  it("um ticket no Meu chat: vai para a conversa dele (a chave digitada inteira vale sem a lista; colada também)", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "Como está o #ALFA-1 ");
    await waitFor(() => expect(notice()).toHaveTextContent("Vai para a conversa do ALFA-1."));
    fireEvent.change(field(), { target: { value: "olha #ALFA-2" } });
    await waitFor(() => expect(notice()).toHaveTextContent("Vai para a conversa do ALFA-2."));
  });

  it("um ticket e uma pessoa no Meu chat: abre a conversa do ticket e, dentro dela, a thread", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "#ALFA-1 consegue ver, ");
    await user.type(field(), "@");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(notice()).toHaveTextContent("Abre a conversa do ALFA-1 e, dentro dela, uma thread com Bia."));
  });

  it("só uma pessoa: abre uma thread com ela", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "oi @");
    await user.keyboard("{Enter}");
    expect(notice()).toHaveTextContent(/abre uma thread com Bia/);
  });

  it("dois tickets no Meu chat, ou um # no chat de um ticket: fica na conversa e o assistente lê os tickets", async () => {
    const general = await openGeneral();
    await general.user.type(field(), "#ALFA-1 depende do #ALFA-2 ");
    await waitFor(() => expect(notice()).toHaveTextContent("Fica nesta conversa. O assistente lê os tickets citados."));
    general.unmount();
    const { user } = await openTicket();
    await user.type(field(), "e o #ALFA-2? ");
    await waitFor(() => expect(notice()).toHaveTextContent("Fica nesta conversa. O assistente lê os tickets citados."));
  });

  it("numa thread entre pessoas o # é só referência, sem dizer que o assistente lê", async () => {
    const user = userEvent.setup();
    renderChats({ seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] }); } });
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await user.type(await screen.findByRole("combobox", { name: "Responder na thread" }), "veja o #ALFA-2 ");
    await waitFor(() => expect(notice()).toHaveTextContent("Fica nesta thread. Os tickets citados são só referência."));
  });

  it("chave que a pessoa não enxerga ou que não existe é só texto: sem aviso", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "veja o #ZZZ-9 ");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(notice()).toBeEmptyDOMElement();
  });
});

describe("o caminho do # no Meu chat", () => {
  const sentIds = (client: ReturnType<typeof renderChats>["client"]) => vi.mocked(client.sendChatMessage).mock.calls.map(([id]) => id);

  it("um ticket: abre a conversa dele, manda a mensagem para lá (nunca para o Meu chat) e leva o painel até ela", async () => {
    const { user, client, chat } = await openGeneral();
    await user.type(field(), "Como está o #ALFA-1 ?");
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
    await user.type(field(), "#ALFA-1 consegue ver, ");
    await user.type(field(), "@bi");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.sendChatMessage).toHaveBeenCalledWith(chat.principalOf("t1"), { body: "#ALFA-1 consegue ver, ", mentions: ["person-2"] }, expect.anything());
    const trail = await within(panel()).findByRole("navigation", { name: "Onde você está" });
    expect(within(trail).getByRole("button", { name: "ALFA-1" })).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "Responder na thread" })).toBeInTheDocument();
  });

  it("dois tickets: a mensagem fica no Meu chat e nenhuma conversa de ticket é aberta", async () => {
    const { user, client, chat } = await openGeneral();
    await user.type(field(), "#ALFA-1 depende do #ALFA-2 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sentIds(client)).toEqual([chat.generalOf()]);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: /Abrir o ticket/ })).toBeNull();
  });

  it("no chat de um ticket o # é referência: a mensagem fica onde está, mesmo citando outro ticket", async () => {
    const { user, client, chat } = await openTicket();
    await user.type(field(), "e o #ALFA-2? ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sentIds(client)).toEqual([chat.principalOf("t1")]);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
  });

  it("numa thread o # é referência: a resposta fica na thread", async () => {
    const user = userEvent.setup();
    const { client, chat } = renderChats({ seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] }); } });
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await user.type(await screen.findByRole("combobox", { name: "Responder na thread" }), "veja o #ALFA-2 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(chat.principalOf("t1")).toBeDefined();
  });

  it("chave que não é de ticket visível não leva a lugar nenhum", async () => {
    const { user, client, chat } = await openGeneral();
    await user.type(field(), "veja o #ZZZ-9 ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sentIds(client)).toEqual([chat.generalOf()]);
    expect(client.openTicketConversation).not.toHaveBeenCalled();
  });

  it("falha depois de abrir a conversa: o texto volta ao campo, na conversa do ticket, e reenviar não duplica", async () => {
    const { user, client, chat } = await openGeneral();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce(fail("chat_busy"));
    await user.type(field(), "Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    await waitFor(() => expect(field()).toHaveValue("Como está o #ALFA-1 ?"));
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
    await user.type(field(), "Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("alert")).toBeInTheDocument();
    expect(field()).toHaveValue("Como está o #ALFA-1 ?");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it("nenhuma chamada manda ticketId", async () => {
    const { user, client } = await openGeneral();
    await user.type(field(), "#ALFA-1 vê, ");
    await user.type(field(), "@");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    for (const [, body] of vi.mocked(client.sendChatMessage).mock.calls) expect(body).not.toHaveProperty("ticketId");
  });
});

describe("os elos nas mensagens", () => {
  it("#CHAVE de ticket visível vira elo que abre o ticket; o que não existe fica texto", async () => {
    const { user, onShowTicket } = await openGeneral({ seed: (chat) => void chat.seedConversation("t1", [{ person: "veja o #ALFA-2 e o #ZZZ-9", assistant: "ok" }]) });
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    const link = await within(panel()).findByRole("link", { name: /ALFA-2.*Publicar a versão/ });
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
    const { user, onShowTicket } = await openGeneral({ reply: () => "Veja ALFA-2 e também #ALFA-1." });
    await user.type(field(), "o que falta?{Enter}");
    const first = await within(panel()).findByRole("link", { name: /ALFA-2/ });
    const second = await within(panel()).findByRole("link", { name: /ALFA-1/ });
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
    await user.type(field(), "oi @zed");
    expect(await screen.findByText("Ninguém para mencionar.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field()).toHaveValue("oi @zed");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    // Sem a lista, o Enter seguinte envia.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
  });

  it("com as pessoas ainda carregando, Enter não envia o @ cru", async () => {
    const hold = gate();
    const { user, client } = await openGeneral({ prepare: (api) => { const listPeople = api.listPeople; api.listPeople = vi.fn(async () => { await hold.opened; return listPeople(); }); } });
    await user.type(field(), "@bi");
    expect(await screen.findByText("Carregando as pessoas…")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(field()).toHaveValue("@bi");
    hold.open();
  });

  it("com todas as opções apagadas, Enter não confirma nem envia", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }] });
    const { user, client } = await openTicket({ projects: [project] });
    await user.type(field(), "@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(options(list).every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
    await user.keyboard("{Enter}");
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Remover menção/ })).toBeNull();
    expect(field()).toHaveValue("@");
  });

  it("a lista fecha quando o campo perde o foco (Tab ou clique fora), e o campo deixa de estar expandido", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "oi @");
    await screen.findByRole("listbox", { name: "Pessoas" });
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    await user.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combo()).toHaveAttribute("aria-expanded", "false");
    await user.click(field());
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(field(), "#");
    await screen.findByRole("listbox", { name: "Tickets" });
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicar numa opção continua valendo (o foco não sai do campo)", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "@");
    await user.click(within(await screen.findByRole("listbox", { name: "Pessoas" })).getByRole("option", { name: /Bia/ }));
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("o campo é sempre uma caixa de combinação: o papel não muda no meio da digitação", async () => {
    const { user } = await openGeneral();
    expect(combo()).toHaveAttribute("aria-expanded", "false");
    expect(combo()).not.toHaveAttribute("aria-controls");
    await user.type(field(), "@");
    expect(screen.getByRole("combobox", { name: "Mensagem" })).toBeInTheDocument();
    expect(combo()).toHaveAttribute("aria-controls", (await screen.findByRole("listbox")).id);
  });
});

describe("o gatilho e o texto em volta", () => {
  it("com o cursor no meio do trecho (@bi|a), confirmar troca o trecho inteiro", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "olá @bia");
    await user.keyboard("{ArrowLeft}");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(options(list)).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(field()).toHaveValue("olá ");
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
  });

  it("@ digitado sobre uma seleção a substitui e abre a lista", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "texto velho");
    await user.type(field(), "@", { initialSelectionStart: 0, initialSelectionEnd: 11 });
    expect(await screen.findByRole("listbox", { name: "Pessoas" })).toBeInTheDocument();
    expect(field()).toHaveValue("@");
  });

  it("C# não abre a lista, e # no começo de uma linha abre", async () => {
    const { user } = await openGeneral();
    await user.type(field(), "C#");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(field(), " e outra{Shift>}{Enter}{/Shift}#");
    expect(await screen.findByRole("listbox", { name: "Tickets" })).toBeInTheDocument();
  });
});

describe("os destinos do # só valem para citações de verdade", () => {
  it("# dentro de endereço, de código ou colado numa palavra não leva a lugar nenhum e não pede a lista", async () => {
    const { user, client, chat } = await openGeneral();
    await user.click(field());
    await user.paste("veja https://app/p#ALFA-1 e `#ALFA-1` e abc#ALFA-1 ");
    expect(screen.getByRole("status", { name: "O que vai acontecer" })).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.generalOf());
    expect(client.openTicketConversation).not.toHaveBeenCalled();
    expect(client.listTickets).not.toHaveBeenCalled();
  });

  it("a mesma chave repetida conta uma vez: ainda vai para a conversa do ticket", async () => {
    const { user, client, chat } = await openGeneral();
    await user.type(field(), "#ALFA-1 e de novo #ALFA-1 ");
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
    await user.paste("#UTF-8 ");
    expect(client.listTickets).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    expect(client.listTickets).not.toHaveBeenCalled();
  });

  it("no Meu chat, uma chave com `#` de outro projeto (UTF-8) não espera carga e fica onde está", async () => {
    const { user, client, chat } = await openGeneral();
    await user.click(field());
    await user.paste("#UTF-8 ");
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
    await user.type(field(), "#ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("alert")).toHaveTextContent("Não foi possível conferir os tickets citados");
    expect(field()).toHaveValue("#ALFA-1 oi ");
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
    await user.type(field(), "#");
    await screen.findByText("Não foi possível carregar os tickets.");
    await user.keyboard("{Escape}");
    failing = false;
    await user.type(field(), "ALFA-1 oi ");
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
    await user.type(field(), "#ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
    // Uma chave do projeto que não carregou não se trata como "não existe".
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await user.type(await screen.findByRole("combobox", { name: "Mensagem" }), "#BETA-1 e depois ");
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
    await user.type(field(), "#");
    await waitFor(() => expect(options(screen.getByRole("listbox", { name: "Tickets" })).length).toBe(2));
    await user.keyboard("{Escape}");
    await user.clear(field());
    list.current = [...list.current, makeTicket("t3", "p1", 3, "Novo", { key: "ALFA-3" })];
    const loads = vi.mocked(client.listTickets).mock.calls.length;
    await user.type(field(), "#ALFA-1 depende de #ALFA-3 ");
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
      await user.type(field(), "#");
      await screen.findByRole("listbox", { name: "Tickets" });
      await waitFor(() => expect(client.listTickets).toHaveBeenCalledTimes(1));
      await user.keyboard("{Escape}");
      await user.clear(field());
      vi.setSystemTime(Date.now() + 31_000);
      await user.type(field(), "#");
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
    await user.type(field(), "#ALFA-1 oi ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("Conferindo os tickets citados…")).toBeInTheDocument();
    expect(field()).toHaveAttribute("readonly");
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
    await user.type(field(), "Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    expect(await within(panel()).findByText("O assistente está respondendo…")).toBeInTheDocument();
    expect(within(panel()).getAllByText("Como está o #ALFA-1 ?").length).toBeGreaterThan(0);
    expect(field()).toHaveValue("");
    hold.open();
    expect(await within(panel()).findByText("Resposta do assistente.")).toBeInTheDocument();
    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("falha do provedor na conversa do ticket: a mensagem fica 'sem resposta' com 'Tentar de novo', e repetir não duplica", async () => {
    const { user, client, chat } = await openGeneral();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as ApiResult<never>);
    await user.type(field(), "Como está o #ALFA-1 ?");
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
    await user.type(field(), "Como está o #ALFA-1 ?");
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
    await user.click(await screen.findByRole("button", { name: /Meu chat/ }));
    await user.type(await screen.findByRole("combobox", { name: "Mensagem" }), "Como está o #ALFA-1 ?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
    expect(client.openGeneralConversation).not.toHaveBeenCalled();
    expect(sent(client)[0]![0]).toBe(chat.principalOf("t1"));
    expect(chat.generalOf()).toBeUndefined();
  });

  it("a recusa do servidor chega marcada também no caminho do #: a pastilha fica recusada e o texto volta ao campo", async () => {
    const { user, client } = await openGeneral();
    vi.mocked(client.sendChatMessage).mockResolvedValueOnce({ ok: false, error: { kind: "conflict", code: "mention_not_allowed", details: { personIds: ["person-2"] } } } as ApiResult<never>);
    await user.type(field(), "#ALFA-1 olha, ");
    await mention(user, "Bia", field());
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    expect(await within(panel()).findByRole("button", { name: /Abrir o ticket ALFA-1/ })).toBeInTheDocument();
    await waitFor(() => expect(field()).toHaveValue("#ALFA-1 olha, "));
    expect(await screen.findByText("não pode ser marcada aqui")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remover menção a Bia" })).toBeInTheDocument();
  });

  it("pessoa marcada antes do #: se ela não enxerga o projeto do ticket citado, a pastilha fica recusada, com o motivo, antes do envio", async () => {
    const project = makeProject("p1", "ALFA", "Projeto Alfa", { visibility: "private", members: [{ personId: "person-1", role: "manager" }, { personId: "person-2", role: "reader" }] });
    const { user, client } = await openGeneral({ projects: [project] });
    await user.type(field(), "oi ");
    await mention(user, "Caio", field());
    expect(screen.getByRole("button", { name: "Abrir thread" })).toBeEnabled();
    await user.type(field(), "olha o #ALFA-1 ");
    expect(await screen.findByText("Não enxerga o projeto deste ticket", { selector: "small" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abrir thread" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remover menção a Caio" }));
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("a thread e o chat de um ticket guardam o destino", () => {
  it("numa thread, o # é referência: a resposta vai para a própria thread", async () => {
    const user = userEvent.setup();
    let threadId = "";
    const { client } = renderChats({ seed: (c) => { const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]); threadId = c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] }); } });
    await user.click(await screen.findByRole("button", { name: /Thread com Bia/ }));
    await user.type(await screen.findByRole("combobox", { name: "Responder na thread" }), "veja o #ALFA-2 ");
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
    const rows = await screen.findAllByRole("button", { name: /Thread com Bia|o prazo do login/ });
    // A primeira thread está debaixo do ticket (outras pessoas na linha de cima): ficou pelos nomes. A segunda repete a Bia.
    expect(rows[0]).toHaveTextContent("Thread com Bia");
    expect(rows[1]).toHaveTextContent("o prazo do login");
    expect(rows[1]).not.toHaveTextContent("Thread com Bia");
  });
});

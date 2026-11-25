import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ALFA1, renderChats } from "./chatTesting.js";
import { useChats } from "./ChatsContext.js";
import { composer, newThreadHead, typeInComposer } from "./composerTesting.js";
import { mention } from "./mentionTesting.js";

// ADR 0059 (TREEPM-417): fechar conversa na barra, "Fechadas (N)", reabrir pelos três caminhos e o campo que vira a thread que vai nascer.
// Tudo sob `StrictMode` (o padrão de `renderChats`).

const panel = () => screen.findByRole("complementary", { name: "Conversa" });
const rowTitles = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].map((row) => row.querySelector(".conv-title")?.textContent ?? "");
const closeButtonOf = (title: RegExp | string) => {
  const row = [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].find((candidate) => (typeof title === "string" ? candidate.textContent?.startsWith(title) : title.test(candidate.textContent ?? "")))!;
  return within(row.closest("li")!.querySelector<HTMLElement>(".conv-line")!).getByRole("button", { name: /^Fechar conversa/, hidden: true });
};

/** O ticket ALFA-1 com a conversa principal e, dentro dela, "Thread com Bia" e, dentro dessa, "Thread com Bia +1". */
const seedTree = (chat: Parameters<NonNullable<Parameters<typeof renderChats>[0]>["seed"] & object>[0]) => {
  const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
  const d1 = chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"], replies: [{ from: "person-2", body: "Já vi" }] });
  const d2 = chat.openThreadIn(d1, { from: "person-1", body: "e o Caio?", to: ["person-3"] });
  chat.readAll();
  return { main, d1, d2 };
};

describe("fechar na barra lateral", () => {
  it("o × está em toda linha de conversa que fecha, menos no Meu chat e no ticket sem conversa", async () => {
    renderChats({ seed: (chat) => void seedTree(chat) });
    await screen.findByRole("button", { name: /^ALFA-1/ });
    const buttons = screen.getAllByRole("button", { name: /^Fechar conversa/, hidden: true });
    // O ticket com conversa, a thread e a thread de dentro; o Meu chat não tem.
    expect(buttons).toHaveLength(3);
    const general = [...document.querySelectorAll("button.conv-row")].find((row) => row.classList.contains("is-general"))!;
    expect(within(general.closest("li")!.querySelector<HTMLElement>(".conv-line")!).queryByRole("button", { name: /^Fechar conversa/, hidden: true })).toBeNull();
  });

  it("fechar tira a linha e as de dentro na hora, mostra o aviso, e Desfazer reabre todas as que o servidor devolveu", async () => {
    const { chat, client } = renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ });
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    expect(await screen.findByText("2 conversas fechadas.")).toBeInTheDocument();
    expect(client.closeConversation).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(rowTitles().join("|")).not.toContain("Thread com Bia"));
    // As de dentro foram juntas, só para esta pessoa.
    expect(chat.isClosedFor(chat.principalOf("t1")!)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com Bia"))).toHaveLength(2));
    expect(client.reopenConversation).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("2 conversas fechadas.")).toBeNull();
  });

  it("o aviso some sozinho", async () => {
    renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ });
    const { CLOSED_NOTICE_MS } = await import("./ChatsContext.js");
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    expect(await screen.findByText("2 conversas fechadas.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("2 conversas fechadas.")).toBeNull(), { timeout: CLOSED_NOTICE_MS + 3000 });
  }, 20_000);

  it("se a fechada era a aberta no painel, o painel volta para a conversa de cima; sem conversa de cima, fecha", async () => {
    const { chat } = renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    const thread = await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ });
    await user.click(thread);
    expect(await within(await panel()).findByText("Já vi")).toBeInTheDocument();
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    // A conversa de cima é a principal do ticket.
    await waitFor(() => expect(screen.getByRole("button", { name: /^ALFA-1/ })).toHaveAttribute("aria-current", "true"));
    expect(await within(await panel()).findByText("olá")).toBeInTheDocument();
    // Fechar a principal (que está aberta e não tem nada acima na barra): o painel fecha.
    await user.click(closeButtonOf(/^ALFA-1/));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Conversa" })).toBeNull());
    expect(chat.isClosedFor(chat.principalOf("t1")!)).toBe(true);
  });

  it("volta sozinha quando chega mensagem de outra pessoa, e só a que recebeu a mensagem", async () => {
    let ids: ReturnType<typeof seedTree> | undefined;
    const { chat } = renderChats({ seed: (c) => void (ids = seedTree(c)) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ });
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    await waitFor(() => expect(rowTitles().join("|")).not.toContain("Thread com Bia"));
    chat.receiveReply(ids!.d2, { from: "person-3", body: "voltei com novidade" });
    // A lista se atualiza ao abrir uma conversa (e a cada 30 s): abrir o Meu chat a atualiza.
    await user.click(screen.getByRole("button", { name: /^Meu chat/ }));
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com Bia"))).toHaveLength(1));
    expect(chat.isClosedFor(ids!.d1)).toBe(true);
    expect(chat.isClosedFor(ids!.d2)).toBe(false);
  });
});

describe("Fechadas (N)", () => {
  it("fica recolhida, abre com a lista plana e Reabrir em cada uma, e some quando N é zero", async () => {
    renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ });
    expect(screen.queryByRole("button", { name: /Fechadas/ })).toBeNull();
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    const toggle = await screen.findByRole("button", { name: "Fechadas (2)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Conversas fechadas" })).toBeNull();
    await user.click(toggle);
    const list = screen.getByRole("list", { name: "Conversas fechadas" });
    expect(within(list).getAllByRole("button", { name: /^Reabrir/ })).toHaveLength(2);
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(list).getAllByRole("button", { name: /^Reabrir/ })[0]!);
    await screen.findByRole("button", { name: "Fechadas (1)" });
    await user.click(within(screen.getByRole("list", { name: "Conversas fechadas" })).getByRole("button", { name: /^Reabrir/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Fechadas/ })).toBeNull());
  });
});

describe("reabrir por outros caminhos", () => {
  it("o cartão da thread fechada na conversa de cima abre a conversa com a faixa 'Você fechou esta conversa'; Reabrir tira a faixa", async () => {
    renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    await screen.findByRole("button", { name: "Fechadas (2)" });
    // A principal continua aberta no painel; o cartão da thread fechada continua nela.
    const card = await within(await panel()).findByRole("button", { name: /^Thread com Bia.*resposta/ });
    await user.click(card);
    const band = await screen.findByText("Você fechou esta conversa");
    expect(band).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Reabrir/ }));
    await waitFor(() => expect(screen.queryByText("Você fechou esta conversa")).toBeNull());
  });

  it("abrir o chat pelo ticket mostra a faixa quando a conversa do ticket está fechada", async () => {
    function OpenTicket() {
      const chats = useChats()!;
      return <button type="button" onClick={() => chats.openTicket("t1")}>abrir pelo ticket</button>;
    }
    renderChats({ seed: (c) => void seedTree(c), extra: <OpenTicket /> });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await user.click(closeButtonOf(/^ALFA-1/));
    await screen.findByRole("button", { name: /Fechadas/ });
    await user.click(screen.getByRole("button", { name: "abrir pelo ticket" }));
    expect(await screen.findByText("Você fechou esta conversa")).toBeInTheDocument();
  });

  it("escrever numa conversa fechada a reabre", async () => {
    const { chat } = renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await user.click(closeButtonOf(/Thread com Bia(?! \+)/));
    await screen.findByRole("button", { name: "Fechadas (2)" });
    await user.click(await within(await panel()).findByRole("button", { name: /^Thread com Bia.*resposta/ }));
    await screen.findByText("Você fechou esta conversa");
    await composer();
    typeInComposer("voltei");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByText("Você fechou esta conversa")).toBeNull());
    expect(chat.isClosedFor(chat.principalOf("t1")!)).toBe(false);
  });
});

describe("o campo: a thread que vai nascer", () => {
  it("todas as marcadas já participam: nenhum cabeçalho, botão Enviar e a mensagem comum com o nome destacado", async () => {
    const { client } = renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ }));
    await composer();
    typeInComposer("Boa, ");
    await mention("Bia");
    expect(newThreadHead()).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir thread" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledWith(expect.any(String), { body: expect.stringContaining("person:person-2"), mentions: ["person-2"] }, expect.anything()));
    const log = await within(await panel()).findByText(/Boa,/);
    expect(log.closest("li")?.querySelector(".chat-thread-footer")).toBeNull();
    expect(within(log.closest("li") as HTMLElement).getByText("@Bia")).toBeInTheDocument();
  });

  it("alguém de fora: cabeçalho com o contorno da thread, 'entram junto' com quem já estava, e tirar a pessoa desfaz na hora", async () => {
    renderChats({ seed: (c) => void seedTree(c) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ }));
    await composer();
    typeInComposer("Caio, olha ");
    await mention("Caio");
    expect(newThreadHead()).toHaveTextContent("Nova thread");
    expect(newThreadHead()).toHaveTextContent("com Caio");
    expect(newThreadHead()).toHaveTextContent("entra junto");
    expect(document.querySelector(".chat-composer")).toHaveClass("is-new-thread");
    expect(document.querySelector(".mention-person.is-outside")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Abrir thread" })).toBeEnabled();
    const { pressInComposer } = await import("./composerTesting.js");
    pressInComposer("Backspace");
    if (newThreadHead() !== null) pressInComposer("Backspace");
    await waitFor(() => expect(newThreadHead()).toBeNull());
    expect(document.querySelector(".chat-composer")).not.toHaveClass("is-new-thread");
  });

  it("a conversa só da pessoa (ticket): qualquer pessoa marcada é de fora e o cabeçalho diz com quem", async () => {
    renderChats({ seed: (c) => void c.seedConversation(ALFA1.id, [{ person: "oi", assistant: "olá" }]) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^ALFA-1/ }));
    await composer();
    typeInComposer("Bia, ");
    await mention("Bia");
    expect(newThreadHead()).toHaveTextContent("Nova thread");
    expect(newThreadHead()).toHaveTextContent("com Bia");
    expect(newThreadHead()?.textContent).not.toContain("entram junto");
    await act(async () => undefined);
  });
});

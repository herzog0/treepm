import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeApiError } from "../api/errorText.js";
import i18n from "../i18n/index.js";
import { CLOSED_NOTICE_MS } from "./ChatsContext.js";
import { renderChats } from "./chatTesting.js";

// ADR 0059, revisão da tela (TREEPM-417): o estado do fechar e do desfazer (dois fechamentos, falhas, foco, tempo) e o rótulo das "Fechadas".

type Chat = Parameters<NonNullable<Parameters<typeof renderChats>[0]>["seed"] & object>[0];
/** ALFA-1 com a conversa principal e, dentro dela, "Thread com Bia" (d1) e "Thread com Caio" (d2), irmãs; d2 tem uma filha "Thread com Bia +1"? não: só as duas. */
const seedSiblings = (chat: Chat) => {
  const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
  const d1 = chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
  const d2 = chat.openThreadIn(main, { from: "person-1", body: "Caio, olha", to: ["person-3"] });
  chat.readAll();
  return { main, d1, d2 };
};
const rowTitles = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].map((row) => row.querySelector(".conv-title")?.textContent ?? "");
const closeOf = (title: RegExp) => {
  const row = [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")].find((candidate) => title.test(candidate.textContent ?? ""))!;
  return within(row.closest("li")!.querySelector<HTMLElement>(".conv-line")!).getByRole("button", { name: /^Fechar conversa/, hidden: true });
};

afterEach(() => void vi.useRealTimers());

describe("dois fechamentos dentro da janela do aviso", () => {
  it("o aviso junta os dois e diz no plural, e Desfazer reabre as duas, mesmo com a primeira resposta chegando por último", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    // A primeira resposta demora mais que a segunda: a ordem de chegada não pode trocar o que o aviso desfaz.
    const original = vi.mocked(client.closeConversation).getMockImplementation()!;
    vi.mocked(client.closeConversation).mockImplementationOnce(async (id: string) => {
      const result = await original(id);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return result;
    });
    await user.click(closeOf(/^Thread com Bia/));
    await user.click(closeOf(/^Thread com Caio/));
    expect(await screen.findByText("2 conversas fechadas.")).toBeInTheDocument();
    await waitFor(() => expect(rowTitles().join("|")).not.toMatch(/Thread com/));
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com"))).toHaveLength(2));
    expect(client.reopenConversation).toHaveBeenCalledTimes(2);
  });

  it("o tempo recomeça a cada fechamento e para enquanto o ponteiro está em cima do aviso", async () => {
    vi.useFakeTimers();
    renderChats({ seed: (c) => void seedSiblings(c) });
    const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await pass(200);
    expect(rowTitles().join("|")).toContain("Thread com Bia");
    fireEvent.click(closeOf(/^Thread com Bia/));
    await pass(200);
    expect(screen.getByText("Conversa fechada.")).toBeInTheDocument();
    await pass(CLOSED_NOTICE_MS - 1000);
    // O segundo fechamento recomeça a contagem: passado mais (prazo - 1 s) o aviso ainda está lá.
    fireEvent.click(closeOf(/^Thread com Caio/));
    await pass(200);
    expect(screen.getByText("2 conversas fechadas.")).toBeInTheDocument();
    await pass(CLOSED_NOTICE_MS - 1000);
    expect(screen.getByText("2 conversas fechadas.")).toBeInTheDocument();
    // Com o ponteiro em cima o aviso não some, por mais tempo que passe.
    const toast = document.querySelector(".conv-toast")!;
    fireEvent.pointerEnter(toast);
    await pass(CLOSED_NOTICE_MS * 3);
    expect(screen.getByText("2 conversas fechadas.")).toBeInTheDocument();
    // Ao sair, a contagem recomeça por inteiro.
    fireEvent.pointerLeave(toast);
    await pass(CLOSED_NOTICE_MS - 1000);
    expect(screen.getByText("2 conversas fechadas.")).toBeInTheDocument();
    await pass(2000);
    expect(screen.queryByText("2 conversas fechadas.")).toBeNull();
  });
});

describe("fechar tira a linha na hora", () => {
  it("a linha some e o aviso aparece ANTES de a lista voltar do servidor (a atualização fica pendurada de propósito)", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    let release: () => void = () => {};
    const original = vi.mocked(client.listConversationTree).getMockImplementation()!;
    vi.mocked(client.listConversationTree).mockImplementation(() => new Promise((resolve) => { release = () => resolve(original()); }));
    await user.click(closeOf(/^Thread com Bia/));
    await waitFor(() => expect(rowTitles().join("|")).not.toContain("Thread com Bia"));
    expect(screen.getByText("Conversa fechada.")).toBeInTheDocument();
    // A lista do servidor ainda não voltou: a retirada foi otimista.
    expect(vi.mocked(client.listConversationTree).mock.results.at(-1)?.type).toBe("return");
    vi.mocked(client.listConversationTree).mockImplementation(original);
    release();
  });
});

describe("desfazer com uma filha que já estava fechada", () => {
  it("não reabre a que já estava fechada antes: o aviso só traz o que ESTE pedido fechou", async () => {
    let child = "";
    const { client } = renderChats({
      seed: (c) => {
        const main = c.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        const d1 = c.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        child = c.openThreadIn(d1, { from: "person-1", body: "e o Caio?", to: ["person-3"] });
        c.readAll();
      },
    });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia(?! \+)/ });
    // A filha foi fechada antes (outro dia): só depois a de cima.
    await client.closeConversation(child);
    await user.click(screen.getByRole("button", { name: /^Meu chat/ }));
    await waitFor(() => expect(rowTitles().join("|")).not.toContain("Thread com Bia +"));
    await user.click(closeOf(/^Thread com Bia/));
    // Só a de cima foi fechada neste pedido: o aviso fica no singular, e Desfazer reabre só ela.
    expect(await screen.findByText("Conversa fechada.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com Bia"))).toHaveLength(1));
    expect(rowTitles().join("|")).not.toContain("Thread com Bia +");
    expect(await screen.findByRole("button", { name: "Fechadas (1)" })).toBeInTheDocument();
  });
});

describe("falhas à vista", () => {
  it("Desfazer que falha mostra o erro traduzido e mantém no aviso o que faltou; tentar de novo reabre", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    await user.click(closeOf(/^Thread com Bia/));
    await user.click(closeOf(/^Thread com Caio/));
    await screen.findByText("2 conversas fechadas.");
    vi.mocked(client.reopenConversation).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as never);
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    // Uma reabriu, uma não: o erro aparece e o aviso fica com a que faltou.
    expect(await screen.findByText("A API está indisponível. Tente novamente em instantes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desfazer" })).toBeInTheDocument();
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com"))).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com"))).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Desfazer" })).toBeNull();
  });

  it("Reabrir da lista que falha mostra o erro devolvido", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    await user.click(closeOf(/^Thread com Bia/));
    await user.click(await screen.findByRole("button", { name: "Fechadas (1)" }));
    vi.mocked(client.reopenConversation).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } } as never);
    await user.click(screen.getByRole("button", { name: /^Reabrir: Thread com Bia/ }));
    expect(await within(screen.getByRole("list", { name: "Conversas fechadas" })).findByRole("alert")).toHaveTextContent("A API está indisponível. Tente novamente em instantes.");
  });

  it("fechar que falha com 404 mostra o erro e atualiza a lista; o erro some no próximo fechamento que dá certo", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    const before = vi.mocked(client.listConversationTree).mock.calls.length;
    vi.mocked(client.closeConversation).mockResolvedValueOnce({ ok: false, error: { kind: "not_found" } } as never);
    await user.click(closeOf(/^Thread com Bia/));
    expect(await screen.findByText("Não encontramos esse item. Ele pode ter sido removido.")).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(client.listConversationTree).mock.calls.length).toBeGreaterThan(before));
    // O próximo fechamento da mesma linha que dá certo limpa o erro.
    await user.click(closeOf(/^Thread com Bia/));
    await screen.findByText("Conversa fechada.");
    expect(screen.queryByText("Não encontramos esse item. Ele pode ter sido removido.")).toBeNull();
  });
});

describe("o foco depois de fechar", () => {
  it("fechar pelo teclado leva o foco para Desfazer, e quando o aviso some ele vai para a linha vizinha, nunca para o body", async () => {
    renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    closeOf(/^Thread com Bia/).focus();
    await user.keyboard("{Enter}");
    const undo = await screen.findByRole("button", { name: "Desfazer" });
    await waitFor(() => expect(undo).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Desfazer" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest(".conv-section")).not.toBeNull();
  });
});

describe("região de leitura e nomes acessíveis", () => {
  it("a região do aviso existe vazia desde o início, e o × leva o nome da conversa", async () => {
    renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    const region = document.querySelector(".conv-toast-region")!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.textContent).toBe("");
    expect(screen.getByRole("button", { name: "Fechar conversa: Thread com Bia", hidden: true })).toBeInTheDocument();
    await user.click(closeOf(/^Thread com Bia/));
    await waitFor(() => expect(document.querySelector(".conv-toast-region")).toHaveTextContent("Conversa fechada."));
  });
});

describe("a lista Fechadas", () => {
  it("duas threads com a mesma pessoa em tickets diferentes são distinguíveis, e clicar no título abre a conversa com a faixa", async () => {
    renderChats({
      seed: (c) => {
        for (const ticket of ["t1", "t2"]) {
          const main = c.seedConversation(ticket, [{ person: "oi", assistant: "olá" }]);
          c.openThreadIn(main, { from: "person-1", body: `Bia, olha o ${ticket}`, to: ["person-2"], ticketId: ticket });
        }
        c.readAll();
      },
    });
    const user = userEvent.setup();
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com Bia"))).toHaveLength(2));
    await user.click(closeOf(/^Thread com Bia/));
    await waitFor(() => expect(rowTitles().filter((title) => title.startsWith("Thread com Bia"))).toHaveLength(1));
    await user.click(closeOf(/^Thread com Bia/));
    await user.click(await screen.findByRole("button", { name: "Fechadas (2)" }));
    const items = within(screen.getByRole("list", { name: "Conversas fechadas" })).getAllByRole("listitem");
    const texts = items.map((item) => item.textContent ?? "");
    expect(texts.some((text) => text.includes("ALFA-1"))).toBe(true);
    expect(texts.some((text) => text.includes("ALFA-2"))).toBe(true);
    expect(new Set(texts).size).toBe(2);
    await user.click(within(items[0]!).getAllByRole("button")[0]!);
    expect(await screen.findByText("Você fechou esta conversa")).toBeInTheDocument();
  });
});

describe("a recusa de marcar só a si mesma", () => {
  it("o fake devolve 422 de verdade e o texto traduzido sai nos três idiomas", async () => {
    const { client, chat } = renderChats({ seed: (c) => void c.seedGeneral([{ person: "oi", assistant: "olá" }]) });
    const general = (await client.openGeneralConversation()) as { ok: true; data: { id: string } };
    const me = (await client.getMe()) as { ok: true; data: { person: { id: string; displayName: string } } };
    const result = await client.sendChatMessage(general.data.id, { body: `[@${me.data.person.displayName}](person:${me.data.person.id}) oi`, mentions: [me.data.person.id] });
    expect(chat).toBeDefined();
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid", code: "assistant_mention_self" } });
    if (result.ok) throw new Error("devia falhar");
    expect(describeApiError(i18n.getFixedT("pt-BR"), result.error)).toContain("marcar você mesma não faz sentido");
    expect(describeApiError(i18n.getFixedT("en"), result.error)).toContain("marking yourself makes no sense");
    expect(describeApiError(i18n.getFixedT("es-MX"), result.error)).toContain("no tiene sentido");
  });
});

describe("últimos acertos do aviso (C5)", () => {
  it("fechar o que já estava fechado em outra aba (closedIds vazio): sem aviso com Desfazer vazio, só atualiza a lista", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    const before = vi.mocked(client.listConversationTree).mock.calls.length;
    vi.mocked(client.closeConversation).mockResolvedValueOnce({ ok: true, data: { closed: true, closedIds: [] } } as never);
    await user.click(closeOf(/^Thread com Bia/));
    await waitFor(() => expect(vi.mocked(client.listConversationTree).mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByRole("button", { name: "Desfazer" })).toBeNull();
    expect(document.querySelector(".conv-toast")).toBeNull();
  });

  it("Desfazer que termina depois de outro fechamento não apaga os ids do fechamento novo", async () => {
    const { client } = renderChats({ seed: (c) => void seedSiblings(c) });
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Thread com Bia/ });
    await user.click(closeOf(/^Thread com Bia/));
    await screen.findByText("Conversa fechada.");
    // O reabrir da primeira demora: enquanto isso a pessoa fecha a segunda.
    const original = vi.mocked(client.reopenConversation).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(client.reopenConversation).mockImplementationOnce(async (id: string) => {
      await gate;
      return original(id);
    });
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await user.click(closeOf(/^Thread com Caio/));
    release();
    await waitFor(() => expect(rowTitles().filter((title) => /Bia/.test(title))).toHaveLength(1));
    // Sobrou só o fechamento novo, com o seu Desfazer.
    expect(await screen.findByText("Conversa fechada.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(rowTitles().filter((title) => /Caio/.test(title))).toHaveLength(1));
  });

  it("o ponteiro que estava no aviso não prende o temporizador do aviso seguinte", async () => {
    vi.useFakeTimers();
    renderChats({ seed: (c) => void seedSiblings(c) });
    const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await pass(200);
    fireEvent.click(closeOf(/^Thread com Bia/));
    await pass(200);
    // Desfazer com o mouse: o ponteiro entra no aviso e o aviso some sem `pointerleave`.
    fireEvent.pointerEnter(document.querySelector(".conv-toast")!);
    fireEvent.click(screen.getByRole("button", { name: "Desfazer" }));
    await pass(200);
    expect(document.querySelector(".conv-toast")).toBeNull();
    // Novo aviso; o foco entra e sai dele (chama a conferência do ponteiro). O tempo tem de correr.
    fireEvent.click(closeOf(/^Thread com Bia/));
    await pass(200);
    const undo = screen.getByRole("button", { name: "Desfazer" });
    fireEvent.focus(undo);
    fireEvent.blur(undo);
    await pass(CLOSED_NOTICE_MS + 500);
    expect(document.querySelector(".conv-toast")).toBeNull();
  });
});

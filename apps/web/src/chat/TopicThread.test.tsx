import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useChats } from "./ChatsContext.js";
import { linkOf } from "./mentionTesting.js";
import { renderChats } from "./chatTesting.js";
import { composer, pickPerson, typeInComposer } from "./composerTesting.js";

const rowsOf = () => [...document.querySelectorAll<HTMLButtonElement>("button.conv-row")];
const inPanel = () => within(document.getElementById("chat-panel")!);
const rowText = (row: Element) => row.querySelector(".conv-title")!.textContent;

describe("a thread de assunto na barra lateral (ADR 0056)", () => {
  it("é uma linha sob o Meu chat, com a marca ✦, o título e a prévia, e nunca diz 'Thread com'", async () => {
    renderChats({
      seed: (chat) => {
        const general = chat.seedGeneral([{ person: "oi", assistant: "olá" }]);
        chat.seedTopic(general, { body: "Como divido a migração?", reply: "Em três passos: dados, código e corte.", title: "Dividir a migração" });
      },
    });
    const row = (await screen.findAllByRole("button")).find((button) => button.textContent?.includes("Dividir a migração"))!;
    expect(rowText(row)).toBe("Dividir a migração");
    expect(row.querySelector(".conv-topic-mark")).toHaveTextContent("✦");
    expect(row.querySelector(".conv-thread-mark")).toBeNull();
    expect(row.querySelector(".conv-preview")).toHaveTextContent("Em três passos");
    expect(row.style.getPropertyValue("--conv-level")).toBe("1");
    expect(rowsOf().map((r) => r.textContent).join("|")).not.toContain("Thread com");
    const general = rowsOf()[0]!;
    expect(row.closest("ul")!.closest("li")!.querySelector(":scope > button")).toBe(general);
  });

  it("sem título usa o começo da abertura (label); sem os dois, 'Assunto'", async () => {
    renderChats({
      seed: (chat) => {
        const general = chat.seedGeneral([{ person: "oi", assistant: "olá" }]);
        chat.seedTopic(general, { body: "Pergunta sem título dado", reply: "ok", title: null });
      },
    });
    await waitFor(() => expect(rowsOf().map(rowText)).toContain("Pergunta sem título dado"));
  });

  it("sem título e sem label do servidor, a linha diz 'Assunto'", async () => {
    renderChats({
      seed: (chat) => {
        const general = chat.seedGeneral([{ person: "oi", assistant: "olá" }]);
        chat.seedTopic(general, { body: "x", title: null });
      },
      prepare: (client) => {
        const list = client.listConversationTree;
        client.listConversationTree = async () => {
          const result = await list();
          if (!result.ok) return result;
          const strip = (nodes: typeof result.data.items): typeof result.data.items => nodes.map((node) => ({ ...node, label: null, children: strip(node.children) }));
          return { ok: true, data: { items: strip(result.data.items) } };
        };
      },
    });
    await waitFor(() => expect(rowsOf().some((row) => rowText(row) === "Assunto")).toBe(true));
  });
});

describe("a conversa aberta de uma thread de assunto", () => {
  const seedTopic = (chat: Parameters<NonNullable<Parameters<typeof renderChats>[0]>["seed"] & {}>[0]) => {
    const general = chat.seedGeneral([{ person: "oi", assistant: "olá" }]);
    return chat.seedTopic(general, { body: "Como divido a migração?", reply: "Em três passos.", title: "Dividir a migração" });
  };

  it("mostra a trilha e o título, diz que é só você e o assistente e não oferece 'Incluir pessoas'", async () => {
    const user = userEvent.setup();
    renderChats({ seed: (chat) => void seedTopic(chat) });
    await user.click(await screen.findByRole("button", { name: /Dividir a migração/ }));
    const trail = await screen.findByRole("navigation", { name: "Onde você está" });
    expect(within(trail).getByRole("button", { name: "Meu chat" })).toBeInTheDocument();
    expect(trail.querySelector("[aria-current=page]")).toHaveTextContent("Dividir a migração");
    expect(within(document.getElementById("chat-panel")!).getByText("Só você e o assistente")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Incluir pessoas/ })).toBeNull();
    expect(screen.queryByRole("list", { name: "Quem participa" })).toBeNull();
    // A abertura e a resposta do assistente estão lá.
    expect(await inPanel().findByText("Em três passos.")).toBeInTheDocument();
  });

  it("uma mensagem sem menção fala com o assistente (pendente, resposta), com o corpo puro e sem `topic`", async () => {
    const user = userEvent.setup();
    const { client } = renderChats({ seed: (chat) => void seedTopic(chat), reply: (text) => `Eco: ${text}` });
    await user.click(await screen.findByRole("button", { name: /Dividir a migração/ }));
    await composer("Mensagem");
    typeInComposer("E o corte?");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await inPanel().findByText("Eco: E o corte?")).toBeInTheDocument();
    const calls = (client.sendChatMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.at(-1)![1]).toEqual({ body: "E o corte?" });
  });

  it("marcar uma pessoa dentro dela abre uma thread com pessoas, como em qualquer conversa", async () => {
    const user = userEvent.setup();
    renderChats({ seed: (chat) => void seedTopic(chat) });
    await user.click(await screen.findByRole("button", { name: /Dividir a migração/ }));
    await composer("Mensagem");
    typeInComposer("@Bia");
    await pickPerson("Bia");
    typeInComposer(" olha isto");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(rowsOf().map(rowText)).toContain("Thread com Bia"));
  });
});

describe("o cartão do assunto na conversa de cima", () => {
  it("a mensagem que abriu o assunto traz a marca ✦, o título e 'N respostas', sem avatares de pessoas", async () => {
    const user = userEvent.setup();
    renderChats({
      seed: (chat) => {
        const general = chat.seedGeneral([{ person: "oi", assistant: "olá" }]);
        chat.seedTopic(general, { body: "Como divido a migração?", reply: "Em três passos.", title: "Dividir a migração" });
      },
    });
    await user.click((await screen.findAllByRole("button")).find((b) => b.classList.contains("conv-row") && b.textContent?.includes("Meu chat"))!);
    const log = await screen.findByRole("log");
    const card = await within(log).findByRole("button", { name: /Dividir a migração/ });
    expect(card).toHaveClass("is-topic");
    expect(card.querySelector(".chat-topic-mark")).toHaveTextContent("✦");
    expect(card.querySelector(".chat-avatars")).toBeNull();
    expect(card).toHaveTextContent("1 resposta");
    await user.click(card);
    expect(await screen.findByRole("navigation", { name: "Onde você está" })).toBeInTheDocument();
  });
});

describe("a barra de pedidos manda texto puro ao Meu chat", () => {
  it("um elo de pessoa colado na barra vira o @Nome simples: o assunto novo vai sem elo e sem menções", async () => {
    const Bar = () => {
      const chats = useChats()!;
      return <button type="button" onClick={() => void chats.startTopic(`Pergunta para ${linkOf("person-2", "Bia")} sobre o corte`)}>Pedir</button>;
    };
    const user = userEvent.setup();
    const { client } = renderChats({ seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]), extra: <Bar /> });
    await user.click(await screen.findByRole("button", { name: "Pedir" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    expect(vi.mocked(client.sendChatMessage).mock.calls[0]![1]).toEqual({ body: "Pergunta para @Bia sobre o corte", topic: true });
  });
});

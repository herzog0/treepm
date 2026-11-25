import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { personLink } from "@treepm/domain";
import { makeTicket } from "../test/fakes.js";
import { ALFA1, ALFA2, renderChats } from "./chatTesting.js";
import { composer, composerMentions, composerShown, composerText, fillComposer, pasteInComposer, pickPerson, newThreadHead, pickTicket, pressInComposer, typeInComposer } from "./composerTesting.js";
import { mention } from "./mentionTesting.js";
import { AssistantText, PersonText } from "./MessageText.js";
import { ticketsByKey } from "./mentions.js";

/** O Meu chat aberto com o campo pronto (o campo é o editor: estes testes dirigem o caminho de teclado dele, não um `textarea`). */
async function openGeneral(setup: Parameters<typeof renderChats>[0] = {}) {
  const user = userEvent.setup();
  const view = renderChats({ ...setup, seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]) });
  await user.click(await screen.findByRole("button", { name: /^Meu chat/ }));
  const field = await composer();
  return { user, field, ...view };
}

describe("o item de menção no campo da conversa", () => {
  it("um Backspace colado ao item de pessoa o apaga inteiro, e a pessoa sai da faixa", async () => {
    const { field } = await openGeneral();
    typeInComposer("oi");
    await mention("Bia");
    expect(composerMentions(field)).toEqual(["person-2"]);
    expect(newThreadHead()).toHaveTextContent("com Bia");
    // O cursor está logo depois do item e do espaço que o seguiu: um Backspace apaga o espaço, o seguinte, o item todo.
    pressInComposer("Backspace", field);
    expect(composerShown(field)).toBe("oi @Bia");
    pressInComposer("Backspace", field);
    expect(composerShown(field)).toBe("oi ");
    expect(composerMentions(field)).toEqual([]);
    expect(newThreadHead()).toBeNull();
  });

  it("Delete pela frente apaga o item inteiro; a seta passa por ele como por um caractere", async () => {
    const { field } = await openGeneral();
    typeInComposer("a ");
    await mention("Caio");
    typeInComposer("b");
    // texto: "a " + item + " b" (o item vale uma posição)
    const size = field.editor.state.doc.content.size;
    const before = field.editor.state.selection.from;
    pressInComposer("ArrowLeft", field);
    pressInComposer("ArrowLeft", field);
    expect(field.editor.state.selection.from).toBe(before - 2);
    pressInComposer("ArrowLeft", field);
    expect(field.editor.state.selection.from).toBe(before - 3);
    expect(field.editor.state.doc.content.size).toBe(size);
    pressInComposer("Delete", field);
    expect(composerMentions(field)).toEqual([]);
    expect(composerShown(field)).toBe("a  b");
  });

  it("um Backspace apaga também o item de ticket inteiro", async () => {
    const { field } = await openGeneral();
    typeInComposer("veja #alfa-2");
    await pickTicket("ALFA-2");
    expect(composerText(field)).toBe("veja #ALFA-2 ");
    pressInComposer("Backspace", field);
    pressInComposer("Backspace", field);
    expect(composerText(field)).toBe("veja ");
  });

  it("colar '@Bia' ou um elo de pessoa não cria menção; colar a chave de um ticket visível cria o item de ticket", async () => {
    const { field } = await openGeneral();
    pasteInComposer("@Bia oi ", field);
    expect(composerMentions(field)).toEqual([]);
    expect(screen.queryByRole("button", { name: /Remover menção/ })).toBeNull();
    pasteInComposer(`${personLink("person-2", "Bia")} `, field);
    expect(composerMentions(field)).toEqual([]);
    expect(composerShown(field)).toBe("@Bia oi @Bia ");
    // Os tickets chegam quando a lista do # abre a primeira vez.
    typeInComposer("#");
    await screen.findByRole("listbox", { name: "Tickets" });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Tickets" })).getAllByRole("option").length).toBeGreaterThan(0));
    pressInComposer("Escape", field);
    pasteInComposer("#ALFA-1 ", field);
    expect(composerText(field)).toContain("#ALFA-1 ");
    expect(field.editor.getJSON().content?.[0]?.content?.some((node) => node.type === "ticketMention")).toBe(true);
  });

  it("colar um elo aninhado ou HTML com item de pessoa também não cria menção", async () => {
    const { field } = await openGeneral();
    pasteInComposer(`[@\\[@Bob\\]\\(person:person-3\\)](person:person-2) `, field);
    expect(composerMentions(field)).toEqual([]);
    expect(composerText(field)).not.toContain("person:");
    pasteInComposer("", field, `<span class="mention-person" data-person-id="person-2" data-person-name="Bia">@Bia</span>`);
    pasteInComposer("@Bia ", field, `<span class="mention-person" data-person-id="person-2" data-person-name="Bia">@Bia</span>`);
    expect(composerMentions(field)).toEqual([]);
    expect(field.editor.getJSON().content?.[0]?.content?.some((node) => node.type === "personMention")).toBe(false);
  });

  it("o cabeçalho da thread e o texto são uma fonte só: duas menções da mesma pessoa, apagar uma, limpar o campo, apagar as duas", async () => {
    const { field } = await openGeneral();
    const node = { type: "personMention", attrs: { id: "person-2", name: "Bia" } };
    act(() => void field.editor.chain().focus().insertContent([node, { type: "text", text: " e " }, node, { type: "text", text: " " }]).run());
    expect(composerMentions(field)).toEqual(["person-2"]);
    expect(within(newThreadHead()!).getAllByText("com Bia")).toHaveLength(1);
    expect(composerText(field)).toBe(`${personLink("person-2", "Bia")} e ${personLink("person-2", "Bia")}`.concat(" "));
    // Apagar um dos dois: a pessoa continua na faixa.
    pressInComposer("Backspace", field);
    pressInComposer("Backspace", field);
    expect(composerText(field).match(/person:person-2/g)).toHaveLength(1);
    expect(newThreadHead()).toHaveTextContent("com Bia");
    // Limpar o campo tira todos os itens dela do texto e desfaz a thread que ia nascer.
    act(() => void field.editor.chain().focus("end").insertContent([{ type: "text", text: "x " }, node]).run());
    act(() => void field.editor.commands.clearContent(true));
    expect(composerMentions(field)).toEqual([]);
    expect(composerText(field)).not.toContain("person:");
    expect(newThreadHead()).toBeNull();
    // Apagar os dois itens (um depois do outro) também deixa a faixa vazia.
    act(() => void field.editor.chain().focus("end").insertContent([node, node]).run());
    pressInComposer("Backspace", field);
    expect(newThreadHead()).toHaveTextContent("com Bia");
    pressInComposer("Backspace", field);
    expect(newThreadHead()).toBeNull();
  });

  it("Enter com a lista aberta e vazia fecha a lista e não envia; o seguinte envia", async () => {
    const { field, client } = await openGeneral();
    typeInComposer("oi @zed");
    expect(await screen.findByText("Ninguém para mencionar.")).toBeInTheDocument();
    pressInComposer("Enter", field);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    expect(composerShown(field)).toBe("oi @zed");
    pressInComposer("Enter", field);
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalledTimes(1));
  });

  it("o corpo enviado leva os elos e `mentions` leva os mesmos ids; escolher outra pessoa pelo seletor não repete quem já está no texto", async () => {
    const { user, field, client } = await openGeneral();
    typeInComposer("oi");
    await mention("Bia");
    typeInComposer("@");
    const list = await screen.findByRole("listbox", { name: "Pessoas" });
    expect(within(list).queryByRole("option", { name: /Bia/ })).toBeNull();
    await pickPerson("Caio");
    await user.click(screen.getByRole("button", { name: "Abrir thread" }));
    await waitFor(() => expect(client.sendChatMessage).toHaveBeenCalled());
    const [, body] = vi_calls(client)[0]!;
    expect(body).toEqual({ body: `oi ${personLink("person-2", "Bia")} ${personLink("person-3", "Caio")}`, mentions: ["person-2", "person-3"] });
    expect(composerShown(field)).toBe("");
  });

  it("limpar o campo por fora (fillComposer) zera o texto e a faixa", async () => {
    const { field } = await openGeneral();
    await mention("Bia");
    fillComposer("", field);
    expect(composerMentions(field)).toEqual([]);
    expect(screen.queryByRole("button", { name: /Remover menção/ })).toBeNull();
  });
});

type Mock = { mock: { calls: unknown[][] } };
const vi_calls = (client: { sendChatMessage: unknown }) => (client.sendChatMessage as Mock).mock.calls;

describe("a leitura das mensagens (MessageText)", () => {
  const tickets = [makeTicket("t1", "p1", 1, "Corrigir o login", { key: "ALFA-1", status: "in_progress" })];
  const byKey = ticketsByKey({ p1: tickets });

  it("o elo de pessoa vira o destaque @Nome com o nome atual do diretório", () => {
    const text = `oi ${personLink("person-2", "Bia Antiga")}, tudo bem?`;
    const { container } = render(<PersonText text={text} names={new Map([["person-2", "Bia Nova"]])} />);
    const mark = container.querySelector(".mention-person")!;
    expect(mark).toHaveTextContent("@Bia Nova");
    expect(mark).not.toHaveClass("is-gone");
    expect(container).toHaveTextContent("oi @Bia Nova, tudo bem?");
    expect(container).not.toHaveTextContent("person:");
  });

  it("pessoa que não existe mais: o nome guardado, sem destaque; sem diretório (ainda carregando), o nome guardado também sem destaque", () => {
    const text = `oi ${personLink("person-9", "Zé")}`;
    const gone = render(<PersonText text={text} names={new Map([["person-2", "Bia"]])} />);
    expect(gone.container.querySelector(".mention-person")).toHaveClass("is-gone");
    expect(gone.container).toHaveTextContent("oi @Zé");
    gone.unmount();
    const loading = render(<PersonText text={text} />);
    expect(loading.container.querySelector(".mention-person")).toBeNull();
    expect(loading.container).toHaveTextContent("oi @Zé");
  });

  it("#CHAVE de ticket visível tem o desenho do item de menção (situação, chave e título), e abre o ticket", async () => {
    const opened: string[] = [];
    const { container } = render(<PersonText text="veja #ALFA-1 e #OUTRO-9" byKey={byKey} onOpenTicket={(id) => void opened.push(id)} />);
    const mark = container.querySelector(".description-mention")!;
    expect(mark).toHaveAttribute("data-state", "in_progress");
    expect(mark).toHaveAttribute("data-title", "Corrigir o login");
    expect(mark).toHaveTextContent("ALFA-1");
    expect(container).toHaveTextContent("e #OUTRO-9");
    await userEvent.click(screen.getByRole("link", { name: /^ALFA-1 Corrigir o login/ }));
    expect(opened).toEqual(["t1"]);
  });

  it("a resposta do assistente mostra #CHAVE com o mesmo desenho do item", () => {
    const { container } = render(<AssistantText text="Veja #ALFA-1 agora." byKey={byKey} onOpenTicket={() => {}} />);
    const mark = container.querySelector(".description-mention")!;
    expect(mark).toHaveAttribute("data-state", "in_progress");
    expect(container).not.toHaveTextContent("#ALFA-1");
  });
});

void ALFA1;
void ALFA2;

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { settle } from "../layout/layoutMeasure.js";
import { mountConversations, rowOf, seedDeep } from "../chat/conversationHarness.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "../ticket/TicketPage.js";

// ADR 0058 no navegador de verdade: o mesmo item de menção nos comentários e nas conversas, apagado de uma vez, com o teclado real.
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const poll = <T,>(read: () => T) => expect.poll(read, { timeout: 5000, interval: 100 });
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
const rgba = (css: string): number[] => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
};
const over = (top: number[], below: number[]) => { const a = top[3]! / 255; return [0, 1, 2].map((i) => top[i]! * a + below[i]! * (1 - a)).concat(255); };
const backdrop = (el: Element): number[] => {
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
  return chain.reduceRight<number[]>((below, node) => over(rgba(getComputedStyle(node).backgroundColor), below), [8, 9, 13, 255]);
};
const contrastOf = (el: Element) => { const bg = backdrop(el); return ratio(over(rgba(getComputedStyle(el).color), bg).slice(0, 3), bg.slice(0, 3)); };
/** O desenho do item: o que o olho vê (medidas e cores), igual onde quer que ele esteja. */
const look = (el: HTMLElement) => {
  const style = getComputedStyle(el);
  const before = getComputedStyle(el, "::before");
  const after = getComputedStyle(el, "::after");
  const box = el.getBoundingClientRect();
  return { height: Math.round(box.height), font: `${style.fontSize} ${style.fontWeight} ${style.fontFamily}`, padding: style.padding, radius: style.borderRadius, background: style.backgroundColor, color: style.color, markSize: before.width, markBorder: before.borderTopColor, titleColor: after.color, titleFont: after.fontSize };
};
const noSideScroll = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1440, 900);
});

async function openGeneral() {
  await mountConversations({ seed: (chat) => void chat.seedGeneral([{ person: "oi", assistant: "olá" }]) });
  await poll(() => document.querySelectorAll("button.conv-row").length).toBeGreaterThanOrEqual(1);
  rowOf(/Meu chat/).click();
  await poll(() => q(".chat-composer [role=combobox]")).not.toBeNull();
  await settle(500);
}
const composer = () => q<HTMLElement>(".chat-composer [role=combobox]")!;
const plain = (el: HTMLElement) => el.textContent ?? "";

describe("na conversa, com o teclado de verdade", () => {
  it("um Backspace apaga o item de pessoa inteiro e a pessoa sai da faixa; Delete pela frente também; as setas passam por ele", async () => {
    await openGeneral();
    await userEvent.click(composer());
    await userEvent.keyboard("oi @");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    await poll(() => q(".chat-composer .mention-person")).not.toBeNull();
    // A faixa de pastilhas saiu (ADR 0059): a pessoa de fora aparece no cabeçalho da thread que vai nascer.
    expect(all(".chat-newthread-head")).toHaveLength(1);
    // O cursor está depois do espaço que o seguiu: Backspace apaga o espaço, o seguinte, o item todo.
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(q(".chat-composer .mention-person")).toBeNull();
    expect(plain(composer())).toBe("oi ");
    expect(all(".chat-newthread-head")).toHaveLength(0);
    // Delete pela frente: de novo o item, e o cursor volta para antes dele.
    await userEvent.keyboard("@");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}x{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(q(".chat-composer .mention-person")).not.toBeNull();
    await userEvent.keyboard("{Delete}");
    expect(q(".chat-composer .mention-person")).toBeNull();
    expect(all(".chat-newthread-head")).toHaveLength(0);
    noSideScroll();
  });

  it("colar '@Bia' não cria pessoa; IME: o Enter da composição não envia", async () => {
    await openGeneral();
    await userEvent.click(composer());
    const data = new DataTransfer();
    data.setData("text/plain", "@Bia oi");
    composer().dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await poll(() => plain(composer())).toBe("@Bia oi");
    expect(q(".mention-list")).toBeNull();
    expect(q(".chat-composer .mention-person")).toBeNull();
    expect(all(".chat-newthread-head")).toHaveLength(0);
    const messages = all(".chat-message").length;
    composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    await settle(300);
    expect(plain(composer())).toBe("@Bia oi");
    expect(all(".chat-message")).toHaveLength(messages);
  });

  it("o destaque da pessoa tem contraste e o campo não rola para o lado, na tela larga e na estreita", async () => {
    for (const [width, height] of [[1440, 900], [390, 700]] as const) {
      await page.viewport(width, height);
      await openGeneral();
      await userEvent.click(composer());
      await userEvent.keyboard("@");
      await poll(() => q(".mention-list")).not.toBeNull();
      await userEvent.keyboard("{Enter}");
      await poll(() => q(".chat-composer .mention-person")).not.toBeNull();
      expect(contrastOf(q(".chat-composer .mention-person")!), `${width}px`).toBeGreaterThanOrEqual(4.5);
      noSideScroll();
      document.body.replaceChildren();
    }
  });
});

describe("o item de menção nunca quebra por dentro", () => {
  /** Uma linha só de altura e, no item de ticket, a chave inteira à vista (o título é que encolhe). */
  const oneLine = (el: HTMLElement, label: string) => {
    const box = el.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    expect(box.height, `${label}: altura`).toBeLessThan(line + 12);
    expect(el.getClientRects().length, label).toBe(1);
    const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (text && el.classList.contains("description-mention")) {
      const range = document.createRange();
      range.selectNodeContents(text);
      expect(Math.round(range.getBoundingClientRect().right), `${label}: chave inteira`).toBeLessThanOrEqual(Math.round(box.right));
    }
  };
  it.each([[1440], [390]])("no campo da conversa a %ipx de tela", async (width) => {
    await page.viewport(width, 900);
    await openGeneral();
    await userEvent.click(composer());
    await userEvent.keyboard("Vamos falar com @");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}sobre o #");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    await poll(() => composer().querySelector(".description-mention")).not.toBeNull();
    const items = [...composer().querySelectorAll<HTMLElement>(".description-mention, .mention-person")];
    expect(items.length).toBeGreaterThanOrEqual(2);
    items.forEach((el, i) => oneLine(el, `${width}px item ${i}`));
    const field = composer().getBoundingClientRect();
    items.forEach((el) => expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(field.right));
    if (width >= 1440) {
      // Tela larga: o mesmo tamanho e a mesma altura de linha das mensagens.
      expect(getComputedStyle(composer()).fontSize).toBe(getComputedStyle(q(".chat-text")!).fontSize);
      expect(getComputedStyle(composer()).lineHeight).toBe(getComputedStyle(q(".chat-text")!).lineHeight);
    } else {
      // Tela estreita: 16px ou mais (abaixo disso o iOS dá zoom ao focar).
      expect(parseFloat(getComputedStyle(composer()).fontSize)).toBeGreaterThanOrEqual(16);
    }
    // Os itens de menção acompanham o campo (nunca maiores que ele).
    items.forEach((el) => expect(parseFloat(getComputedStyle(el).fontSize)).toBeLessThanOrEqual(parseFloat(getComputedStyle(composer()).fontSize)));
  });
  it("no campo do comentário (painel normal)", async () => {
    await openComment();
    await userEvent.keyboard("Falar com @");
    await poll(() => q("[role=listbox]")).not.toBeNull();
    await userEvent.keyboard("{Enter}sobre #");
    await poll(() => q("[role=listbox]")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    const items = [...document.querySelectorAll<HTMLElement>(".ticket-comment-composer .description-mention, .ticket-comment-composer .mention-person")];
    expect(items.length).toBeGreaterThanOrEqual(2);
    items.forEach((el, i) => oneLine(el, `comentário item ${i}`));
  });
});

describe("revisão 2: o que se cola e o nome que se mostra", () => {
  const paste = (target: Element, data: Record<string, string>) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  };
  const html = `<span class="mention-person" data-person-id="person-2" data-person-name="Bia">@Bia</span>`;

  it("copiar @Bia de um comentário e colar na descrição dá o texto @Bia, sem nó e sem id", async () => {
    const screen = await openComment();
    void screen;
    await page.getByText("Texto").click();
    await poll(() => q("[aria-label='Descrição'].tiptap, .description .tiptap[contenteditable=true]")).not.toBeNull();
    const field = q(".description .tiptap[contenteditable=true]")!;
    paste(field, { "text/html": html, "text/plain": "@Bia" });
    paste(field, { "text/html": html });
    paste(field, { "text/plain": `[@Bia](person:person-2)` });
    await settle(200);
    expect(field.querySelector(".mention-person")).toBeNull();
    expect(field.querySelector("[data-person-id]")).toBeNull();
    expect(field.textContent).toContain("@Bia");
    expect(field.textContent).not.toContain("person:");
  });
});

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }), makeTicket("t2", "p1", 2, "Publicar a versão", { key: "ALFA-2" })];
const detail: TicketDetail = { ...summaries[0]!, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };

async function openComment() {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bia")], tickets: { p1: summaries } });
  Object.assign(client, { getTicket: vi.fn(async () => ok(detail)), ticketActivity: vi.fn(async () => ok({ entries: [], before: null, canComment: true })) });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />);
  await expect.element(screen.getByRole("textbox", { name: "Novo comentário" })).toBeVisible();
  await screen.getByRole("textbox", { name: "Novo comentário" }).click();
  return screen;
}

describe("no comentário, com o teclado de verdade", () => {
  it("# abre os tickets, @ abre as pessoas, e um Backspace apaga o item inteiro", async () => {
    await openComment();
    await userEvent.keyboard("veja #");
    await poll(() => all(".mention-list [role=option]").length).toBeGreaterThan(0);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await poll(() => q(".ticket-comment-composer .description-mention")).not.toBeNull();
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(q(".ticket-comment-composer .description-mention")).toBeNull();
    await userEvent.keyboard("@");
    await poll(() => q(".mention-list [aria-label], .mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    await poll(() => q(".ticket-comment-composer .mention-person")).not.toBeNull();
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(q(".ticket-comment-composer .mention-person")).toBeNull();
    noSideScroll();
  });
});

describe("o mesmo desenho no comentário e na conversa", () => {
  it("o item de ticket e o de pessoa têm as mesmas medidas e cores", async () => {
    await openComment();
    await userEvent.keyboard("#");
    await poll(() => all(".mention-list [role=option]").length).toBeGreaterThan(0);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await poll(() => q(".ticket-comment-composer .description-mention")).not.toBeNull();
    await userEvent.keyboard("@");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    await poll(() => q(".ticket-comment-composer .mention-person")).not.toBeNull();
    const inComment = { ticket: look(q(".ticket-comment-composer .description-mention")!), person: look(q(".ticket-comment-composer .mention-person")!) };
    document.body.replaceChildren();
    await openGeneral();
    await userEvent.click(composer());
    await userEvent.keyboard("#");
    await poll(() => all(".mention-list [role=option]").length).toBeGreaterThan(0);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await poll(() => q(".chat-composer .description-mention")).not.toBeNull();
    await userEvent.keyboard("@");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    await poll(() => q(".chat-composer .mention-person")).not.toBeNull();
    const inChat = { ticket: look(q(".chat-composer .description-mention")!), person: look(q(".chat-composer .mention-person")!) };
    // O tamanho da letra e da linha do campo pode ser outro; o que é do item (marca, cores, raio, fundo) não.
    for (const kind of ["ticket", "person"] as const) {
      // A pessoa de fora, no campo da conversa, leva a cor da thread que vai nascer (ADR 0059): só a cor muda; medidas e raio continuam os mesmos.
      if (kind === "ticket") {
        expect(inChat[kind].background, kind).toBe(inComment[kind].background);
        expect(inChat[kind].color, kind).toBe(inComment[kind].color);
      }
      expect(inChat[kind].radius, kind).toBe(inComment[kind].radius);
      expect(inChat[kind].padding, kind).toBe(inComment[kind].padding);
    }
    expect(q(".chat-composer .mention-person")!.classList.contains("is-outside")).toBe(true);
    expect(inChat.person.background).not.toBe(inComment.person.background);
    expect(inChat.ticket.markSize).toBe(inComment.ticket.markSize);
    expect(inChat.ticket.markBorder).toBe(inComment.ticket.markBorder);
    expect(inChat.ticket.titleColor).toBe(inComment.ticket.titleColor);
  });
  it("quem já participa da conversa tem o mesmo desenho (cor inclusive) da menção no comentário; só a de fora (is-outside) difere", async () => {
    await openComment();
    await userEvent.keyboard("@");
    await poll(() => q(".mention-list")).not.toBeNull();
    await userEvent.keyboard("{Enter}");
    await poll(() => q(".ticket-comment-composer .mention-person")).not.toBeNull();
    const inComment = look(q(".ticket-comment-composer .mention-person")!);
    const bia = q(".ticket-comment-composer .mention-person")!.textContent;
    document.body.replaceChildren();
    // Numa thread com a Bia, marcar a Bia (que já participa) é mensagem comum: o item é igual ao do comentário.
    await mountConversations({ seed: (chat) => seedDeep(chat, 1) });
    await poll(() => document.querySelectorAll("button.conv-row").length).toBeGreaterThanOrEqual(3);
    rowOf(/^Thread com Bia Nogueira(?! \+)/).click();
    await poll(() => q(".chat-composer [role=combobox]")).not.toBeNull();
    await settle(500);
    await userEvent.click(composer());
    await userEvent.keyboard("@");
    await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Bia Nogueira" }).click();
    await poll(() => q(".chat-composer .mention-person")).not.toBeNull();
    const inside = q(".chat-composer .mention-person")!;
    expect(inside.classList.contains("is-outside")).toBe(false);
    expect(q(".chat-newthread-head")).toBeNull();
    const seen = look(inside);
    for (const key of ["radius", "padding", "background", "color"] as const) expect(seen[key], key).toBe(inComment[key]);
    expect(bia).toContain("@");
    // Quem é de fora (Caio) leva a cor da thread: só ele difere.
    await userEvent.keyboard("@");
    await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Caio" }).click();
    await poll(() => q(".chat-composer .mention-person.is-outside")).not.toBeNull();
    expect(look(q(".chat-composer .mention-person.is-outside")!).background).not.toBe(inComment.background);
  });
});

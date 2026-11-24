import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { settle } from "../layout/layoutMeasure.js";
import { mountConversations, rowOf, rows, seedDeep } from "./conversationHarness.js";

// ADR 0055, fatia 2, no navegador real (Chromium do contêiner, TREEPM_PLAYWRIGHT_WS): a árvore da barra, a conversa, a thread e a trilha.
// As medidas esperam a tela assentar (`expect.poll`); o app só tem tema escuro, então o contraste é medido só nele.
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const panel = () => q(".chat-panel")!;
const poll = <T,>(read: () => T) => expect.poll(read, { timeout: 5000, interval: 100 });
const ratio = (a: number[], b: number[]) => {
  const lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** Qualquer sintaxe de cor do CSS vira RGBA pelo canvas (inclui `color-mix`). */
const rgba = (css: string): number[] => {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data];
};
const over = (top: number[], below: number[]) => {
  const a = top[3]! / 255;
  return [0, 1, 2].map((i) => top[i]! * a + below[i]! * (1 - a)).concat(255);
};
const backdrop = (el: Element): number[] => {
  const chain: Element[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
  return chain.reduceRight<number[]>((below, node) => over(rgba(getComputedStyle(node).backgroundColor), below), [8, 9, 13, 255]);
};
/** Contraste do texto do elemento sobre o fundo realmente pintado atrás dele. */
const contrastOf = (el: Element) => {
  const bg = backdrop(el);
  return ratio(over(rgba(getComputedStyle(el).color), bg).slice(0, 3), bg.slice(0, 3));
};
const expectContrast = (selector: string) => {
  const found = all(selector).filter((el) => (el.textContent ?? "").trim() !== "");
  expect(found.length, `${selector} não encontrado`).toBeGreaterThan(0);
  for (const el of found) expect(contrastOf(el), `${selector} "${el.textContent}"`).toBeGreaterThanOrEqual(4.5);
};

async function openRow(text: string | RegExp) {
  rowOf(text).click();
  await poll(() => panel() !== null && getComputedStyle(panel()).display !== "none").toBe(true);
  await settle(500);
}

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1440, 900);
});

describe("conversa pela barra, 1440×900", () => {
  it("abre a conversa do ticket pela linha, com a linha marcada e a coluna ao lado da barra", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá do assistente" }]) });
    await poll(() => rows().length).toBeGreaterThanOrEqual(2);
    expect(q(".chat-panel")).toBeNull();
    await openRow("ALFA-1");
    await poll(() => panel().textContent).toContain("olá do assistente");
    expect(rowOf("ALFA-1").getAttribute("aria-current")).toBe("true");
    expect(panel().getBoundingClientRect().left).toBe(296);
    expect(panel().querySelector(".chat-tabs")).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("abre a thread pelo cartão da mensagem e volta pela trilha", async () => {
    await page.viewport(1440, 900);
    await mountConversations({
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        chat.openThreadIn(main, { from: "person-1", body: "Bia, olha isto", to: ["person-2"], replies: [{ from: "person-2", body: "Já vi" }] });
      },
    });
    await openRow("ALFA-1");
    await poll(() => q(".chat-panel .chat-thread-footer")).not.toBeNull();
    const card = q<HTMLButtonElement>(".chat-panel .chat-thread-footer")!;
    expect(card.closest(".chat-message")!.classList.contains("has-thread")).toBe(true);
    card.click();
    await poll(() => panel().textContent).toContain("Já vi");
    const trail = panel().querySelector("nav[aria-label='Onde você está']")!;
    expect(trail.querySelector("[aria-current='page']")!.textContent).toContain("Thread com Bia");
    // A linha da thread na barra passa a ser a atual; a do ticket deixa de ser.
    await poll(() => rowOf(/Thread com Bia/).getAttribute("aria-current")).toBe("true");
    expect(rowOf("ALFA-1").getAttribute("aria-current")).toBeNull();
    [...trail.querySelectorAll("button")].find((button) => button.textContent === "ALFA-1")!.click();
    await poll(() => panel().textContent).toContain("olá");
    await poll(() => panel().textContent).not.toContain("Já vi");
    expect(rowOf("ALFA-1").getAttribute("aria-current")).toBe("true");
  });

  it("mostra o aviso 'Esta mensagem abre uma thread com…' só quando alguém é marcado", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    await openRow("ALFA-1");
    await userEvent.fill(page.getByRole("combobox", { name: "Mensagem" }), "Bia, olha");
    expect(q(".chat-thread-notice")?.textContent).toBe("");
    await userEvent.keyboard("{Home}@");
    await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Bia Nogueira" }).click();
    await poll(() => q(".chat-thread-notice")?.textContent ?? "").toContain("abre uma thread com Bia Nogueira");
  });
});

describe("árvore na barra de 296 px", () => {
  it("com 6 níveis de thread não rola para o lado e nenhuma linha passa da largura", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => seedDeep(chat, 6) });
    await poll(() => rows().length).toBeGreaterThanOrEqual(8);
    const levels = rows().map((row) => Number(row.style.getPropertyValue("--conv-level")));
    expect(Math.max(...levels)).toBe(5); // a indentação para no quinto nível
    await poll(() => {
      const bar = q(".sidebar")!;
      const list = q(".sidebar-conversations")!;
      const tree = q(".conv-list")!;
      const edge = bar.getBoundingClientRect().right;
      return {
        bar: bar.scrollWidth <= bar.clientWidth,
        list: list.scrollWidth <= list.clientWidth,
        tree: tree.scrollWidth <= tree.clientWidth,
        rows: rows().every((row) => row.getBoundingClientRect().right <= edge + 0.5 && row.scrollWidth <= row.clientWidth),
        width: bar.getBoundingClientRect().width,
      };
    }).toEqual({ bar: true, list: true, tree: true, rows: true, width: 296 });
    // A indentação cresce 12 px por nível: o texto do nível 3 começa 12 px depois do nível 2.
    const left = (level: number) => rows().find((row) => row.style.getPropertyValue("--conv-level") === String(level))!.querySelector(".conv-text")!.getBoundingClientRect().left;
    expect(left(3) - left(2)).toBeCloseTo(12, 0);
    expect(left(5) - left(4)).toBeCloseTo(12, 0);
  });

  it("as setas movem o foco entre as linhas e Enter abre a conversa da linha focada", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => seedDeep(chat, 2) });
    await poll(() => rows().length).toBeGreaterThanOrEqual(4);
    rows()[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(rows()[3]);
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows()[2]);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(rows()[0]); // não passa do começo
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows()[1]);
    await userEvent.keyboard("{Enter}");
    await poll(() => rows()[1]!.getAttribute("aria-current")).toBe("true");
    await poll(() => getComputedStyle(panel()).display).not.toBe("none");
    // O anel de foco é visível (2 px) na linha focada.
    rows()[2]!.focus();
    expect(getComputedStyle(rows()[2]!).outlineStyle).not.toBe("none");
    expect(parseFloat(getComputedStyle(rows()[2]!).outlineWidth)).toBeGreaterThanOrEqual(2);
  });
});

describe("contraste dos textos novos (tema escuro, o único do app), mínimo 4.5:1", () => {
  it("barra, cartão, trilha e aviso da conversa", async () => {
    await page.viewport(1440, 900);
    await mountConversations({
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        chat.openThreadIn(main, { from: "person-1", body: "Bia, olha isto", to: ["person-2"], replies: [{ from: "person-2", body: "Já vi" }] });
      },
    });
    await poll(() => rows().length).toBeGreaterThanOrEqual(3);
    for (const selector of [".conv-preview", ".conv-title", ".conv-time", ".conv-row.is-thread .conv-title"]) expectContrast(selector);
    await openRow("ALFA-1");
    await poll(() => q(".chat-panel .chat-thread-footer")).not.toBeNull();
    // A linha atual (fundo selecionado) também.
    for (const selector of [".conv-row[aria-current] .conv-title", ".conv-row[aria-current] .conv-preview", ".conv-row[aria-current] .conv-time"]) expectContrast(selector);
    expectContrast(".chat-thread-footer");
    expectContrast(".chat-thread-footer .chat-thread-name");
    q<HTMLButtonElement>(".chat-thread-footer")!.click();
    await poll(() => q(".chat-trail")).not.toBeNull();
    await settle(400);
    for (const selector of [".chat-trail li", ".chat-trail li[aria-current]", ".chat-trail button"]) expectContrast(selector);
    await userEvent.type(page.getByRole("combobox", { name: "Responder na thread" }), "@");
    await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Caio" }).click();
    await userEvent.fill(page.getByRole("combobox", { name: "Responder na thread" }), "Caio, e você?");
    await poll(() => q(".chat-thread-notice")).not.toBeNull();
    expectContrast(".chat-thread-notice");
  });

  it("o aviso do último nível ('levels note') tem contraste", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => seedDeep(chat, 9) });
    await poll(() => rows().length).toBeGreaterThanOrEqual(11);
    rows().at(-1)!.click();
    await poll(() => panel().textContent).toContain("Resposta no nível 9");
    await poll(() => q(".chat-levels-note")).not.toBeNull();
    expectContrast(".chat-levels-note");
  });
});

describe("detalhes da barra e dos avatares, 1440×900", () => {
  it("o ícone de responsável não rouba a largura do título do ticket", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]) });
    await poll(() => rows().length).toBeGreaterThanOrEqual(2);
    const row = rowOf("ALFA-1");
    const icon = row.querySelector<HTMLElement>(".conv-assigned")!;
    expect(icon.getAttribute("aria-label")).toBe("Você é responsável");
    expect(row.textContent).not.toContain("Responsável");
    await poll(() => icon.getBoundingClientRect().width).toBeLessThanOrEqual(20);
    const title = row.querySelector<HTMLElement>(".conv-title")!;
    await poll(() => title.getBoundingClientRect().width / row.getBoundingClientRect().width).toBeGreaterThanOrEqual(0.6);
  });

  it("as iniciais dos avatares sobrepostos se leem inteiras (pouca sobreposição, letras dentro do círculo)", async () => {
    await page.viewport(1440, 900);
    await mountConversations({
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        chat.openThreadIn(main, { from: "person-1", body: "Bia e Caio, olhem", to: ["person-2", "person-3"] });
      },
    });
    await openRow("ALFA-1");
    await poll(() => all(".chat-panel .chat-thread-footer .chat-initials").length).toBeGreaterThanOrEqual(3);
    const initials = all(".chat-panel .chat-thread-footer .chat-initials");
    for (const [index, el] of initials.entries()) {
      const box = el.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
      const next = initials[index + 1];
      // A parte que o vizinho cobre (sobreposição mais o anel de 2 px) deixa de fora menos que a margem entre a letra e a borda.
      if (next) expect(box.right - next.getBoundingClientRect().left + 2).toBeLessThanOrEqual(5);
    }
  });
});

describe("convidado", () => {
  it("vê só a thread dele sob o ticket, e a coluna não mostra o que está acima", async () => {
    await page.viewport(1440, 900);
    await mountConversations({
      as: "person-3",
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "segredo do dono", assistant: "resposta secreta" }]);
        const first = chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        chat.openThreadIn(first, { from: "person-2", body: "Caio, e você?", to: ["person-3"], replies: [{ from: "person-2", body: "resposta do Bia" }] });
      },
    });
    await poll(() => rows().length).toBe(3); // chat geral, o ticket e a thread dele
    const thread = rows()[2]!;
    expect(thread.style.getPropertyValue("--conv-level")).toBe("1");
    expect(document.body.textContent).not.toMatch(/segredo|secreta|Bia, olha/);
    thread.click();
    await poll(() => panel().textContent).toContain("resposta do Bia");
    expect(document.body.textContent).not.toMatch(/segredo|secreta|Bia, olha/);
    expect(panel().querySelector(".chat-trail")).not.toBeNull();
  });
});

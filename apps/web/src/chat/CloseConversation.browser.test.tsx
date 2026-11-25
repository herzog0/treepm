import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { settle } from "../layout/layoutMeasure.js";
import { mountConversations, rowOf, rows, seedDeep } from "./conversationHarness.js";

// ADR 0059 no navegador de verdade: o × da lista, o aviso com "Desfazer", "Fechadas (N)" e o campo da thread que nasce.
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
/** A diferença entre o centro do conteúdo (texto, ícone) do botão e o centro da caixa do botão. */
const centerGap = (el: Element) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  const content = range.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return { x: Math.abs(content.left + content.width / 2 - (box.left + box.width / 2)), y: Math.abs(content.top + content.height / 2 - (box.top + box.height / 2)) };
};
const expectCentered = (el: Element, label: string) => {
  const gap = centerGap(el);
  expect(gap.y, `${label}: vertical`).toBeLessThan(1);
  expect(gap.x, `${label}: horizontal`).toBeLessThan(1);
};
const noSideScroll = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
const panel = () => q<HTMLElement>(".chat-panel")!;
const closeButton = (row: HTMLElement) => row.closest(".conv-line")!.querySelector<HTMLButtonElement>(".conv-close")!;

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(1440, 900);
});

const seed = (chat: Parameters<NonNullable<Parameters<typeof mountConversations>[0]>["seed"] & {}>[0]) => {
  chat.seedGeneral([{ person: "oi", assistant: "olá" }]);
  seedDeep(chat, 2);
};

async function mount(width = 1440, height = 900) {
  await page.viewport(width, height);
  await mountConversations({ seed });
  await poll(() => rows().length).toBeGreaterThanOrEqual(4);
  await settle(500);
}
async function openMenuIfNarrow() {
  if (window.innerWidth <= 720) await page.getByRole("button", { name: /^Abrir o menu/ }).click();
}
/** Abre o ALFA-1 e marca a Bia (de fora): o campo mostra a thread que vai nascer. */
async function markOutsider() {
  await openMenuIfNarrow();
  rowOf("ALFA-1").click();
  await poll(() => panel() !== null && getComputedStyle(panel()).display !== "none").toBe(true);
  await settle(500);
  await userEvent.click(page.getByRole("combobox", { name: "Mensagem" }));
  await userEvent.keyboard("@");
  await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Bia Nogueira" }).click();
  await userEvent.keyboard("oi");
  await poll(() => q(".chat-newthread-head")).not.toBeNull();
}

describe("a lista de conversas", () => {
  it("o × aparece no hover e no foco da linha e não desloca o título", async () => {
    await mount();
    const row = rowOf(/Nível 1/);
    const title = row.querySelector<HTMLElement>(".conv-title")!;
    const before = title.getBoundingClientRect();
    const button = closeButton(row);
    expect(getComputedStyle(button).opacity).toBe("0");
    await userEvent.hover(row);
    await poll(() => getComputedStyle(button).opacity).toBe("1");
    const hovered = title.getBoundingClientRect();
    expect([hovered.left, hovered.top, hovered.width, hovered.height]).toEqual([before.left, before.top, before.width, before.height]);
    await userEvent.unhover(row);
    await poll(() => getComputedStyle(button).opacity).toBe("0");
    row.focus();
    await poll(() => getComputedStyle(button).opacity).toBe("1");
    const focused = title.getBoundingClientRect();
    expect([focused.left, focused.width]).toEqual([before.left, before.width]);
    expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(row.closest(".conv-line")!.getBoundingClientRect().right);
  });

  it("fechar mostra 'Conversa fechada.' com 'Desfazer'; 'Fechadas (N)' abre e reabre", async () => {
    await mount();
    const total = rows().length;
    const row = rows().at(-1)!;
    await userEvent.hover(row);
    closeButton(row).click();
    await poll(() => q(".conv-toast")?.textContent ?? "").toContain("Conversa fechada.");
    await poll(() => rows().length).toBeLessThan(total);
    await page.getByRole("button", { name: "Desfazer" }).click();
    await poll(() => rows().length).toBe(total);
    expect(q(".conv-toast")).toBeNull();
    // De novo, e agora pela seção "Fechadas".
    const again = rows().at(-1)!;
    await userEvent.hover(again);
    closeButton(again).click();
    await poll(() => q(".conv-closed-toggle")?.textContent ?? "").toBe("Fechadas (1)");
    const toggle = q<HTMLButtonElement>(".conv-closed-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await poll(() => all(".conv-closed-row").length).toBe(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    await poll(() => all(".conv-closed-row").length).toBe(0);
    toggle.click();
    await poll(() => all(".conv-closed-row").length).toBe(1);
    await page.getByRole("button", { name: /^Reabrir/ }).click();
    await poll(() => rows().length).toBe(total);
    expect(q(".conv-closed-toggle")).toBeNull();
  });
});

describe("a lista no celular (sem hover)", () => {
  it("o × fica sempre à vista, com alvo de 44 px, e não cobre a hora nem o contador", async () => {
    await mount(390, 844);
    await openMenuIfNarrow();
    const row = rows().at(-1)!;
    const button = closeButton(row);
    expect(getComputedStyle(button).opacity).toBe("1");
    const box = button.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([44, 44]);
    for (const el of all(".conv-line .conv-time, .conv-line .conv-badge")) {
      const other = el.getBoundingClientRect();
      if (other.width > 0) expect(other.right, el.className).toBeLessThanOrEqual(box.left + 0.5);
    }
    expectCentered(button, "×");
  });
});

describe("o campo da thread que nasce", () => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    it(`contorno, cabeçalho e botão no painel (${width}px): sem rolagem para o lado, com contraste`, async () => {
      await mount(width, height);
      await markOutsider();
      const form = q<HTMLElement>(".chat-composer")!;
      expect(form.classList.contains("is-new-thread")).toBe(true);
      expect(getComputedStyle(form).borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
      const head = q<HTMLElement>(".chat-newthread-head")!;
      expect(head.scrollWidth, "cabeçalho").toBeLessThanOrEqual(head.clientWidth);
      expect(form.scrollWidth, "campo").toBeLessThanOrEqual(form.clientWidth);
      expect(panel().scrollWidth, "painel").toBeLessThanOrEqual(panel().clientWidth);
      if (width === 1440) expect(panel().getBoundingClientRect().width).toBeLessThanOrEqual(440);
      noSideScroll();
      for (const el of [head, ...all(".chat-newthread-head span"), ...all(".chat-newthread-head small"), ...all(".chat-composer .mention-person.is-outside"), q(".chat-send.is-thread")!]) {
        if ((el.textContent ?? "").trim() === "") continue;
        expect(contrastOf(el), `${el.className || el.tagName} "${el.textContent}"`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("o texto de cada botão está no centro dele", () => {
  it("campo do chat (Abrir thread, + Novo ticket, enviar) e barra lateral, na tela larga", async () => {
    await mount();
    await markOutsider();
    expectCentered(page.getByRole("button", { name: "Abrir thread" }).element(), "Abrir thread");
    const novo = q(".chat-new-ticket");
    if (novo) expectCentered(novo, "novo ticket do campo");
    for (const el of all(".chat-text-button")) expectCentered(el, `chat-text-button "${el.textContent}"`);
    expectCentered(q(".sidebar-new")!, "+ Novo ticket (barra)");
    const row = rows().at(-1)!;
    closeButton(row).click();
    await poll(() => q(".conv-toast button")).not.toBeNull();
    expectCentered(q(".conv-toast button")!, "Desfazer");
    await page.getByRole("button", { name: "Desfazer" }).click();
    const again = rows().at(-1)!;
    closeButton(again).click();
    await poll(() => q(".conv-closed-toggle")).not.toBeNull();
    expectCentered(q(".conv-closed-toggle")!, "Fechadas");
    q<HTMLButtonElement>(".conv-closed-toggle")!.click();
    await poll(() => all(".conv-closed-row .chat-text-button").length).toBe(1);
    expectCentered(q(".conv-closed-row .chat-text-button")!, "Reabrir");
    expectCentered(q(".conv-close")!, "×");
  });

  it("o campo sem thread: botão de enviar do chat comum", async () => {
    await mount();
    await openMenuIfNarrow();
    rowOf("ALFA-1").click();
    await poll(() => q(".chat-send")).not.toBeNull();
    expectCentered(q(".chat-send")!, "enviar");
  });
});

describe("o campo na thread com gente: 'entra junto' e a menção de fora têm contraste", () => {
  it("small 'entra junto', menção .is-outside e Abrir thread passam de 4,5:1", async () => {
    await mount();
    await openMenuIfNarrow();
    rowOf(/^Thread com Bia Nogueira(?! \+)/).click();
    await poll(() => q(".chat-composer [role=combobox]")).not.toBeNull();
    await settle(500);
    await userEvent.click(page.getByRole("combobox", { name: /Responder|Mensagem/ }));
    await userEvent.keyboard("@");
    await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Caio" }).click();
    await poll(() => q(".chat-newthread-head small")).not.toBeNull();
    for (const el of [q(".chat-newthread-head small")!, q(".chat-composer .mention-person.is-outside")!, page.getByRole("button", { name: "Abrir thread" }).element()]) {
      expect(contrastOf(el), `${el.className || el.tagName} "${el.textContent}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("hora e contador no hover (defeito da captura 01)", () => {
  it("somem por inteiro e o × ocupa o lugar: nenhuma caixa do contador fica meio coberta", async () => {
    await mount();
    const row = rows().find((candidate) => candidate.querySelector(".conv-badge") && candidate.closest(".conv-line")?.querySelector(".conv-close"))!;
    expect(row, "uma linha com contador").toBeDefined();
    const line = row.closest(".conv-line")!;
    const aside = line.querySelector<HTMLElement>(".conv-aside")!;
    const time = line.querySelector<HTMLElement>(".conv-time");
    expect(getComputedStyle(aside).visibility).toBe("visible");
    await userEvent.hover(row);
    await poll(() => getComputedStyle(aside).visibility).toBe("hidden");
    if (time) expect(getComputedStyle(time).visibility).toBe("hidden");
    const x = closeButton(row).getBoundingClientRect();
    const b = line.querySelector<HTMLElement>(".conv-badge")!.getBoundingClientRect();
    const overlaps = x.left < b.right && x.right > b.left && x.top < b.bottom && x.bottom > b.top;
    // Ou o contador não está debaixo do ×, ou está escondido por inteiro (visibility), nunca pela metade.
    expect(!overlaps || getComputedStyle(aside).visibility === "hidden").toBe(true);
  });
});

describe("o aviso fica sempre à vista", () => {
  it("com 40 conversas, depois de fechar a última o aviso está dentro da área que rola, no pé", async () => {
    await page.viewport(1440, 700);
    await mountConversations({
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        for (let n = 1; n <= 40; n += 1) chat.openThreadIn(main, { from: "person-1", body: `Conversa ${n}`, to: [n % 2 ? "person-2" : "person-3"] });
        chat.readAll();
      },
    });
    await poll(() => rows().length).toBeGreaterThanOrEqual(40);
    await settle(500);
    const last = rows().at(-1)!;
    last.scrollIntoView();
    await userEvent.hover(last);
    closeButton(last).click();
    await poll(() => q(".conv-toast")).not.toBeNull();
    const toast = q<HTMLElement>(".conv-toast")!;
    let box: HTMLElement | null = toast.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    expect(box, "área que rola").not.toBeNull();
    expect(box!.scrollHeight).toBeGreaterThan(box!.clientHeight);
    box!.scrollTop = 0;
    await settle(200);
    const t = toast.getBoundingClientRect();
    const area = box!.getBoundingClientRect();
    expect(t.top).toBeGreaterThanOrEqual(area.top);
    expect(t.bottom).toBeLessThanOrEqual(area.bottom + 1);
  });
});

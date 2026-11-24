import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { settle } from "../layout/layoutMeasure.js";
import { TestSidebar } from "../layout/testSidebar.js";
import { failed, makeClient, makeConversation, makeMe, makePerson, makePlacement, makeProject, makeTicket, createFakeChat, ok } from "../test/fakes.js";
import { ChatShell } from "./ChatShell.js";
import { useEffect } from "react";
import { ChatsProvider, useChats } from "./ChatsContext.js";

// A thread de criação de ticket (ADR 0056, fatia 3) no navegador real: a linha "+" da barra de 296 px, a thread sem rolagem horizontal,
// o contraste do selo e do contorno tracejado e o teclado. Roda no Chromium do contêiner (TREEPM_PLAYWRIGHT_WS).
const WIDE = [1440, 900] as const;
const draft = { title: "Corrigir o login quando a sessão expira no meio do formulário de cadastro", description: "O login falha no Safari depois de o token expirar.", children: [], idea: false };
const which = makePlacement({
  question: { level: 1, kind: "which", at: { id: null, title: "Projeto Alfa", path: [] }, options: [{ id: "t1", title: "Corrigir o login", path: [{ id: "t1", title: "Corrigir o login" }] }, { id: "t2", title: "Publicar a versão", path: [{ id: "t2", title: "Publicar a versão" }] }] },
  destinationConfirmed: false,
  uncertain: true,
  destination: { parentId: "t1", path: [{ id: "t1", title: "Corrigir o login" }] },
});

/** O mapa montado ao lado (só o que a thread usa dele): sem ele não há "escolher no mapa". */
function MapStub() {
  const { setMapHost } = useChats()!;
  useEffect(() => {
    setMapHost({ projectId: () => "p1", creatable: [makeProject("p1", "ALFA", "Projeto Alfa")], scopeTicketId: () => null, registerPicker: () => {}, onDraftChange: () => {}, onChanged: () => {}, onManualCreate: () => {} });
    return () => setMapHost(null);
  }, [setMapHost]);
  return null;
}

async function mount(options: { question?: boolean; failProvider?: boolean } = {}) {
  const people = [makePerson("person-1", "Ana")];
  const chat = createFakeChat({ tickets: [{ id: "t1", key: "ALFA-1", title: "Corrigir o login", projectId: "p1", assignedToMe: true }], people });
  chat.seedGeneral([]);
  const client = makeClient({ me: makeMe({ assistant: true }), people, projects: [makeProject("p1", "ALFA", "Projeto Alfa")], tickets: { p1: [makeTicket("t1", "p1", 1, "Corrigir o login", { status: "in_progress" }), makeTicket("t2", "p1", 2, "Publicar a versão")] }, chat });
  const created = vi.fn(async () => failed("unavailable"));
  let threadOf = "";
  Object.assign(client, {
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1", { draft }))),
    // Como o servidor: com a pergunta aberta, a thread passa a "sua vez" na próxima leitura da árvore.
    findPlacement: vi.fn(async () => {
      if (options.question) chat.setCreation(threadOf, { state: "waiting" });
      return ok(options.question ? which : makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Corrigir o login" }] } }));
    }),
    createTicketFromConversation: created,
    ...(options.failProvider ? { sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")) } : {}),
  });
  const generalId = chat.generalOf()!;
  const sent = await client.sendChatMessage(generalId, { body: draft.title, creation: true });
  const threadId = sent.ok && sent.data.kind === "creation" ? sent.data.thread.id : "";
  threadOf = threadId;
  await render(
    <div id="root" style={{ height: "100dvh" }}>
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <ChatShell sidebar={<TestSidebar />}>
          <main className="tenant-map" style={{ minWidth: 0 }}>mapa</main>
        </ChatShell>
        <MapStub />
      </ChatsProvider>
    </div>,
  );
  await settle();
  return { client, chat, created, threadId };
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const creationRow = () => q<HTMLButtonElement>("button.conv-row.is-creation")!;
async function openThread() {
  creationRow().click();
  await settle(600);
}

/** Cor CSS qualquer (rgb, oklch, color-mix…) em canais sRGB 0–255 e alfa, pelo canvas. */
function channels(color: string): [number, number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, a!];
}
/** O fundo de verdade de um elemento: as camadas translúcidas somadas até a primeira opaca. */
function backgroundOf(element: Element): [number, number, number] {
  const layers: [number, number, number, number][] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const value = channels(getComputedStyle(node).backgroundColor);
    if (value[3] > 0) layers.push(value);
    if (value[3] === 255) break;
  }
  let base: [number, number, number] = [255, 255, 255];
  for (const [r, g, b, a] of layers.reverse()) base = [0, 1, 2].map((i) => Math.round(([r, g, b][i]! * a + base[i]! * (255 - a)) / 255)) as [number, number, number];
  return base;
}
const luminance = ([r, g, b]: [number, number, number]) => {
  const lin = (value: number) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const rgb = (color: string): [number, number, number] => channels(color).slice(0, 3) as [number, number, number];

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(...WIDE);
});

describe("a linha da thread de criação na barra de 296 px", () => {
  it("tem o '+' tracejado, o título legível e o selo à vista, sem estourar a barra", async () => {
    await page.viewport(...WIDE);
    await mount();
    const row = creationRow();
    const bar = q(".sidebar")!.getBoundingClientRect();
    expect(bar.width).toBe(296);
    const box = row.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(bar.left);
    expect(box.right).toBeLessThanOrEqual(bar.right);
    const title = row.querySelector<HTMLElement>(".conv-title, .conv-name, strong, span:not(.conv-creation-mark)")!;
    expect(title.getBoundingClientRect().width).toBeGreaterThan(100);
    expect(row.textContent).toContain("Corrigir o login");
    const badge = row.querySelector<HTMLElement>(".creation-badge")!;
    expect(badge.textContent).toBe("rascunho");
    const badgeBox = badge.getBoundingClientRect();
    expect(badgeBox.width).toBeGreaterThan(30);
    expect(badgeBox.left).toBeGreaterThanOrEqual(box.left);
    expect(badgeBox.right).toBeLessThanOrEqual(box.right);
    expect(getComputedStyle(row.querySelector(".conv-creation-mark")!).borderTopStyle).toBe("dashed");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("o selo e o contorno tracejado têm contraste suficiente (texto 4,5:1, contorno 3:1)", async () => {
    await mount();
    const row = creationRow();
    const badge = row.querySelector<HTMLElement>(".creation-badge")!;
    const style = getComputedStyle(badge);
    const background = backgroundOf(badge);
    expect(contrast(rgb(style.color), background)).toBeGreaterThanOrEqual(4.5);
    const mark = row.querySelector<HTMLElement>(".conv-creation-mark")!;
    expect(contrast(rgb(getComputedStyle(mark).borderTopColor), backgroundOf(mark))).toBeGreaterThanOrEqual(3);
    expect(contrast(rgb(style.borderTopColor), backgroundOf(badge.parentElement!))).toBeGreaterThanOrEqual(3);
  });
});

describe("a thread aberta na coluna da conversa", () => {
  it("com o rascunho: sem rolagem horizontal, o selo e a nota 'Só você vê' à vista", async () => {
    await mount();
    await openThread();
    const panel = q(".chat-panel")!;
    expect(panel.getBoundingClientRect().width).toBe(440);
    expect(q(".creation-head .creation-badge")?.textContent).toBe("rascunho");
    expect(panel.textContent).toContain("Só você vê");
    for (const element of [panel, q(".creation-thread")!, q(".creation-body")!, q(".creation-body .assistant-scroll")!]) {
      expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const create = [...document.querySelectorAll("button")].filter((button) => button.textContent === "Procurar o lugar");
    expect(create).toHaveLength(1);
  });

  it("com a pergunta do lugar: sem rolagem horizontal e a linha da barra diz 'sua vez'", async () => {
    const { chat, threadId } = await mount({ question: true });
    chat.setCreation(threadId, { state: "waiting" });
    await openThread();
    await page.getByRole("button", { name: "Procurar o lugar" }).click();
    await settle(600);
    const panel = q(".chat-panel")!;
    expect(q(".assistant-cards")?.textContent).toContain("Onde isto entra?");
    for (const element of [panel, q(".creation-thread")!, q(".creation-body .assistant-scroll")!]) {
      expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth);
    }
    const choice = q(".assistant-choice")!.getBoundingClientRect();
    expect(choice.right).toBeLessThanOrEqual(panel.getBoundingClientRect().right);
  });
});

describe("teclado", () => {
  it("Tab chega até 'Procurar o lugar' e, depois da procura, até 'Criar aqui'", async () => {
    await mount();
    await openThread();
    const reach = async (name: string) => {
      for (let step = 0; step < 60; step += 1) {
        await userEvent.tab();
        if ((document.activeElement as HTMLElement | null)?.textContent === name) return true;
      }
      return false;
    };
    (document.activeElement as HTMLElement).blur();
    expect(await reach("Procurar o lugar")).toBe(true);
    await userEvent.keyboard("{Enter}");
    await settle(600);
    (document.activeElement as HTMLElement).blur();
    expect(await reach("Criar aqui")).toBe(true);
  });

  it("com a pergunta aberta, Enter no campo não cria ticket", async () => {
    const { created } = await mount({ question: true });
    await openThread();
    await page.getByRole("button", { name: "Procurar o lugar" }).click();
    await settle(600);
    expect(document.body.textContent).toContain("Onde isto entra?");
    const field = q<HTMLTextAreaElement>("#assistant-message")!;
    field.focus();
    await userEvent.keyboard("{Enter}");
    await settle(300);
    expect(created).not.toHaveBeenCalled();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Criar aqui")).toBe(false);
  });
});

// Acabamento visual (ADR 0056, fatia 3): o miolo hospedado na thread tem o desenho da aplicação, não o do navegador.
const token = (name: string) => rgb(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
const sameColor = (a: string, b: [number, number, number]) => expect(rgb(a)).toEqual(b);
const byText = (selector: string, text: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((element) => (element.textContent ?? "").trim() === text)!;
async function openWithQuestion() {
  const mounted = await mount({ question: true });
  await openThread();
  await page.getByRole("button", { name: "Procurar o lugar" }).click();
  await settle(700);
  return mounted;
}

describe("acabamento visual da thread de criação", () => {
  it("nenhum controle usa a aparência padrão do navegador: fundo, borda e raio vêm dos tokens", async () => {
    await openWithQuestion();
    const radius = (element: Element) => getComputedStyle(element).borderTopLeftRadius;
    // As opções da pergunta: linhas com o fundo e a borda do campo das conversas.
    // O ponteiro ficou onde o botão de procurar estava: a opção sob ele mostra o fundo de "hover", que é outro teste.
    const choices = [...document.querySelectorAll<HTMLElement>(".assistant-choice")].filter((choice) => !choice.matches(":hover"));
    expect(choices.length).toBeGreaterThanOrEqual(3);
    for (const choice of choices) {
      const style = getComputedStyle(choice);
      sameColor(style.backgroundColor, token("--tp-conv-field"));
      sameColor(style.borderTopColor, token("--tp-conv-field-border"));
      expect(style.borderTopStyle).toMatch(/solid|dashed/);
      expect(radius(choice)).toBe("9px");
    }
    expect(getComputedStyle(byText(".assistant-choice", "Nenhum destes: escolher no mapa")).borderTopStyle).toBe("dashed");
    // "Procurar de novo": o botão comum da aplicação.
    const again = byText("button", "Procurar de novo");
    sameColor(getComputedStyle(again).backgroundColor, token("--tp-raised"));
    sameColor(getComputedStyle(again).borderTopColor, token("--tp-border"));
    expect(radius(again)).toBe("6px");
    // "Descartar rascunho": ação discreta de perigo, sem caixa.
    const discard = byText("button", "Descartar rascunho");
    expect(getComputedStyle(discard).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    sameColor(getComputedStyle(discard).color, token("--tp-danger-text"));
    expect(getComputedStyle(discard).fontSize).toBe("12px");
    // O campo de escrever: o das conversas, com o botão de enviar delas.
    const field = q<HTMLTextAreaElement>("#assistant-message")!;
    await userEvent.type(field, "oi");
    sameColor(getComputedStyle(field).backgroundColor, token("--tp-conv-bg"));
    sameColor(getComputedStyle(field).borderTopColor, token("--tp-conv-field-border"));
    expect(radius(field)).toBe("8px");
    const box = field.closest<HTMLElement>(".assistant-form")!;
    sameColor(getComputedStyle(box).backgroundColor, token("--tp-conv-field"));
    expect(radius(box)).toBe("12px");
    sameColor(getComputedStyle(q(".assistant-send")!).backgroundColor, token("--tp-side-selected"));
    // O título do rascunho: campo da aplicação, não a caixa do navegador.
    const title = q<HTMLInputElement>(".assistant-card.is-draft input")!;
    sameColor(getComputedStyle(title).backgroundColor, token("--tp-conv-bg"));
    expect(radius(title)).toBe("6px");
  });

  it("o rascunho é um cartão de contorno tracejado e as opções trazem bolinha, chave, título e caminho", async () => {
    await openWithQuestion();
    expect(getComputedStyle(q(".assistant-card.is-draft")!).borderTopStyle).toBe("dashed");
    const first = q<HTMLElement>(".assistant-choice")!;
    expect(first.querySelector(".choice-dot")).not.toBeNull();
    expect(getComputedStyle(first.querySelector(".choice-title")!, "::before").content).toBe('"P1-1" / ""');
    expect(first.querySelector(".choice-title")?.textContent).toContain("Corrigir o login");
    expect(getComputedStyle(first.querySelector(".choice-dot")!).borderTopLeftRadius).not.toBe("0px");
  });

  it("o título da thread cabe numa linha com reticências e o rótulo 'Título' fica inteiro à vista depois de rolar ao topo", async () => {
    await openWithQuestion();
    const title = q<HTMLElement>(".chat-trail .creation-title-text")!;
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    expect(title.getBoundingClientRect().height).toBeLessThan(24);
    const li = title.parentElement!;
    // A caixa do título cabe na coluna (se o texto for maior, as reticências o cortam dentro dela, não a tela).
    expect(title.getBoundingClientRect().right, "o título cabe na coluna").toBeLessThanOrEqual(q(".chat-context")!.getBoundingClientRect().right);
    expect(li.getBoundingClientRect().right, "a linha do título cabe na coluna").toBeLessThanOrEqual(q(".chat-context")!.getBoundingClientRect().right);
    const scroller = q<HTMLElement>(".creation-body .assistant-scroll")!;
    scroller.scrollTop = 0;
    await settle(200);
    const label = [...document.querySelectorAll<HTMLElement>(".assistant-card label")].find((element) => (element.firstChild?.textContent ?? "").trim() === "Título")!;
    const range = document.createRange();
    range.selectNodeContents(label.firstChild!);
    const text = range.getBoundingClientRect();
    const head = q(".creation-head")!.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    expect(text.height).toBeGreaterThan(8);
    expect(text.top).toBeGreaterThanOrEqual(Math.max(head.bottom, view.top));
    expect(text.bottom).toBeLessThanOrEqual(view.bottom);
  });

  it("os textos e os botões têm contraste (4,5:1)", async () => {
    await openWithQuestion();
    const check = (element: Element) => expect(contrast(rgb(getComputedStyle(element).color), backgroundOf(element)), element.textContent ?? "").toBeGreaterThanOrEqual(4.5);
    for (const element of [
      byText("button", "Procurar de novo"),
      byText("button", "Descartar rascunho"),
      q(".assistant-choice .choice-title")!,
      byText(".assistant-choice", "Nenhum destes: escolher no mapa"),
      q(".assistant-card.is-draft > h3")!,
      q(".assistant-form textarea")!,
      q(".creation-head .chat-notice")!,
    ]) check(element);
    const key = q(".assistant-choice .choice-title")!;
    expect(contrast(rgb(getComputedStyle(key, "::before").color), backgroundOf(key))).toBeGreaterThanOrEqual(4.5);
    const textarea = q<HTMLTextAreaElement>(".assistant-form textarea")!;
    expect(contrast(rgb(getComputedStyle(textarea).borderTopColor), backgroundOf(textarea.parentElement!))).toBeGreaterThanOrEqual(1.2);
  });

  it.each([[1440, 900], [390, 844]])("sem rolagem horizontal com %i px de tela", async (width, height) => {
    await page.viewport(width, height);
    await openWithQuestion();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const over = [...document.querySelectorAll<HTMLElement>(".chat-panel *")].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1).map((element) => `${element.tagName}.${element.className}:${Math.round(element.getBoundingClientRect().right)}`);
    expect(over).toEqual([]);
    for (const element of [q(".chat-panel")!, q(".creation-thread")!, q(".creation-head")!, q(".creation-body .assistant-scroll")!, q(".assistant-form")!]) {
      expect(element.scrollWidth, element.className).toBeLessThanOrEqual(element.clientWidth);
    }
  });

  it("com a pergunta aberta, o cabeçalho e a linha da barra dizem 'sua vez'", async () => {
    await openWithQuestion();
    expect(q(".creation-head .creation-badge")?.textContent).toBe("sua vez");
    expect(creationRow().querySelector(".creation-badge")?.textContent).toBe("sua vez");
  });
});

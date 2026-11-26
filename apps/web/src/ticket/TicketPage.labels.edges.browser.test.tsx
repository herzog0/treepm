// Campo "Etiquetas" (ADR 0065) em Chromium real, com ponteiro: pôr e tirar pelo mouse, clique fora, gravação em voo sem remontar
// nem perder o foco, nome longo, altura da linha e nada se deslocando entre o mousedown e o mouseup.
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ApiClient, Label } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import type { FakeLabelStep } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const COLORS = ["gray", "brown", "orange", "olive", "cyan", "indigo", "violet", "rose"] as const;
const make = (n: number, name = (i: number) => `Etiqueta ${String(i).padStart(2, "0")}`): Label[] => Array.from({ length: n }, (_, i) => ({ id: `l-${i}`, name: name(i), color: COLORS[i % 8] as Label["color"] }));
const bug: Label = { id: "l-bug", name: "Bug", color: "rose" };
const client1: Label = { id: "l-cli", name: "Cliente X", color: "cyan" };
const debt: Label = { id: "l-debt", name: "Dívida técnica", color: "brown" };

async function mount(options: { labels?: Label[]; project?: Label[]; role?: "admin" | "reader" } = {}) {
  const project = makeProject("p1", "ENG", "Engenharia");
  const script: FakeLabelStep[] = [];
  const labels = options.labels ?? [bug];
  const client = makeTreeClient({ projects: [project], tickets: { p1: [makeTicket("t1", "p1", 1, "Revisar", { key: "ENG-1", labels, dueDate: "2026-12-12" })] }, labels: { p1: options.project ?? [bug, client1, debt, ...labels.filter((l) => ![bug, client1, debt].some((k) => k.id === l.id))] }, labelScript: script });
  const noop = () => undefined;
  const me = options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin");
  await page.viewport(1440, 900);
  const screen = await render(<TicketPage client={client as ApiClient} me={me} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />);
  await expect.element(screen.getByText("Etiquetas", { exact: true })).toBeVisible();
  await settle(200);
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const rowOf = (term: string) => [...document.querySelectorAll(".ticket-fields dt")].find((dt) => dt.textContent === term)!.closest(".ticket-row") as HTMLElement;
  return {
    unmount: () => screen.unmount(),
    client,
    script,
    add: () => q<HTMLButtonElement>(".ticket-labels-add")!,
    picker: () => q<HTMLElement>(".ticket-labels-picker"),
    input: () => q<HTMLInputElement>(".ticket-labels-search"),
    option: (name: string) => [...document.querySelectorAll<HTMLElement>(".ticket-labels-option")].find((o) => o.textContent === name)!,
    pills: () => [...document.querySelectorAll(".ticket-labels-row .label-pill-name")].map((pill) => pill.textContent),
    rowOf,
    sent: () => (client.changeTicketLabels as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[1]),
  };
}
const rect = (el: Element | null) => {
  const r = el!.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
};
const notBody = () => document.activeElement !== document.body && document.activeElement !== null;

describe("Etiquetas com ponteiro e bordas (ADR 0065)", () => {
  it("põe e tira pelo mouse; o foco nunca cai no body", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(150);
    await userEvent.click(m.option("Cliente X"));
    await settle(300);
    expect({ pills: m.pills(), foco: document.activeElement === m.input() }).toEqual({ pills: ["Bug", "Cliente X"], foco: true });
    await userEvent.click(document.querySelector("button[aria-label='Tirar etiqueta Bug']")!);
    await settle(300);
    expect({ pills: m.pills(), naoBody: notBody(), sent: m.sent() }).toEqual({ pills: ["Cliente X"], naoBody: true, sent: [{ add: [{ labelId: "l-cli" }] }, { remove: ["l-bug"] }] });
  });

  it("clique fora fecha o seletor sem gravar", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(100);
    await userEvent.keyboard("abc");
    await userEvent.click(document.querySelector(".ticket-page h1, .ticket-page h2") ?? document.querySelector(".ticket-page")!, { position: { x: 5, y: 5 } });
    await settle(100);
    expect({ aberto: m.picker() !== null, sent: m.sent() }).toEqual({ aberto: false, sent: [] });
  });

  it("gravação em voo: o seletor é o MESMO nó, o foco fica nele e não anda nada; a resposta antiga não apaga a nova", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(150);
    const picker = m.picker();
    const input = m.input();
    const at = (el: Element | null) => {
      const { x, y, w } = rect(el);
      return { x, y, w }; // a altura cresce quando a lista ganha a etiqueta criada; o lugar não muda
    };
    const before = at(picker);
    let release!: () => void;
    let releaseSecond!: () => void;
    m.script.push({ hold: new Promise<void>((resolve) => (release = resolve)) }, { hold: new Promise<void>((resolve) => (releaseSecond = resolve)) });
    await userEvent.keyboard("{ArrowDown}{Enter}"); // Cliente X, segurado
    await settle(100);
    const during = { mesmoNo: m.picker() === picker && m.input() === input, foco: document.activeElement === input, pills: m.pills(), rect: at(m.picker()) };
    await userEvent.keyboard("Novo{Enter}"); // segundo pedido, na fila
    await settle(100);
    expect(during).toEqual({ mesmoNo: true, foco: true, pills: ["Bug", "Cliente X"], rect: before });
    expect(m.pills()).toEqual(["Bug", "Cliente X", "Novo"]);
    release(); // a resposta do PRIMEIRO pedido ({labels: [Bug, Cliente X]}) não pode apagar "Novo", ainda em voo
    await settle(300);
    expect({ mesmoNo: m.picker() === picker, foco: document.activeElement === input, pills: m.pills() }).toEqual({ mesmoNo: true, foco: true, pills: ["Bug", "Cliente X", "Novo"] });
    releaseSecond();
    await settle(500);
    expect({ mesmoNo: m.picker() === picker && m.input() === input, foco: document.activeElement === input, pills: m.pills(), rect: at(m.picker()), sent: m.sent() }).toEqual({
      mesmoNo: true, foco: true, pills: ["Bug", "Cliente X", "Novo"], rect: before, sent: [{ add: [{ labelId: "l-cli" }] }, { add: [{ name: "Novo" }] }],
    });
  });

  it("erro em voo volta ao estado confirmado, mostra a frase e mantém o foco", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(150);
    m.script.push({ error: ["conflict", "label_limit_ticket"] });
    await userEvent.keyboard("Novo{Enter}");
    await settle(300);
    expect({ pills: m.pills(), alerta: document.querySelector(".ticket-labels [role='alert']")?.textContent, foco: document.activeElement === m.input() }).toEqual({
      pills: ["Bug"], alerta: "Um ticket pode ter no máximo 20 etiquetas. Tire uma antes de pôr outra.", foco: true,
    });
    // o alerta aparece por cima, não atrás do seletor aberto
    const alert = document.querySelector<HTMLElement>(".ticket-labels [role='alert']")!;
    const box = alert.getBoundingClientRect();
    expect(alert.contains(document.elementFromPoint(box.x + 4, box.y + box.height / 2))).toBe(true);
  });

  it("nada se desloca entre o mousedown e o mouseup (opção, seletor e × da pastilha)", async () => {
    const m = await mount({ labels: [bug, debt] });
    await userEvent.click(m.add());
    await settle(150);
    const target = m.option("Cliente X");
    const watched = () => ({ alvo: rect(target), seletor: rect(m.picker()), botao: rect(m.add()) });
    const before = watched();
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await settle(50);
    const between = watched();
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    expect(between).toEqual(before);
    // depois do clique a pastilha entra, mas o seletor fica onde estava, também depois da resposta e do recarregamento
    await userEvent.click(target);
    await settle(400);
    expect({ pills: m.pills(), seletor: rect(m.picker()) }).toEqual({ pills: ["Bug", "Cliente X", "Dívida técnica"], seletor: before.seletor });
    await userEvent.keyboard("{Escape}");
    const x = document.querySelector<HTMLElement>("button[aria-label='Tirar etiqueta Dívida técnica']")!;
    const xBefore = rect(x);
    x.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await settle(50);
    expect(rect(x)).toEqual(xBefore);
  });

  it("nome longo corta com reticências e mostra inteiro no title", async () => {
    const long: Label = { id: "l-long", name: "W".repeat(60), color: "indigo" };
    await mount({ labels: [long] });
    const pill = document.querySelector<HTMLElement>(".ticket-labels-row .label-pill")!;
    const name = pill.querySelector<HTMLElement>(".label-pill-name")!;
    expect({ title: pill.title, corta: name.scrollWidth > name.clientWidth, reticencias: getComputedStyle(name).textOverflow, cabe: pill.getBoundingClientRect().right <= pill.closest("dd")!.getBoundingClientRect().right + 0.5 }).toEqual({
      title: "W".repeat(60), corta: true, reticencias: "ellipsis", cabe: true,
    });
  });

  it("a linha tem a altura da do Prazo com 0 e 3 etiquetas (editando ou lendo) e quebra com 12", async () => {
    const heights: Record<string, number> = {};
    for (const [name, labels, role] of [["0", [], "admin"], ["3", [bug, client1, debt], "admin"], ["3 leitor", [bug, client1, debt], "reader"], ["0 leitor", [], "reader"]] as const) {
      const m = await mount({ labels: [...labels], role });
      heights[name] = Math.round(m.rowOf("Etiquetas").getBoundingClientRect().height);
      heights[`prazo ${name}`] = Math.round(m.rowOf("Prazo").getBoundingClientRect().height);
      m.unmount();
    }
    expect(heights).toEqual({ "0": heights["prazo 0"], "3": heights["prazo 3"], "3 leitor": heights["prazo 3 leitor"], "0 leitor": heights["prazo 0 leitor"], "prazo 0": heights["prazo 0"], "prazo 3": heights["prazo 3"], "prazo 3 leitor": heights["prazo 3 leitor"], "prazo 0 leitor": heights["prazo 0 leitor"] });
    const m = await mount({ labels: make(12) });
    const row = m.rowOf("Etiquetas");
    const tops = new Set([...row.querySelectorAll(".ticket-labels-row .label-pill")].map((pill) => Math.round(pill.getBoundingClientRect().top)));
    expect({ linhas: tops.size > 1, maisAlta: row.getBoundingClientRect().height > m.rowOf("Prazo").getBoundingClientRect().height, todas: m.pills().length }).toEqual({ linhas: true, maisAlta: true, todas: 12 });
  });
});

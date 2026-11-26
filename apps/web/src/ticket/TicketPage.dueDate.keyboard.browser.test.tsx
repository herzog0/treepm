import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ApiClient } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makePerson, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { ClockContext } from "./clock.js";
import { TicketPage } from "./TicketPage.js";

// Campo "Prazo" em Chromium de verdade (ADR 0064; TREEPM-467). O `<input type="date">` emite um `change` a cada tecla de
// um segmento, com uma data completa ou vazia: o campo guarda um rascunho e só grava quando a pessoa confirma (Enter ou
// saída do campo), uma vez, se o rascunho é uma data válida e diferente. Esc descarta; tirar o prazo é só pelo "×".
// Cada cenário confere o número de PATCHes e o valor. O Chromium da suíte está em en-US: segmentos mm/dd/aaaa.

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const today = () => new Date(2026, 10, 26, 15, 0);

async function mount(dueDate: string | null) {
  const project = makeProject("p1", "ENG", "Engenharia");
  const ticket = makeTicket("t1", "p1", 123, "Revisar", { key: "ENG-123", dueDate, status: "in_progress" });
  const client = makeTreeClient({ projects: [project], tickets: { p1: [ticket] }, people: [makePerson("person-1", "Ana")] });
  const sent: (string | null | undefined)[] = [];
  const original = client.updateTicket;
  Object.assign(client, {
    updateTicket: async (id: string, body: { dueDate?: string | null }) => {
      sent.push(body.dueDate);
      await settle(150); // uma ida ao servidor
      return original(id, body as never);
    },
  });
  let closed = 0;
  const noop = () => undefined;
  await page.viewport(1440, 900);
  const screen = await render(
    <ClockContext.Provider value={today}>
      <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={() => (closed += 1)} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />
    </ClockContext.Provider>,
  );
  await expect.element(screen.getByText("Prazo", { exact: true })).toBeVisible();
  await settle(300);
  const input = document.querySelector<HTMLInputElement>(".ticket-due-input")!;
  const row = input.closest(".ticket-row") as HTMLElement;
  return { sent, input, row, closed: () => closed };
}

/** Entra no campo pelo teclado, como quem chega com Tab. */
async function enter(input: HTMLInputElement) {
  input.focus();
  await settle(50);
}

describe("Prazo pelo teclado (Chromium)", () => {
  it("trocar o dia 12 por 15 e confirmar com Enter grava UMA vez o dia 15, sem perder o foco no meio", async () => {
    const { sent, input, row } = await mount("2026-12-12");
    await enter(input);
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("1");
    await settle(400);
    expect(sent).toEqual([]);
    expect(document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    await userEvent.keyboard("5");
    await settle(400);
    expect(sent).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await settle(600);
    expect(sent).toEqual(["2026-12-15"]);
    input.blur();
    await settle(400);
    expect(sent).toEqual(["2026-12-15"]);
    expect(row.textContent).toContain("15 de dezembro de 2026");
  });

  it("Backspace num segmento e sair do campo não tira o prazo: volta ao valor de antes", async () => {
    const { sent, input, row } = await mount("2026-12-12");
    await enter(input);
    await userEvent.keyboard("{Backspace}");
    await settle(400);
    expect(sent).toEqual([]);
    input.blur();
    await settle(400);
    expect(sent).toEqual([]);
    expect(input.value).toBe("2026-12-12");
    expect(row.textContent).toContain("12 de dezembro de 2026");
  });

  it("digitar o ano 2027 (4 teclas) e confirmar com Enter grava UMA vez, 2027", async () => {
    const { sent, input } = await mount("2026-12-12");
    await enter(input);
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    for (const key of ["2", "0", "2", "7"]) {
      await userEvent.keyboard(key);
      await settle(300);
    }
    expect(sent).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await settle(600);
    expect(sent).toEqual(["2027-12-12"]);
  });

  it("sem prazo: digitar 12/15/2026 e sair do campo grava UMA vez", async () => {
    const { sent, input, row } = await mount(null);
    await enter(input);
    for (const key of "12152026".split("")) {
      await userEvent.keyboard(key);
      await settle(150);
    }
    expect(sent).toEqual([]);
    input.blur();
    await settle(600);
    expect(sent).toEqual(["2026-12-15"]);
    expect(row.textContent).toContain("15 de dezembro de 2026");
  });

  it("sem pausas: trocar o dia 12 por 15 digitando rápido e sair grava UMA vez, o dia 15", async () => {
    const { sent, input } = await mount("2026-12-12");
    await enter(input);
    await userEvent.keyboard("{ArrowRight}15");
    input.blur();
    await settle(800);
    expect(sent).toEqual(["2026-12-15"]);
  });

  it("Esc descarta o rascunho e não fecha a página; sair depois não grava", async () => {
    const { sent, input, row, closed } = await mount("2026-12-12");
    await enter(input);
    await userEvent.keyboard("{ArrowRight}15");
    await settle(200);
    await userEvent.keyboard("{Escape}");
    await settle(200);
    expect(input.value).toBe("2026-12-12");
    expect(closed()).toBe(0);
    input.blur();
    await settle(400);
    expect(sent).toEqual([]);
    expect(row.textContent).toContain("12 de dezembro de 2026");
  });

  it("sem prazo: rascunho incompleto ao sair não grava nada", async () => {
    const { sent, input, row } = await mount(null);
    await enter(input);
    await userEvent.keyboard("1215");
    await settle(200);
    input.blur();
    await settle(400);
    expect(sent).toEqual([]);
    expect(input.value).toBe("");
    expect(row.textContent).toContain("Definir prazo");
  });

  it("o botão × tira o prazo com UM PATCH nulo", async () => {
    const { sent, row } = await mount("2026-12-12");
    await userEvent.click(row.querySelector<HTMLButtonElement>("button[aria-label='Tirar o prazo']")!);
    await settle(600);
    expect(sent).toEqual([null]);
    expect(row.textContent).toContain("Definir prazo");
  });

  it("em edição os segmentos do campo ficam visíveis; fora de edição, o texto com a data", async () => {
    const { input, row } = await mount("2026-12-12");
    const text = row.querySelector<HTMLElement>(".ticket-due-text")!;
    expect(getComputedStyle(input).opacity).toBe("0");
    expect(text.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(row.getBoundingClientRect().height).toBe(34);
    await enter(input);
    expect(getComputedStyle(input).opacity).toBe("1");
    expect(input.getBoundingClientRect().width).toBeGreaterThanOrEqual(100);
    // O texto fica na caixa (invisível) para nada na linha se mover; os segmentos ocupam o lugar dele.
    expect(getComputedStyle(text).visibility).toBe("hidden");
    expect(input.getBoundingClientRect().width).toBe(text.getBoundingClientRect().width);
    input.blur();
    await settle(100);
    expect(getComputedStyle(input).opacity).toBe("0");
    expect(row.getBoundingClientRect().height).toBe(34);
  });
});

describe("Prazo pelo mouse (Chromium)", () => {
  it("o clique no texto entra no campo e pede o calendário do navegador", async () => {
    const { input } = await mount("2026-12-12");
    let opened = 0;
    const original = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = function () {
      opened += 1;
    };
    try {
      await userEvent.click(input);
      await settle(100);
      expect(document.activeElement).toBe(input);
      expect(opened).toBe(1);
    } finally {
      HTMLInputElement.prototype.showPicker = original;
    }
  });

  it("escolher no calendário (mudança sem tecla) grava UMA vez, sem segundo clique; sair depois não grava de novo", async () => {
    // O calendário nativo é uma janela do navegador que a suíte não alcança: a escolha nele chega à página como `input`
    // e `change` com a data completa e sem tecla antes, que é o que se reproduz aqui.
    const { sent, input, row } = await mount("2026-12-12");
    const original = HTMLInputElement.prototype.showPicker;
    HTMLInputElement.prototype.showPicker = () => undefined;
    try {
      await userEvent.click(input);
      await settle(100);
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "2026-12-20");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(600);
      expect(sent).toEqual(["2026-12-20"]);
      input.blur();
      await settle(400);
      expect(sent).toEqual(["2026-12-20"]);
      expect(row.textContent).toContain("20 de dezembro de 2026");
    } finally {
      HTMLInputElement.prototype.showPicker = original;
    }
  });

  // O calendário nativo de verdade (sem trocar `showPicker`): dentro dele as setas e o Esc emitem só `input`; a confirmação (Enter ou
  // clique num dia) emite `change`. Só a confirmação grava.
  it("calendário real: andar com as setas não grava; Enter confirma e grava UMA vez a data escolhida", async () => {
    const { sent, input, row } = await mount("2026-12-12");
    await userEvent.click(input);
    await settle(300);
    await userEvent.keyboard("{ArrowRight}");
    await settle(300);
    await userEvent.keyboard("{ArrowRight}");
    await settle(300);
    expect(sent).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await settle(600);
    expect(sent).toEqual(["2026-12-14"]);
    input.blur();
    await settle(400);
    expect(sent).toEqual(["2026-12-14"]);
    expect(row.textContent).toContain("14 de dezembro de 2026");
  });

  it("calendário real: Esc fecha sem gravar e volta à data de antes", async () => {
    const { sent, input, row } = await mount("2026-12-12");
    await userEvent.click(input);
    await settle(300);
    await userEvent.keyboard("{ArrowRight}");
    await settle(300);
    await userEvent.keyboard("{Escape}");
    await settle(300);
    input.blur();
    await settle(400);
    expect(sent).toEqual([]);
    expect(row.textContent).toContain("12 de dezembro de 2026");
  });
});

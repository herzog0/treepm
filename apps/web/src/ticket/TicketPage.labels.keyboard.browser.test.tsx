// Campo "Etiquetas" (ADR 0065) em Chromium real, só pelo teclado: criar, escolher com setas, Esc, Backspace e tirar.
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ApiClient, Label } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bug: Label = { id: "l-bug", name: "Bug", color: "rose" };
const client1: Label = { id: "l-cli", name: "Cliente X", color: "cyan" };
const debt: Label = { id: "l-debt", name: "Dívida técnica", color: "brown" };

async function mount(labels: Label[] = [bug]) {
  const project = makeProject("p1", "ENG", "Engenharia");
  const client = makeTreeClient({ projects: [project], tickets: { p1: [makeTicket("t1", "p1", 1, "Revisar", { key: "ENG-1", labels })] }, labels: { p1: [bug, client1, debt] } });
  const noop = () => undefined;
  await page.viewport(1440, 900);
  const screen = await render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={noop} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />);
  await expect.element(screen.getByText("Etiquetas", { exact: true })).toBeVisible();
  await settle(200);
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  return {
    client,
    add: () => q<HTMLButtonElement>(".ticket-labels-add")!,
    input: () => q<HTMLInputElement>(".ticket-labels-search"),
    pills: () => [...document.querySelectorAll(".ticket-labels-row .label-pill-name")].map((pill) => pill.textContent),
    activeText: () => {
      const id = q("input.ticket-labels-search")?.getAttribute("aria-activedescendant");
      return id ? document.getElementById(id)?.textContent : null;
    },
    sent: () => (client.changeTicketLabels as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[1]),
  };
}

describe("Etiquetas pelo teclado (ADR 0065)", () => {
  it("abre pelo Adicionar, cria com Enter sem perder o foco e Esc devolve o foco ao Adicionar", async () => {
    const m = await mount();
    m.add().focus();
    await userEvent.keyboard("{Enter}");
    await settle(100);
    expect(document.activeElement).toBe(m.input());
    await userEvent.keyboard("Urgente");
    expect(m.sent()).toEqual([]); // nada grava a cada tecla
    expect(m.activeText()).toBe("Criar «Urgente»");
    await userEvent.keyboard("{Enter}");
    await settle(300);
    expect({ pills: m.pills(), foco: document.activeElement === m.input(), busca: m.input()?.value }).toEqual({ pills: ["Bug", "Urgente"], foco: true, busca: "" });
    await userEvent.keyboard("{Escape}");
    await settle(50);
    expect({ aberto: m.input() !== null, foco: document.activeElement === m.add(), sent: m.sent() }).toEqual({ aberto: false, foco: true, sent: [{ add: [{ name: "Urgente" }] }] });
    // Esc no seletor não fecha a página
    expect(document.querySelector(".ticket-page")).not.toBeNull();
  });

  it("setas movem a opção ativa (aria-activedescendant, com volta) e Enter escolhe", async () => {
    const m = await mount();
    m.add().focus();
    await userEvent.keyboard("{Enter}");
    await settle(150);
    expect(m.activeText()).toBe("Bug");
    await userEvent.keyboard("{ArrowDown}");
    expect(m.activeText()).toBe("Cliente X");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(m.activeText()).toBe("Dívida técnica");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await settle(300);
    expect({ pills: m.pills(), sent: m.sent(), foco: document.activeElement === m.input() }).toEqual({ pills: ["Bug", "Cliente X"], sent: [{ add: [{ labelId: "l-cli" }] }], foco: true });
    // Enter na que já está no ticket tira
    await userEvent.keyboard("{ArrowUp}{Enter}");
    await settle(300);
    expect(m.pills()).toEqual(["Cliente X"]);
  });

  it("Backspace com a busca vazia tira a última etiqueta; com texto só apaga o texto", async () => {
    const m = await mount([bug, client1]);
    m.add().focus();
    await userEvent.keyboard("{Enter}");
    await settle(100);
    await userEvent.keyboard("ab{Backspace}");
    expect({ pills: m.pills(), busca: m.input()?.value }).toEqual({ pills: ["Bug", "Cliente X"], busca: "a" });
    await userEvent.keyboard("{Backspace}{Backspace}");
    await settle(300);
    expect({ pills: m.pills(), sent: m.sent(), foco: document.activeElement === m.input() }).toEqual({ pills: ["Bug"], sent: [{ remove: ["l-cli"] }], foco: true });
  });

  it("tira pelo botão da pastilha com Enter e o foco vai para a vizinha, depois para o Adicionar, nunca para o body", async () => {
    const m = await mount([bug, client1]);
    document.querySelector<HTMLButtonElement>("button[aria-label='Tirar etiqueta Bug']")!.focus();
    await userEvent.keyboard("{Enter}");
    await settle(300);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Tirar etiqueta Cliente X");
    await userEvent.keyboard("{Enter}");
    await settle(300);
    expect({ pills: m.pills(), foco: document.activeElement === m.add(), sent: m.sent() }).toEqual({ pills: [], foco: true, sent: [{ remove: ["l-bug"] }, { remove: ["l-cli"] }] });
  });
});

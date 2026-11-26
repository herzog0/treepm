// Campo "Etiquetas" (ADR 0065; TREEPM-466) em Chromium real: as proteções pedidas pela revisão E1 (item 4). Backspace segurado não tira
// etiquetas; o segundo clique de um duplo clique não atinge a vizinha que desliza para baixo do ponteiro; tirar uma etiqueta que outra
// pessoa apagou (404) vale como sucesso; Esc com o seletor aberto fecha o seletor, onde quer que esteja o foco na linha.
import { describe, expect, it, vi } from "vitest";
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
const COLORS = ["gray", "brown", "orange", "olive", "cyan", "indigo", "violet", "rose"] as const;
const bug: Label = { id: "l-bug", name: "Bug", color: "rose" };
const cli: Label = { id: "l-cli", name: "Cliente X", color: "cyan" };
const debt: Label = { id: "l-debt", name: "Dívida técnica", color: "brown" };

async function mount(options: { labels?: Label[]; project?: Label[] } = {}) {
  const project = makeProject("p1", "ENG", "Engenharia");
  const labels = options.labels ?? [bug];
  const client = makeTreeClient({
    projects: [project],
    tickets: { p1: [makeTicket("t1", "p1", 1, "Revisar", { key: "ENG-1", labels })] },
    labels: { p1: options.project ?? [bug, cli, debt] },
  });
  const onClose = vi.fn();
  const noop = () => undefined;
  await page.viewport(1440, 900);
  const screen = await render(
    <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} onOpenTicket={noop} onClose={onClose} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />,
  );
  await expect.element(screen.getByText("Etiquetas", { exact: true })).toBeVisible();
  await settle(200);
  const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const calls = (name: keyof ApiClient) => (client[name] as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return {
    client,
    onClose,
    add: () => q<HTMLButtonElement>(".ticket-labels-add")!,
    picker: () => q<HTMLElement>(".ticket-labels-picker"),
    input: () => q<HTMLInputElement>(".ticket-labels-search"),
    option: (name: string) => [...document.querySelectorAll<HTMLElement>(".ticket-labels-option")].find((o) => o.textContent === name)!,
    x: (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="Tirar etiqueta ${name}"]`),
    pills: () => [...document.querySelectorAll(".ticket-labels-row .label-pill-name")].map((pill) => pill.textContent),
    alert: () => document.querySelector(".ticket-labels [role='alert']")?.textContent ?? null,
    sent: () => calls("changeTicketLabels").map((call) => call[1]),
    calls: (name: keyof ApiClient) => calls(name).length,
    server: async () => {
      const result = await (client as ApiClient).getTicket("t1");
      return result.ok ? (result.data.labels ?? []).map((l) => l.name) : null;
    },
  };
}

describe("Etiquetas: proteções da revisão E1", () => {
  it("segurar Backspace para apagar o texto digitado não tira etiquetas (a repetição não conta)", async () => {
    const m = await mount({ labels: [bug, cli, debt] });
    await userEvent.click(m.add());
    await settle(150);
    await userEvent.keyboard("ab");
    await userEvent.keyboard("{Backspace>8/}");
    await settle(400);
    expect({ busca: m.input()?.value, pills: m.pills(), pedidos: m.sent() }).toEqual({ busca: "", pills: ["Bug", "Cliente X", "Dívida técnica"], pedidos: [] });
    // Um toque novo, com a busca vazia, tira só a última.
    await userEvent.keyboard("{Backspace}");
    await settle(300);
    expect({ pills: m.pills(), pedidos: m.sent() }).toEqual({ pills: ["Bug", "Cliente X"], pedidos: [{ remove: ["l-debt"] }] });
  });

  it("duplo clique no × de uma pastilha tira só ela (a vizinha que desliza para baixo do ponteiro fica)", async () => {
    const same = ["Aaa1", "Aaa2", "Aaa3"].map((name, i) => ({ id: `l-${i}`, name, color: COLORS[i]! }));
    const m = await mount({ labels: same, project: same });
    await userEvent.dblClick(m.x("Aaa1")!);
    await settle(400);
    expect({ pills: m.pills(), pedidos: m.sent(), servidor: await m.server() }).toEqual({ pills: ["Aaa2", "Aaa3"], pedidos: [{ remove: ["l-0"] }], servidor: ["Aaa2", "Aaa3"] });
  });

  it("duplo clique em Criar «Novo» cria uma vez e não tira nada", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(150);
    await userEvent.keyboard("Novo");
    await userEvent.dblClick(m.option("Criar «Novo»"));
    await settle(400);
    expect({ pills: m.pills(), pedidos: m.sent(), servidor: await m.server() }).toEqual({ pills: ["Bug", "Novo"], pedidos: [{ add: [{ name: "Novo" }] }], servidor: ["Bug", "Novo"] });
  });

  it("duplo clique numa opção põe uma vez (não põe e tira)", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(150);
    await userEvent.dblClick(m.option("Cliente X"));
    await settle(400);
    expect({ pills: m.pills(), pedidos: m.sent(), servidor: await m.server() }).toEqual({ pills: ["Bug", "Cliente X"], pedidos: [{ add: [{ labelId: "l-cli" }] }], servidor: ["Bug", "Cliente X"] });
  });

  it("tirar uma etiqueta que outra pessoa apagou (404) vale como sucesso: sem pastilha que volta, sem erro, ticket e lista recarregados", async () => {
    const m = await mount({ labels: [bug, cli] });
    await (m.client as ApiClient).removeProjectLabel("p1", "l-bug"); // outra pessoa apagou
    const [tickets, lists] = [m.calls("getTicket"), m.calls("listProjectLabels")];
    await userEvent.click(m.x("Bug")!);
    await settle(400);
    expect({ pills: m.pills(), alerta: m.alert(), pedidos: m.sent(), tiraDeNovo: m.x("Bug") }).toEqual({ pills: ["Cliente X"], alerta: null, pedidos: [{ remove: ["l-bug"] }], tiraDeNovo: null });
    expect(m.calls("getTicket")).toBeGreaterThan(tickets);
    expect(m.calls("listProjectLabels")).toBeGreaterThan(lists);
    // A lista do seletor já não tem a etiqueta apagada.
    await userEvent.click(m.add());
    await settle(200);
    expect(m.option("Bug")).toBeUndefined();
  });

  it("Esc com o seletor aberto e o foco no Adicionar fecha o seletor, não a página", async () => {
    const m = await mount();
    await userEvent.click(m.add());
    await settle(150);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect({ foco: document.activeElement === m.add(), aberto: m.picker() !== null }).toEqual({ foco: true, aberto: true });
    await userEvent.keyboard("{Escape}");
    await settle(100);
    expect({ aberto: m.picker() !== null, paginaFechada: m.onClose.mock.calls.length, foco: document.activeElement === m.add() }).toEqual({ aberto: false, paginaFechada: 0, foco: true });
    // Com o seletor fechado, Esc volta a fechar a página.
    await userEvent.keyboard("{Escape}");
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc com o seletor aberto e o foco no × de uma pastilha fecha o seletor, não a página", async () => {
    const m = await mount({ labels: [bug, cli] });
    await userEvent.click(m.add());
    await settle(150);
    m.x("Bug")!.focus();
    await userEvent.keyboard("{Escape}");
    await settle(100);
    expect({ aberto: m.picker() !== null, paginaFechada: m.onClose.mock.calls.length, pills: m.pills() }).toEqual({ aberto: false, paginaFechada: 0, pills: ["Bug", "Cliente X"] });
  });
});

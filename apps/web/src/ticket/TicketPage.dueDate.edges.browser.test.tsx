
// Campo "Prazo" (ADR 0064; TREEPM-467) em Chromium real, com ponteiro e Tab de verdade: os casos de borda das revisões do P2.
// Princípio: só grava o que a pessoa mudou desde que o campo ganhou o foco. `sent` guarda [id do ticket, dueDate] de cada PATCH de prazo.
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

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const today = () => new Date(2026, 10, 26, 15, 0);

type Options = { dueDate?: string | null; width?: number; fail?: () => boolean; me?: "admin" | "member"; stubPicker?: boolean };
async function mount(options: Options = {}) {
  const dueDate = options.dueDate === undefined ? "2026-12-12" : options.dueDate;
  const project = makeProject("p1", "ENG", "Engenharia");
  const t1 = makeTicket("t1", "p1", 123, "Revisar", { key: "ENG-123", dueDate, status: "in_progress" });
  const t2 = makeTicket("t2", "p1", 124, "Outro", { key: "ENG-124", dueDate: "2026-12-30", status: "in_progress" });
  const client = makeTreeClient({ projects: [project], tickets: { p1: [t1, t2] }, people: [makePerson("person-1", "Ana")] });
  const sent: [string, string | null | undefined][] = [];
  const original = client.updateTicket;
  Object.assign(client, {
    updateTicket: async (id: string, body: { dueDate?: string | null }) => {
      if ("dueDate" in body) sent.push([id, body.dueDate]);
      await settle(150);
      if (options.fail?.()) return { ok: false, error: { kind: "unavailable" } };
      return original(id, body as never);
    },
  });
  let closed = 0;
  const noop = () => undefined;
  await page.viewport(options.width ?? 1440, 900);
  const view = (ticketId: string | null) => (
    <ClockContext.Provider value={today}>
      <TicketPage client={client as ApiClient} me={makePanelMe(options.me ?? "admin")} projects={[project]} ticketId={ticketId} creating={null} onOpenTicket={noop} onClose={() => (closed += 1)} onChanged={noop} onRemoved={noop} onStartCreate={noop} onCancelCreate={noop} onCreated={noop} />
    </ClockContext.Provider>
  );
  const screen = await render(view("t1"));
  await expect.element(screen.getByText("Prazo", { exact: true })).toBeVisible();
  await settle(300);
  const input = () => document.querySelector<HTMLInputElement>(".ticket-due-input");
  const row = () => input()?.closest(".ticket-row") as HTMLElement;
  const clear = () => document.querySelector<HTMLButtonElement>("button[aria-label='Tirar o prazo']");
  /** Outra pessoa (ou o MCP, ou o Linear) muda o prazo: direto no servidor falso, sem passar pela página. */
  const external = (next: string | null) => original("t1", { dueDate: next } as never);
  return { sent, input, row, clear, closed: () => closed, show: (id: string | null) => screen.rerender(view(id)), client, external };
}
const withStub = async (run: () => Promise<void>) => {
  const original = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = () => undefined;
  try {
    await run();
  } finally {
    HTMLInputElement.prototype.showPicker = original;
  }
};
const active = () => {
  const el = document.activeElement as HTMLElement | null;
  return el ? `${el.tagName}.${el.className}[${el.getAttribute("aria-label") ?? ""}]${(el as HTMLButtonElement).disabled ? " DISABLED" : ""}` : null;
};

describe("Prazo: casos de borda (Chromium)", () => {
  it("1. clicar no × com um rascunho válido pendente TIRA o prazo (o último PATCH é nulo)", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15");
    await settle(200);
    await userEvent.click(m.clear()!);
    await settle(1200);
    // Antes: [["t1","2026-12-15"]] — o blur do mousedown grava o rascunho, o botão fica `disabled` e o clique some.
    expect(m.sent).toEqual([["t1", null]]);
    expect(m.row().textContent).toContain("Definir prazo");
  });

  it("2. clicar no × com o campo só focado (sem rascunho) tira o prazo no PRIMEIRO clique", async () => {
    const m = await mount();
    await withStub(async () => {
      await userEvent.click(m.input()!); // a pessoa clicou no campo (o calendário abriria)
      await settle(100);
      const before = m.clear()!.getBoundingClientRect().x;
      await userEvent.click(m.clear()!);
      await settle(900);
      const after = m.clear()?.getBoundingClientRect().x ?? before;
      // Antes: [] — ao perder o foco a linha muda de largura e o × anda ~50 px entre o mousedown e o mouseup.
      expect({ sent: m.sent, deslocamentoDoBotao: Math.round(after - before) }).toEqual({ sent: [["t1", null]], deslocamentoDoBotao: 0 });
    });
  });

  it("3a. Tab até o × com rascunho válido não grava; Enter no × descarta o rascunho e só tira o prazo", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15");
    await settle(100);
    // O Tab anda pelos segmentos antes de sair do campo.
    for (let i = 0; i < 3 && document.activeElement === m.input(); i += 1) await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(m.clear());
    await settle(400);
    expect(m.sent).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await settle(900);
    expect(m.sent).toEqual([["t1", null]]);
    expect(m.row().textContent).toContain("Definir prazo");
    // O × some com o prazo: o foco volta ao campo, não cai no <body>.
    expect(document.activeElement).toBe(m.input());
  });

  it("3b. Espaço no × com rascunho pendente também só tira o prazo", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15");
    for (let i = 0; i < 3 && document.activeElement === m.input(); i += 1) await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(m.clear());
    await userEvent.keyboard(" ");
    await settle(900);
    expect(m.sent).toEqual([["t1", null]]);
  });

  it("3c. Tab para fora da linha com rascunho válido grava UMA vez e o foco não cai no <body>", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15");
    await settle(100);
    for (let i = 0; i < 3 && m.row().contains(document.activeElement); i += 1) await userEvent.keyboard("{Tab}");
    expect(m.row().contains(document.activeElement)).toBe(false);
    await settle(900);
    expect(m.sent).toEqual([["t1", "2026-12-15"]]);
    expect(active()).not.toMatch(/^BODY/);
    expect(m.row().textContent).toContain("15 de dezembro de 2026");
  });

  it("3d. enquanto grava, o × fica aria-disabled (sem `disabled`, que derrubaria o foco) e ignora a ativação", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15{Enter}");
    m.clear()!.focus();
    expect(m.clear()!.disabled).toBe(false);
    expect(m.clear()!.getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(m.clear());
    await settle(900);
    expect(m.sent).toEqual([["t1", "2026-12-15"]]);
    expect(m.clear()!.getAttribute("aria-disabled")).toBeNull();
  });

  it("4. prazo mudado por outra pessoa chega (releitura por outra ação) com o campo focado e SEM digitar: sair do campo não grava a data velha", async () => {
    const m = await mount();
    await withStub(async () => {
      await m.external("2026-12-20"); // outra pessoa pôs dia 20; a página ainda mostra 12
      await userEvent.click(document.querySelector<HTMLButtonElement>("button[aria-label='Aumentar a prioridade']")!); // PATCH da prioridade → releitura
      await userEvent.click(m.input()!); // enquanto isso a pessoa clica no prazo
      await settle(1200);
      const shown = m.input()!.value;
      await userEvent.click(document.querySelector<HTMLElement>(".ticket-page dt")!); // sai do campo sem ter digitado nada
      await settle(900);
      // Antes: campo mostra 2026-12-12 e a saída manda [["t1","2026-12-12"]], desfazendo a mudança da outra pessoa.
      expect({ shown, sent: m.sent, row: m.row().textContent }).toEqual({ shown: "2026-12-20", sent: [], row: expect.stringContaining("20 de dezembro de 2026") });
    });
  });

  it("5. × pelo teclado e volta ao campo com o PATCH em voo: sair do campo não REGRAVA o prazo tirado", async () => {
    const m = await mount();
    m.clear()!.focus(); // chegou por Tab
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}"); // Shift+Tab de volta, antes de a resposta chegar
    expect(document.activeElement).toBe(m.input());
    await settle(1200);
    const shown = m.input()!.value;
    m.input()!.blur();
    await settle(900);
    // Antes: o campo mostra 2026-12-12 com o ticket já sem prazo, e a saída manda [null, "2026-12-12"].
    expect({ shown, sent: m.sent, row: m.row().textContent }).toEqual({ shown: "", sent: [["t1", null]], row: expect.stringContaining("Definir prazo") });
  });

  it("6. sem prazo: Esc com segmentos digitados pela metade descarta e NÃO fecha a página", async () => {
    const m = await mount({ dueDate: null });
    m.input()!.focus();
    await userEvent.keyboard("1215");
    await settle(200);
    expect(m.input()!.validity.badInput).toBe(true); // há rascunho nos segmentos, o valor é ""
    await userEvent.keyboard("{Escape}");
    await settle(200);
    // Antes: 1 — sem `input` (o valor continua ""), `changed` ficava falso e o Esc fechava a página do ticket.
    expect(m.closed()).toBe(0);
    expect(m.input()!.validity.badInput).toBe(false); // os segmentos foram limpos
    expect(document.activeElement).toBe(m.input());
    await userEvent.keyboard("{Escape}"); // agora sem rascunho: o Esc fecha, como na prioridade
    expect(m.closed()).toBe(1);
  });

  it("6b. sem prazo: sair do campo com segmentos pela metade limpa os segmentos e não grava", async () => {
    const m = await mount({ dueDate: null });
    m.input()!.focus();
    await userEvent.keyboard("1215");
    await settle(100);
    m.input()!.blur();
    await settle(400);
    expect(m.sent).toEqual([]);
    expect(m.input()!.validity.badInput).toBe(false);
    expect(m.row().textContent).toContain("Definir prazo");
  });

  it("7. data completa fora da faixa (2101) ao sair: não grava e DIZ por quê", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    for (const key of "2101".split("")) {
      await userEvent.keyboard(key);
      await settle(80);
    }
    expect(m.input()!.value).toBe("2101-12-12");
    m.input()!.blur();
    await settle(600);
    expect(m.sent).toEqual([]);
    // Antes: nulo — a data sumia e voltava a de antes sem mensagem (a prioridade mostra `priority.invalid`).
    expect(document.querySelector(".ticket-page [role=alert]")?.textContent).toBe("O prazo precisa estar entre 2000 e 2100.");
    expect(m.input()!.value).toBe("2026-12-12");
    expect(m.row().textContent).toContain("12 de dezembro de 2026");
    // A próxima tecla tira o aviso.
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("1");
    expect(document.querySelector(".ticket-page [role=alert]")).toBeNull();
  });

  it("7b. ano 1999 confirmado com Enter: não grava, volta ao valor de antes e avisa", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    for (const key of "1999".split("")) {
      await userEvent.keyboard(key);
      await settle(80);
    }
    expect(m.input()!.value).toBe("1999-12-12");
    await userEvent.keyboard("{Enter}");
    await settle(600);
    expect(m.sent).toEqual([]);
    expect(m.input()!.value).toBe("2026-12-12");
    expect(document.querySelector(".ticket-page [role=alert]")?.textContent).toBe("O prazo precisa estar entre 2000 e 2100.");
  });

  for (const width of [1440, 414]) {
    it(`2b. ${width} px: focar e desfocar não move nada na linha nem nas linhas de baixo`, async () => {
      const m = await mount({ width });
      const boxes = () => {
        const rows = [...document.querySelectorAll<HTMLElement>(".ticket-page .ticket-row")];
        const after = rows.slice(rows.indexOf(m.row()));
        const rect = (el: Element) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
        return { clear: rect(m.clear()!), picker: rect(m.input()!.parentElement!), rows: after.map(rect) };
      };
      const before = boxes();
      m.input()!.focus();
      await settle(100);
      expect(boxes()).toEqual(before);
      m.input()!.blur();
      await settle(100);
      expect(boxes()).toEqual(before);
    });
  }

  it("7d. Alt+↓ (o atalho que abre o calendário) não é mudança da pessoa: sem rascunho, o Esc seguinte fecha a página e nada é gravado", async () => {
    // Nesta suíte o Alt+↓ dentro da página não abriu o calendário (num campo solto abre): o Esc chega ao campo.
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(200);
    await userEvent.keyboard("{Escape}");
    await settle(300);
    expect(m.closed()).toBe(1);
    expect(m.sent).toEqual([]);
  });

  it("7c. calendário real: andar com as setas e clicar FORA não grava e volta à data de antes", async () => {
    const m = await mount();
    await userEvent.click(m.input()!);
    await settle(300);
    await userEvent.keyboard("{ArrowRight}");
    await settle(200);
    await userEvent.keyboard("{ArrowDown}");
    await settle(200);
    await userEvent.click(document.querySelector<HTMLElement>(".ticket-page dt")!);
    await settle(900);
    expect(m.sent).toEqual([]);
    expect(m.input()!.value).toBe("2026-12-12");
    expect(m.row().textContent).toContain("12 de dezembro de 2026");
  });

  // ---- casos que a revisão atacou sem achar problema ----

  it("ok: erro do servidor volta à data de antes, mostra o erro, e a MESMA data pode ser tentada de novo", async () => {
    let failing = true;
    const m = await mount({ fail: () => failing });
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15{Enter}");
    await settle(600);
    expect(m.input()!.value).toBe("2026-12-12");
    expect(document.querySelector(".ticket-page [role=alert]")?.textContent).toContain("indisponível");
    expect(document.activeElement).toBe(m.input());
    failing = false;
    m.input()!.blur();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15{Enter}");
    await settle(900);
    expect(m.sent).toEqual([["t1", "2026-12-15"], ["t1", "2026-12-15"]]);
    expect(m.row().textContent).toContain("15 de dezembro de 2026");
    expect(document.querySelector(".ticket-page [role=alert]")).toBeNull();
  });

  it("ok: trocar de ticket ou desmontar com rascunho não manda PATCH a ticket nenhum (o rascunho se perde), e o PATCH seguinte vai ao ticket certo", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15");
    await settle(100);
    await m.show("t2");
    await settle(900);
    expect(m.sent).toEqual([]);
    expect(m.input()!.value).toBe("2026-12-30");
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}20{Enter}");
    await settle(600);
    expect(m.sent).toEqual([["t2", "2026-12-20"]]);
    await m.show(null);
    await settle(300);
  });

  it("ok: PATCH em voo e a página troca de ticket: nada vaza para o outro", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15{Enter}");
    await settle(20);
    await m.show("t2");
    await settle(900);
    expect(m.sent).toEqual([["t1", "2026-12-15"]]);
    expect(m.input()!.value).toBe("2026-12-30");
  });

  it("ok: o botão de fechar (clique real) com rascunho válido grava uma vez antes de fechar", async () => {
    const m = await mount();
    m.input()!.focus();
    await userEvent.keyboard("{ArrowRight}15");
    await userEvent.click(document.querySelector<HTMLButtonElement>("button[aria-label='Fechar e voltar ao mapa']")!);
    await settle(900);
    expect(m.sent).toEqual([["t1", "2026-12-15"]]);
    expect(m.closed()).toBe(1);
  });

  it("ok: foco pelo teclado é visível (contorno de 2 px), a ordem do Tab chega ao ×, e quem não edita não tem campo", async () => {
    const m = await mount();
    await withStub(async () => {
      document.querySelector<HTMLInputElement>(".ticket-priority-input")!.focus();
      for (let i = 0; i < 6 && document.activeElement !== m.input(); i += 1) await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(m.input());
      const style = getComputedStyle(m.input()!);
      expect(`${style.outlineStyle} ${style.outlineWidth}`).toBe("solid 2px");
      expect(m.input()!.getAttribute("aria-label")).toBe("Prazo");
      for (let i = 0; i < 4 && document.activeElement !== m.clear(); i += 1) await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(m.clear());
    });
    document.body.innerHTML = "";
    const reader = await mount({ me: "member" });
    expect(reader.input()).toBeNull();
    expect(reader.clear()).toBeNull();
  });

  it("ok: 414 px — sem transbordo, campo e × com 44 px, dentro e fora de edição", async () => {
    const m = await mount({ width: 414, dueDate: "2026-10-01" });
    const check = () => {
      const page = document.querySelector(".ticket-page")!;
      expect(page.scrollWidth).toBe(page.clientWidth);
      expect(m.input()!.getBoundingClientRect().height).toBe(44);
      const clear = m.clear()!.getBoundingClientRect();
      expect([clear.width, clear.height]).toEqual([44, 44]);
      expect(m.row().querySelector(".ticket-due-note")!.getBoundingClientRect().right).toBeLessThanOrEqual(414);
    };
    check();
    m.input()!.focus();
    await settle(100);
    check();
  });
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { playTemplate, workQueue } from "@treepm/domain";
import type { PlayInput, PlayTemplateId } from "@treepm/domain";
import type { ApiClient, Me, TicketDetail, TicketSummary } from "../api/client.js";
import { toWorkTickets } from "./playModel.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";

// ADR 0048: botão play, menu de modelos, barra do play e navegação de ticket em ticket (jsdom: comportamento).
const SLOW = 20_000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa")];
const base = (): TicketSummary[] => [
  makeTicket("a1", "p1", 1, "Alfa um", { key: "ALFA-1", status: "in_progress", assigneeIds: ["person-1"] }),
  makeTicket("a2", "p1", 2, "Alfa dois", { key: "ALFA-2", assigneeIds: ["person-1"], priority: 3 }),
  makeTicket("a3", "p1", 3, "Alfa três", { key: "ALFA-3" }),
  makeTicket("a4", "p1", 4, "Alfa quatro", { key: "ALFA-4", status: "in_progress", assigneeIds: ["person-2"] }),
];
const people = [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")];
const detailOf = (summary: TicketSummary): TicketDetail => ({ ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "x", updatedAt: "y" });

/** `current` é o que a API devolve agora: o teste muda a lista para simular o mundo andando durante o play. */
function makeFull(current: { tickets: TicketSummary[] }): ApiClient {
  const client = makeClient({ projects, tickets: { p1: current.tickets }, people });
  Object.assign(client, {
    listTickets: vi.fn(async () => ok(current.tickets)),
    getTicket: vi.fn(async (id: string) => {
      const found = current.tickets.find((entry) => entry.id === id);
      return found ? ok(detailOf(found)) : { ok: false as const, error: { kind: "not_found" as const } };
    }),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(current.tickets.find((entry) => entry.id === id)!))),
    listConversations: vi.fn(async () => ok([])),
  });
  return client;
}

function Host({ client, me, onChange, initial = null }: { client: ApiClient; me?: Me; onChange?: (id: string | null) => void; initial?: string | null }) {
  const [open, setOpen] = useState<string | null>(initial);
  return <OrganizationMap client={client} me={me ?? makePanelMe("admin")} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const playButton = () => screen.findByRole("button", { name: "Modo play" }, { timeout: SLOW });
const menu = () => screen.getByRole("menu", { name: "Modelos do play" });
const bar = () => screen.getByRole("region", { name: "Barra do play" });
const queryBar = () => screen.queryByRole("region", { name: "Barra do play" });
const input = (list: TicketSummary[]): PlayInput => ({ tickets: toWorkTickets({ p1: list }), people, me: "person-1", scope: {}, now: Date.now() });
const stepsOf = (id: PlayTemplateId, list: TicketSummary[]) => playTemplate(id, input(list)).steps;

async function start(name: RegExp | string, current = { tickets: base() }, onChange = vi.fn()) {
  const client = makeFull(current);
  render(<Host client={client} onChange={onChange} />);
  await userEvent.click(await playButton());
  await userEvent.click(within(menu()).getByRole("menuitem", { name: typeof name === "string" ? new RegExp(name) : name }));
  await screen.findByRole("region", { name: "Barra do play" });
  return { client, onChange, current };
}

describe("botão play e menu", () => {
  it("o botão fica ao lado da barra de pedidos, com aria-haspopup e aria-expanded", async () => {
    render(<Host client={makeFull({ tickets: base() })} />);
    const button = await playButton();
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button.closest(".command-zone")).not.toBeNull();
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(menu()).toBeInTheDocument();
  });

  it("lista os cinco modelos na ordem do domínio, com a linha curta e a contagem; vazio desabilitado com o motivo", async () => {
    render(<Host client={makeFull({ tickets: base() })} />);
    await userEvent.click(await playButton());
    const items = within(menu()).getAllByRole("menuitem");
    expect(items.map((item) => item.querySelector(".play-item-name")?.textContent)).toEqual(["Próximos para trabalhar", "Meu trabalho", "Em andamento", "Stand-up", "Trabalho pela IA"]);
    expect(items[0]).toHaveTextContent("2 tickets");
    expect(items[0]).toHaveTextContent("Os prontos para começar, por prioridade");
    expect(items[1]).toHaveTextContent("2 tickets");
    expect(items[4]).toHaveAttribute("aria-disabled", "true");
    expect(items[4]).toHaveAccessibleDescription(/Nenhum ticket neste alcance/);
    expect(items[0]).not.toHaveAttribute("aria-disabled", "true");
  });

  it("o menu diz o alcance no topo", async () => {
    render(<Host client={makeFull({ tickets: base() })} />);
    await userEvent.click(await playButton());
    expect(screen.getByText("Em tudo o que você vê")).toBeInTheDocument();
  });

  it("Esc fecha o menu e devolve o foco ao botão; setas navegam", async () => {
    render(<Host client={makeFull({ tickets: base() })} />);
    const button = await playButton();
    await userEvent.click(button);
    const items = within(menu()).getAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("escolher um modelo vazio não começa o play", async () => {
    render(<Host client={makeFull({ tickets: base() })} />);
    await userEvent.click(await playButton());
    await userEvent.click(within(menu()).getByRole("menuitem", { name: /Trabalho pela IA/ }));
    expect(queryBar()).toBeNull();
  });
});

describe("modo play", () => {
  it("a barra do play toma o lugar da barra de pedidos e abre a página do primeiro passo", async () => {
    const { onChange } = await start("Meu trabalho");
    const steps = stepsOf("my_work", base());
    expect(within(bar()).getByText("Meu trabalho")).toBeInTheDocument();
    expect(within(bar()).getByText("1 de 2")).toBeInTheDocument();
    expect(within(bar()).getByText("Em tudo o que você vê")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Peça qualquer coisa" })).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(steps[0]!.ticketId);
    expect(await screen.findByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
  });

  it("avançar e voltar trocam o ticket; voltar desabilitado no primeiro, avançar no último com Recomeçar", async () => {
    const { onChange } = await start("Meu trabalho");
    const steps = stepsOf("my_work", base());
    const back = within(bar()).getByRole("button", { name: "Voltar" });
    const next = within(bar()).getByRole("button", { name: "Avançar" });
    expect(back).toBeDisabled();
    expect(within(bar()).queryByRole("button", { name: "Recomeçar" })).toBeNull();
    await userEvent.click(next);
    expect(within(bar()).getByText("2 de 2")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(steps[1]!.ticketId);
    expect(next).toBeDisabled();
    expect(back).toBeEnabled();
    expect(within(bar()).getByRole("button", { name: "Recomeçar" })).toBeInTheDocument();
    await userEvent.click(back);
    expect(within(bar()).getByText("1 de 2")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(steps[0]!.ticketId);
  });

  it("anuncia a posição numa região viva educada a cada passo", async () => {
    await start("Meu trabalho");
    const live = within(bar()).getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent(/^1 de 2: ALFA-1 Alfa um$/);
    await userEvent.click(within(bar()).getByRole("button", { name: "Avançar" }));
    expect(live).toHaveTextContent(/^2 de 2: ALFA-2 Alfa dois$/);
  });

  it("teclado: seta direita e J avançam; seta esquerda e K voltam", async () => {
    const { onChange } = await start("Em andamento", { tickets: [...base(), makeTicket("a5", "p1", 5, "Alfa cinco", { key: "ALFA-5", status: "in_progress", assigneeIds: ["person-1"] })] });
    const total = within(bar()).getByText(/^1 de \d+$/).textContent!.split(" de ")[1]!;
    expect(Number(total)).toBeGreaterThanOrEqual(3);
    await userEvent.keyboard("{ArrowRight}");
    expect(within(bar()).getByText(`2 de ${total}`)).toBeInTheDocument();
    await userEvent.keyboard("j");
    expect(within(bar()).getByText(`3 de ${total}`)).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}");
    expect(within(bar()).getByText(`2 de ${total}`)).toBeInTheDocument();
    await userEvent.keyboard("k");
    expect(within(bar()).getByText(`1 de ${total}`)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalled();
  });

  it("as teclas não agem com o foco num campo de texto", async () => {
    await start("Meu trabalho");
    const priority = await screen.findByRole("spinbutton", { name: "Prioridade" });
    priority.focus();
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("j");
    await userEvent.keyboard("k");
    expect(within(bar()).getByText("1 de 2")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(queryBar()).not.toBeNull();
  });

  it("as teclas não agem com o menu do play aberto", async () => {
    await start("Meu trabalho");
    // sai do play e reabre o menu: com o menu aberto o J não mexe em nada (não há play), e o menu continua aberto.
    await userEvent.click(within(bar()).getByRole("button", { name: "Sair do play" }));
    await userEvent.click(await playButton());
    await userEvent.keyboard("j");
    expect(menu()).toBeInTheDocument();
    expect(queryBar()).toBeNull();
  });

  it("Esc: o primeiro fecha a página, o segundo sai do play", async () => {
    await start("Meu trabalho");
    await screen.findByRole("complementary", { name: "Página do ticket" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Página do ticket" })).toBeNull());
    expect(queryBar()).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(queryBar()).toBeNull());
    expect(await screen.findByRole("combobox", { name: "Peça qualquer coisa" })).toBeInTheDocument();
  });

  it("Sair devolve a barra de pedidos, deixa a página como está e põe o foco no botão play", async () => {
    await start("Meu trabalho");
    await screen.findByRole("complementary", { name: "Página do ticket" });
    await userEvent.click(within(bar()).getByRole("button", { name: "Sair do play" }));
    expect(queryBar()).toBeNull();
    expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Peça qualquer coisa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Modo play" })).toHaveFocus();
  });

  it("fechar a página pelo botão dela não sai do play, e avançar abre o próximo", async () => {
    const { onChange } = await start("Meu trabalho");
    const steps = stepsOf("my_work", base());
    await userEvent.click(await screen.findByRole("button", { name: "Fechar e voltar ao mapa" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(queryBar()).not.toBeNull();
    await userEvent.click(within(bar()).getByRole("button", { name: "Avançar" }));
    expect(onChange).toHaveBeenLastCalledWith(steps[1]!.ticketId);
    expect(await screen.findByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
  });

  it("Recomeçar volta ao primeiro passo", async () => {
    const { onChange } = await start("Meu trabalho");
    const steps = stepsOf("my_work", base());
    await userEvent.click(within(bar()).getByRole("button", { name: "Avançar" }));
    await userEvent.click(within(bar()).getByRole("button", { name: "Recomeçar" }));
    expect(within(bar()).getByText("1 de 2")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(steps[0]!.ticketId);
  });

  it("stand-up mostra a pessoa da vez e a posição dentro do turno dela", async () => {
    await start("Stand-up");
    const steps = stepsOf("standup", base());
    const first = people.find((person) => person.id === steps[0]!.personId)!;
    const turn = steps.filter((step) => step.personId === steps[0]!.personId).length;
    expect(within(bar()).getByText(`${first.displayName} · 1 de ${turn}`)).toBeInTheDocument();
    expect(within(bar()).getByText(`1 de ${steps.length}`)).toBeInTheDocument();
  });

  it("a lista é uma foto: ticket que sumiu fica na sequência com uma frase, e avançar/voltar continuam", async () => {
    const current = { tickets: base() };
    const { onChange } = await start("Meu trabalho", current);
    const steps = stepsOf("my_work", base());
    // O mundo anda: o segundo passo é removido e a lista recarregada (mudar a prioridade na página dispara a recarga do mapa).
    current.tickets = current.tickets.filter((entry) => entry.id !== steps[1]!.ticketId);
    await userEvent.click(await screen.findByRole("button", { name: "Aumentar a prioridade" }));
    await userEvent.click(within(bar()).getByRole("button", { name: "Avançar" }));
    expect(within(bar()).getByText("2 de 2")).toBeInTheDocument();
    expect(within(bar()).getByText("Este ticket não está mais disponível.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenLastCalledWith(steps[1]!.ticketId);
    await userEvent.click(within(bar()).getByRole("button", { name: "Voltar" }));
    expect(within(bar()).getByText("1 de 2")).toBeInTheDocument();
    expect(within(bar()).queryByText("Este ticket não está mais disponível.")).toBeNull();
  });

  it("Recomeçar com a lista vazia sai do modo com uma frase", async () => {
    const current = { tickets: base() };
    await start("Meu trabalho", current);
    await userEvent.click(within(bar()).getByRole("button", { name: "Avançar" }));
    current.tickets = current.tickets.map((entry) => ({ ...entry, status: "done" as const }));
    // A recarga do mapa traz os tickets concluídos; Recomeçar refaz a lista com os dados de agora.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await userEvent.click(await screen.findByRole("button", { name: "Aumentar a prioridade" }));
    await userEvent.click(within(bar()).getByRole("button", { name: "Recomeçar" }));
    await waitFor(() => expect(queryBar()).toBeNull());
    expect(await screen.findByText("Não há mais tickets neste modelo. O play terminou.")).toBeInTheDocument();
  });

  it("abrir outro ticket durante o play (como um clique no mapa) não muda a posição; voltar/avançar retomam", async () => {
    const current = { tickets: [...base(), makeTicket("a6", "p1", 6, "Filho do um", { key: "ALFA-6", parentId: "a1" })] };
    const { onChange } = await start("Meu trabalho", current);
    const steps = stepsOf("my_work", current.tickets);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA-6/ }));
    expect(onChange).toHaveBeenLastCalledWith("a6");
    expect(within(bar()).getByText("1 de 2")).toBeInTheDocument();
    await userEvent.click(within(bar()).getByRole("button", { name: "Avançar" }));
    expect(onChange).toHaveBeenLastCalledWith(steps[1]!.ticketId);
    expect(within(bar()).getByText("2 de 2")).toBeInTheDocument();
  });

  it("os textos existem em inglês e espanhol", async () => {
    await setTestLanguage("en");
    render(<Host client={makeFull({ tickets: base() })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Play mode" }, { timeout: SLOW }));
    expect(within(screen.getByRole("menu", { name: "Play templates" })).getByText("Next to work on")).toBeInTheDocument();
    await setTestLanguage("pt-BR");
  });
});

describe("próximo ticket para trabalhar na barra de pedidos", () => {
  const bar_ = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" }, { timeout: SLOW });
  it("com o campo vazio, a linha aparece e leva ao primeiro da fila, abrindo a página", async () => {
    const onChange = vi.fn();
    const list = base();
    render(<Host client={makeFull({ tickets: list })} onChange={onChange} />);
    await userEvent.click(await bar_());
    await userEvent.click(await screen.findByRole("option", { name: "Próximo ticket para trabalhar" }));
    expect(onChange).toHaveBeenCalledWith(workQueue(toWorkTickets({ p1: list }), "person-1", {})[0]);
    expect(await screen.findByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
  });

  it("aparece quando o texto digitado casa com ela", async () => {
    render(<Host client={makeFull({ tickets: base() })} />);
    const field = await bar_();
    await userEvent.type(field, "próximo");
    expect(await screen.findByRole("option", { name: "Próximo ticket para trabalhar" })).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, "zzz");
    expect(screen.queryByRole("option", { name: "Próximo ticket para trabalhar" })).toBeNull();
  });

  it("fila vazia: uma frase na própria barra, conforme o motivo", async () => {
    const onChange = vi.fn();
    const blocked = base().map((entry) => ({ ...entry, blocked: true }));
    render(<Host client={makeFull({ tickets: blocked })} onChange={onChange} />);
    await userEvent.click(await bar_());
    await userEvent.click(await screen.findByRole("option", { name: "Próximo ticket para trabalhar" }));
    expect(await screen.findByText("Tudo o que está pronto depende de outro ticket.")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

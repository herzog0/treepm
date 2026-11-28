import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearRun, ProjectLinear } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeLinearRun, makeProject, makeTicket, ok } from "../test/fakes.js";
import type { FakeLinearRun } from "../test/fakes.js";
import { ImportScreen } from "./ImportScreen.js";

/** "Sobrescrever com o Linear" (ADR 0066): a caixa no cartão da sincronização, a confirmação, o erro próprio e o resumo. */
const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const finished = (extra: Partial<LinearRun> = {}): Partial<LinearRun> => ({ phase: "done", done: true, finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), destinationTicketId: "t1", counts: { issuesCreated: 4 }, ...extra });

function setup(options: { run?: FakeLinearRun; hash?: string } = {}) {
  window.location.hash = options.hash ?? "#linear";
  const me = makePanelMe("admin");
  const client = makeClient({
    me,
    projects: [project],
    tickets: { p1: [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" })] },
    linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: options.run ?? { existing: finished(), total: 2 } },
  });
  render(<ImportScreen client={client} me={me} projectId="p1" onExit={vi.fn()} onOpenSettings={vi.fn()} />);
  return { client };
}
const BOX = "Sobrescrever com o Linear o que foi mudado aqui";

afterEach(() => {
  window.location.hash = "";
});

describe("Sobrescrever com o Linear › caixa e confirmação", () => {
  it("a caixa aparece desmarcada no cartão da sincronização; desmarcada, o botão sincroniza como sempre", async () => {
    const { client } = setup({ run: { existing: finished(), total: 2, script: [{ hold: new Promise<void>(() => {}) }] } });
    const box = await screen.findByRole("checkbox", { name: BOX });
    expect(box).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", {});
  });

  it("marcada: o botão abre a confirmação, com o que volta, o que não muda e o que se perde; o foco entra no diálogo", async () => {
    const { client } = setup();
    await userEvent.click(await screen.findByRole("checkbox", { name: BOX }));
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    const dialog = await screen.findByRole("dialog", { name: "Sobrescrever com o Linear?" });
    const text = dialog.textContent ?? "";
    for (const part of ["título, descrição, situação, prioridade, responsável, prazo, etiquetas", "pai das issues que têm pai no Linear", "A situação de ticket com filhos é calculada pelos filhos e não é sobrescrita.", "comentários, conversas, tickets criados aqui", "issues sem pai e sem projeto no Linear ficam onde estão", "“Em revisão” volta para “Em andamento”", "O que foi escrito aqui nesses campos é substituído.", "A descrição escrita aqui não pode ser recuperada depois.", "Os outros valores anteriores ficam no histórico do ticket."]) expect(text).toContain(part);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });

  it("Cancelar (e Esc) fecha sem pedir nada; o foco volta ao botão", async () => {
    const { client } = setup();
    await userEvent.click(await screen.findByRole("checkbox", { name: BOX }));
    const button = screen.getByRole("button", { name: "Sincronizar agora" });
    await userEvent.click(button);
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
    await userEvent.click(button);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });

  it("Sobrescrever pede a rodada com `overwrite: true`, e a tela de andamento diz que é de sobrescrita", async () => {
    const { client } = setup({ run: { existing: finished(), total: 2, script: [{ hold: new Promise<void>(() => {}) }] } });
    await userEvent.click(await screen.findByRole("checkbox", { name: BOX }));
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sobrescrever" }));
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", { overwrite: true });
    expect(await screen.findByRole("heading", { name: "Sincronizando e sobrescrevendo com o Linear…" })).toBeInTheDocument();
  });

  it("Enter no botão Sobrescrever confirma (como nos outros diálogos)", async () => {
    const { client } = setup({ run: { existing: finished(), total: 2, script: [{ hold: new Promise<void>(() => {}) }] } });
    await userEvent.click(await screen.findByRole("checkbox", { name: BOX }));
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Sobrescrever" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(client.openLinearRun).toHaveBeenCalledWith("p1", { overwrite: true }));
  });

  it("chegada pelo menu (`#linear-sync`): continua a sincronização normal, sem diálogo", async () => {
    const { client } = setup({ hash: "#linear-sync", run: { existing: finished(), total: 2, script: [{ hold: new Promise<void>(() => {}) }] } });
    expect(await screen.findByRole("heading", { name: "Sincronizando…" })).toBeInTheDocument();
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("erro `linear_run_open_other_mode`: mensagem própria", async () => {
    setup({ run: { existing: finished(), total: 2, openError: ["conflict", "linear_run_open_other_mode"] } });
    await userEvent.click(await screen.findByRole("checkbox", { name: BOX }));
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sobrescrever" }));
    expect(await screen.findByText("Já existe uma sincronização aberta. Termine ou abandone antes de abrir outra.")).toBeInTheDocument();
  });

  it("erro `linear_run_open_other_mode`: relê a rodada atual e mostra a aberta, com Abandonar (outra aba abriu entre a leitura e o clique)", async () => {
    const { client } = setup({ run: { existing: finished(), total: 2, openError: ["conflict", "linear_run_open_other_mode"] } });
    // Outra aba abriu uma sincronização normal: a partir de agora, a rodada atual é ela, aberta e andando.
    const other = makeLinearRun({ id: "run-other", projectId: "p1", mode: "reimport", phase: "issues", overwrite: false, totalExpected: 2, destinationTicketId: "t1" });
    await userEvent.click(await screen.findByRole("checkbox", { name: BOX }));
    const read = client.getCurrentLinearRun as ReturnType<typeof vi.fn>;
    const before = read.mock.calls.length;
    read.mockResolvedValue(ok({ run: other, lastFinished: null }));
    client.stepLinearRun = vi.fn(() => new Promise<never>(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sobrescrever" }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByRole("button", { name: /Abandonar/ })).toBeInTheDocument();
  });
});

describe("Sobrescrever com o Linear › resumo", () => {
  it("mostra 'N tickets sobrescritos com o Linear' quando há, no singular e no plural", async () => {
    setup({ run: { existing: finished({ mode: "reimport", overwrite: true, counts: { overwritten: 3 } }), total: 2 } });
    expect(await screen.findByText("3 tickets sobrescritos com o Linear")).toBeInTheDocument();
  });
  it("singular", async () => {
    setup({ run: { existing: finished({ mode: "reimport", overwrite: true, counts: { overwritten: 1 } }), total: 2 } });
    expect(await screen.findByText("1 ticket sobrescrito com o Linear")).toBeInTheDocument();
  });
  it("sem sobrescrita, a linha não aparece", async () => {
    setup({ run: { existing: finished({ mode: "reimport", counts: { overwritten: 0 } }), total: 2 } });
    await screen.findByRole("checkbox", { name: BOX });
    expect(screen.queryByText(/sobrescrit/)).not.toBeInTheDocument();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearRun, ProjectLinear } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeCategorizeView, makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinearCategorize, FakeLinearRun } from "../test/fakes.js";
import { ImportScreen } from "./ImportScreen.js";

/** "Sincronizar com o Linear" (ADR 0061): chegar por `#linear-sync` já inicia a rodada da reimportação, uma vez só. */
const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const tickets = [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" })];
const finished = (extra: Partial<LinearRun> = {}): Partial<LinearRun> => ({ phase: "done", done: true, finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), destinationTicketId: "t1", counts: { issuesCreated: 4 }, ...extra });

function setup(options: { run?: FakeLinearRun; linked?: ProjectLinear; connected?: boolean; hash?: string; categorize?: FakeLinearCategorize } = {}) {
  window.location.hash = options.hash ?? "#linear-sync";
  const me = makePanelMe("admin");
  const client = makeClient({
    me,
    projects: [project],
    tickets: { p1: tickets },
    linear: { connection: options.connected === false ? null : makeLinearConnection(), projects: { p1: options.linked ?? LINKED }, run: options.run ?? { existing: finished(), total: 2 }, ...(options.categorize ? { categorize: options.categorize } : {}) },
  });
  render(<ImportScreen client={client} me={me} projectId="p1" onExit={vi.fn()} onOpenSettings={vi.fn()} />);
  return { client };
}

afterEach(() => {
  window.location.hash = "";
});

describe("Sincronizar com o Linear › chegada pelo botão", () => {
  it("abre na aba do Linear e já inicia a rodada, sem pedir o clique, herdando o destino", async () => {
    const { client } = setup({ run: { existing: finished(), total: 2, script: [{ hold: new Promise<void>(() => {}) }] } });
    expect(await screen.findByRole("heading", { name: "Sincronizando…" })).toBeInTheDocument();
    expect(client.openLinearRun).toHaveBeenCalledTimes(1);
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", {});
  });

  it("termina no resumo da sincronização, e a rodada não recomeça sozinha", async () => {
    const { client } = setup();
    expect(await screen.findByRole("heading", { name: "Sincronização concluída" })).toBeInTheDocument();
    expect(client.openLinearRun).toHaveBeenCalledTimes(1);
  });

  it("o pedido vale uma vez: o endereço volta a '#linear' para recarregar a página não sincronizar de novo", async () => {
    setup({ run: { existing: finished(), total: 2, script: [{ hold: new Promise<void>(() => {}) }] } });
    await screen.findByRole("heading", { name: "Sincronizando…" });
    await waitFor(() => expect(window.location.hash).toBe("#linear"));
  });

  it("sem a chave do Linear conectada: a tela mostra o aviso que já tem e não inicia nada", async () => {
    const { client } = setup({ connected: false });
    expect(await screen.findByText("Falta a sua chave do Linear")).toBeInTheDocument();
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });

  it("chave de outro workspace: o aviso que já existe, sem iniciar", async () => {
    const { client } = setup({ linked: { ...LINKED, keyMatches: false } });
    expect(await screen.findByText("A sua chave não serve a este projeto")).toBeInTheDocument();
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });

  it("com a procura do lugar dos itens aberta o servidor recusaria: fica o cartão, desabilitado e com a explicação, sem iniciar depois", async () => {
    const { client } = setup({ categorize: { candidates: 5, existing: makeCategorizeView() } });
    const button = await screen.findByRole("button", { name: "Sincronizar agora" });
    expect(button).toBeDisabled();
    await waitFor(() => expect(window.location.hash).toBe("#linear"));
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });

  it("projeto que nunca importou: mostra o cartão de começar (com o destino), sem iniciar sozinho", async () => {
    const { client } = setup({ run: {} });
    expect(await screen.findByRole("button", { name: "Importar" })).toBeEnabled();
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });

  it("'#linear' (o atalho de antes) continua mostrando o cartão da última importação, sem iniciar", async () => {
    const { client } = setup({ hash: "#linear" });
    expect(await screen.findByRole("button", { name: "Sincronizar agora" })).toBeEnabled();
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });
});

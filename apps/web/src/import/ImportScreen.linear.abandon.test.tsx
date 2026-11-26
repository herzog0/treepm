import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectLinear } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinear, FakeLinearRun } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const tickets = [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" })];

function setup(run: FakeLinearRun) {
  window.location.hash = "#linear";
  const me = makePanelMe("admin");
  const linear: FakeLinear = { connection: makeLinearConnection(), projects: { p1: LINKED }, run };
  const client = makeClient({ me, projects: [project], tickets: { p1: tickets }, linear });
  const onExit = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(<ImportScreen client={client} me={me} projectId="p1" onExit={onExit} onOpenSettings={onOpenSettings} />);
  return { client, onExit, onOpenSettings, ...view };
}
const held = () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  return { hold, release };
};
afterEach(() => {
  window.location.hash = "";
});

describe("Importação do Linear › fase 'Ligando menções'", () => {
  it("é a quarta fase, depois de ligar sub-issues aos pais", async () => {
    const { hold, release } = held();
    setup({ existing: { phase: "mentions", counts: { projectsSeen: 3, issuesSeen: 12 } }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "doing", "todo", "todo", "todo"]);
    expect(items[2]).toHaveTextContent("Ligar sub-issues aos pais");
    expect(items[3]).toHaveTextContent("Ligando menções");
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });
});

describe("Importação do Linear › fase 'Trazendo comentários' (TREEPM-477)", () => {
  it("na primeira importação é a quinta fase, depois das menções, e o anúncio diz o que acontece", async () => {
    const { hold, release } = held();
    setup({ existing: { phase: "comments", counts: { projectsSeen: 3, issuesSeen: 12, commentsCreated: 50 } }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "doing", "todo", "todo"]);
    expect(items[3]).toHaveTextContent("Ligando menções");
    expect(items[4]).toHaveTextContent("Trazendo comentários");
    expect(await screen.findByText("Trazendo os comentários das issues.")).toBeInTheDocument();
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });
  it("na sincronização fica entre as menções e as relações", async () => {
    const { hold, release } = held();
    setup({ existing: { mode: "reimport", phase: "comments" }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "done", "doing", "todo", "todo", "todo"]);
    expect(items[5]).toHaveTextContent("Trazendo comentários");
    expect(items[6]).toHaveTextContent("Ligando relações");
    release();
  });
});

describe("Importação do Linear › fase 'Ligando relações' (TREEPM-478)", () => {
  it("na primeira importação vem depois dos comentários e antes do histórico, e o anúncio diz o que acontece", async () => {
    const { hold, release } = held();
    setup({ existing: { phase: "relations", counts: { projectsSeen: 3, issuesSeen: 12, relationsCreated: 4 } }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "done", "doing", "todo"]);
    expect(items[5]).toHaveTextContent("Ligando relações");
    expect(await screen.findByText("Ligando as relações entre os tickets.")).toBeInTheDocument();
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });
  it("na sincronização fica entre os comentários e o histórico", async () => {
    const { hold, release } = held();
    setup({ existing: { mode: "reimport", phase: "relations" }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "done", "done", "doing", "todo", "todo"]);
    expect(items[6]).toHaveTextContent("Ligando relações");
    expect(items[7]).toHaveTextContent("Trazendo o histórico");
    release();
  });
});

describe("Importação do Linear › fase 'Trazendo o histórico' (ADR 0061, fatia 4; TREEPM-482)", () => {
  it("na primeira importação é a última fase, depois das relações, e o anúncio diz o que acontece", async () => {
    const { hold, release } = held();
    setup({ existing: { phase: "history", counts: { projectsSeen: 3, issuesSeen: 12, historyCreated: 40 } }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "done", "done", "doing"]);
    expect(items[5]).toHaveTextContent("Ligando relações");
    expect(items[6]).toHaveTextContent("Trazendo o histórico");
    expect(await screen.findByText("Trazendo o histórico das issues.")).toBeInTheDocument();
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });
  it("na sincronização fica entre as relações e a conferência do que sumiu", async () => {
    const { hold, release } = held();
    setup({ existing: { mode: "reimport", phase: "history" }, script: [{ hold }] });
    const items = within(await screen.findByRole("list", { name: "Fases da importação" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "done", "done", "done", "done", "done", "doing", "todo"]);
    expect(items[7]).toHaveTextContent("Trazendo o histórico");
    expect(items[8]).toHaveTextContent("Verificando o que sumiu do Linear");
    release();
  });
});

describe("Importação do Linear › abandonar", () => {
  it("durante a rodada há um botão discreto; a confirmação é na própria tela e explica o que fica", async () => {
    const { hold, release } = held();
    const { client } = setup({ existing: { phase: "issues" }, script: [{ hold }] });
    const button = await screen.findByRole("button", { name: "Abandonar importação" });
    expect(button).not.toHaveClass("primary");
    expect(button).not.toHaveClass("is-prominent");
    await userEvent.click(button);
    const confirm = screen.getByRole("group", { name: "Confirmar abandono" });
    expect(confirm).toHaveTextContent(/o que já foi importado fica/i);
    expect(confirm).toHaveTextContent("começar outra");
    expect(client.abandonLinearRun).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole("button", { name: "Voltar" }));
    expect(screen.queryByRole("group", { name: "Confirmar abandono" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abandonar importação" })).toHaveFocus();
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });

  it("confirmar abandona, volta ao cartão de importar com 'Importação anterior abandonada: N criados' e para o laço", async () => {
    const { hold } = held();
    const { client } = setup({ existing: { phase: "issues", counts: { projectsCreated: 3, issuesCreated: 5 } }, script: [{ hold }] });
    await userEvent.click(await screen.findByRole("button", { name: "Abandonar importação" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Confirmar abandono" })).getByRole("button", { name: "Abandonar" }));
    expect(await screen.findByText("Importação anterior abandonada: 8 criados")).toBeInTheDocument();
    expect(client.abandonLinearRun).toHaveBeenCalledWith("p1", "run-1");
    expect(screen.getByRole("button", { name: "Importar" })).toBeEnabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abandonar importação" })).not.toBeInTheDocument();
  });

  it("depois de abandonar dá para abrir outra importação", async () => {
    const { hold } = held();
    const { client } = setup({ existing: { phase: "issues" }, script: [{ hold }] });
    await userEvent.click(await screen.findByRole("button", { name: "Abandonar importação" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Confirmar abandono" })).getByRole("button", { name: "Abandonar" }));
    await userEvent.click(await screen.findByRole("button", { name: "Importar" }));
    expect(client.openLinearRun).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "Importação concluída" })).toBeInTheDocument();
  });

  it("singular: 'Importação anterior abandonada: 1 criado'", async () => {
    setup({ existing: { phase: "failed", done: true, counts: { issuesCreated: 1 } } });
    expect(await screen.findByText("Importação anterior abandonada: 1 criado")).toBeInTheDocument();
  });

  it("nada criado: 0 criados", async () => {
    setup({ existing: { phase: "failed", done: true, counts: {} } });
    expect(await screen.findByText("Importação anterior abandonada: 0 criados")).toBeInTheDocument();
  });

  it("rodada 'failed' vinda de runs/current: mesma tela, sem tentar dar passo", async () => {
    const { client } = setup({ existing: { phase: "failed", done: true, counts: { projectsCreated: 2, issuesCreated: 40 } } });
    expect(await screen.findByText("Importação anterior abandonada: 42 criados")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Importar" })).toBeEnabled();
    expect(client.stepLinearRun).not.toHaveBeenCalled();
  });

  it("três falhas seguidas: o botão fica em destaque", async () => {
    const { hold, release } = held();
    setup({ existing: { phase: "issues", errorStreak: 3 }, script: [{ hold }] });
    expect(await screen.findByRole("button", { name: "Abandonar importação" })).toHaveClass("is-prominent");
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });

  it("duas falhas seguidas ainda não destacam", async () => {
    const { hold, release } = held();
    setup({ existing: { phase: "issues", errorStreak: 2 }, script: [{ hold }] });
    expect(await screen.findByRole("button", { name: "Abandonar importação" })).not.toHaveClass("is-prominent");
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });

  it("destino inválido: diz que o destino não serve, destaca 'Abandonar' e não oferece 'Continuar'", async () => {
    setup({ existing: { phase: "issues" }, script: [{ error: ["conflict", "linear_destination_invalid"] }] });
    expect(await screen.findByRole("alert")).toHaveTextContent("O destino não serve mais: abandone e comece outra escolhendo outro destino");
    expect(screen.getByRole("button", { name: "Abandonar importação" })).toHaveClass("is-prominent");
    expect(screen.queryByRole("button", { name: "Continuar" })).not.toBeInTheDocument();
  });

  it("passo que falhou (step_failed) tem frase própria e deixa continuar ou abandonar", async () => {
    setup({ existing: { phase: "issues" }, script: [{ error: ["unavailable", "step_failed"] }] });
    expect(await screen.findByRole("alert")).toHaveTextContent("A importação falhou num passo");
    expect(screen.getByRole("button", { name: "Continuar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abandonar importação" })).toBeInTheDocument();
  });

  it("passo lento demais (step_too_slow, errorStreak 3): frase própria e 'Abandonar' em destaque", async () => {
    setup({ existing: { phase: "issues", errorStreak: 3 }, script: [{ error: ["unavailable", "step_too_slow"] }] });
    expect(await screen.findByRole("alert")).toHaveTextContent("O passo está demorando demais mesmo no menor tamanho. Abandone esta importação e abra outra.");
    expect(screen.getByRole("button", { name: "Abandonar importação" })).toHaveClass("is-prominent");
  });

  it("se a rodada já tinha terminado (linear_run_finished), mostra a frase e relê", async () => {
    const { hold } = held();
    const { client } = setup({ existing: { phase: "issues" }, script: [{ hold }] });
    vi.mocked(client.abandonLinearRun).mockResolvedValueOnce({ ok: false, error: { kind: "conflict", code: "linear_run_finished" } });
    await userEvent.click(await screen.findByRole("button", { name: "Abandonar importação" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Confirmar abandono" })).getByRole("button", { name: "Abandonar" }));
    expect(await screen.findByText("Esta importação já terminou e não pode ser abandonada.")).toBeInTheDocument();
  });
});

describe("Importação do Linear › resumo, linhas novas", () => {
  const done = (counts: Record<string, number | boolean>) => ({ existing: { phase: "done" as const, done: true, counts } });

  it("mostra as três linhas novas só quando maiores que zero", async () => {
    setup(done({ issuesCreated: 10, skippedInvalid: 2, withoutDescription: 1, movedOutOfIdea: 4 }));
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).getByText("Ignorados por formato inválido").nextSibling).toHaveTextContent("2");
    expect(within(list).getByText("Sem descrição (grande demais)").nextSibling).toHaveTextContent("1");
    expect(within(list).getByText("Tirados de dentro de ideia").nextSibling).toHaveTextContent("4");
  });

  it("com zero, as linhas novas somem", async () => {
    setup(done({ issuesCreated: 10, skippedInvalid: 0, withoutDescription: 0, movedOutOfIdea: 0 }));
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).queryByText("Ignorados por formato inválido")).not.toBeInTheDocument();
    expect(within(list).queryByText("Sem descrição (grande demais)")).not.toBeInTheDocument();
    expect(within(list).queryByText("Tirados de dentro de ideia")).not.toBeInTheDocument();
  });

  it("avisa quando o Linear não deixou ler os e-mails dos responsáveis", async () => {
    setup(done({ issuesCreated: 10, assigneeEmailUnavailable: true }));
    expect(await screen.findByText("O Linear não deixou ler os e-mails dos responsáveis; ninguém foi atribuído.")).toBeInTheDocument();
  });

  it("sem o aviso quando o e-mail estava disponível", async () => {
    setup(done({ issuesCreated: 10 }));
    await screen.findByRole("heading", { name: "Última importação" });
    expect(screen.queryByText(/e-mails dos responsáveis/)).not.toBeInTheDocument();
  });
});

describe("Importação do Linear › abandonar, idiomas", () => {
  it.each([
    ["en", "From Linear", "Abandon import"],
    ["es-MX", "Desde Linear", "Abandonar importación"],
  ] as const)("em %s", async (language, tab, button) => {
    await setTestLanguage(language);
    const { hold, release } = held();
    setup({ existing: { phase: "mentions" }, script: [{ hold }] });
    void tab;
    expect(await screen.findByRole("button", { name: button })).toBeInTheDocument();
    release();
    await setTestLanguage("pt-BR");
  });
});

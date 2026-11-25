import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearRun, ProjectLinear } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinearRun } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const tickets = [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" }), makeTicket("t2", "p1", 2, "Fase dois", { key: "ENG-2" })];
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function finished(extra: Partial<LinearRun> = {}): Partial<LinearRun> {
  return { phase: "done", done: true, finishedAt: ago(3 * DAY), destinationTicketId: "t1", counts: { projectsCreated: 6, issuesCreated: 406 }, ...extra };
}
function setup(run: FakeLinearRun = {}, options: { preview?: number | null } = {}) {
  window.location.hash = "#linear";
  const me = makePanelMe("admin");
  const client = makeClient({
    me,
    projects: [project],
    tickets: { p1: tickets },
    linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, ...(options.preview !== undefined ? { preview: options.preview } : {}), run },
  });
  const onExit = vi.fn();
  const view = render(<ImportScreen client={client} me={me} projectId="p1" onExit={onExit} onOpenSettings={vi.fn()} />);
  return { client, onExit, ...view };
}

afterEach(() => {
  window.location.hash = "";
});

describe("Reimportação › o cartão da última importação", () => {
  it("em vez do aviso de indisponível, mostra 'Última importação · há 3 dias', as contagens e 'Sincronizar agora'", async () => {
    setup({ existing: finished() });
    expect(await screen.findByRole("heading", { name: "Última importação · há 3 dias" })).toBeInTheDocument();
    expect(screen.queryByText("Reimportar ainda não está disponível.")).not.toBeInTheDocument();
    const list = screen.getByLabelText("Contagens da importação");
    expect(within(list).getByText("Criados").nextSibling).toHaveTextContent("412");
    expect(screen.getByRole("button", { name: "Sincronizar agora" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
  });

  it("explica a regra em uma frase curta", async () => {
    setup({ existing: finished() });
    const rule = await screen.findByText(/só atualiza o que mudou no Linear e ninguém mexeu aqui/);
    expect(rule).toHaveTextContent(/não move o que foi arrumado/);
    expect(rule).toHaveTextContent(/o que sumiu do Linear fica como está/);
  });

  it("a data da última rodada de reimportação vem das contagens dela (Novos, Atualizados…)", async () => {
    setup({ existing: finished({ mode: "reimport", counts: { issuesCreated: 9, projectsCreated: 0, updated: 23, keptTouched: 5, missing: 2 } }) });
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).getByText("Novos").nextSibling).toHaveTextContent("9");
    expect(within(list).getByText("Atualizados").nextSibling).toHaveTextContent("23");
    expect(within(list).getByText("Mantidos porque foram mexidos aqui").nextSibling).toHaveTextContent("5");
    expect(within(list).getByText("Não encontrados no Linear").nextSibling).toHaveTextContent("2");
  });

  it("reimporta sem perguntar o destino (o corpo vai sem destinationTicketId) e mostra 'Sincronizando…'", async () => {
    const { client } = setup({ existing: finished(), total: 4, script: [{ hold: new Promise<void>(() => {}) }] });
    expect(screen.queryByText("Destino")).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", {});
    expect(await screen.findByRole("heading", { name: "Sincronizando…" })).toBeInTheDocument();
  });

  it("'Mudar destino das issues novas' abre o mesmo seletor, e a escolha vai no corpo", async () => {
    const { client } = setup({ existing: finished() });
    await userEvent.click(await screen.findByRole("button", { name: "Mudar destino das issues novas" }));
    const picker = await screen.findByRole("group", { name: "Escolher o destino" });
    await userEvent.click(await within(picker).findByRole("button", { name: /ENG-2/ }));
    expect(screen.getByText("Fase dois")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", { destinationTicketId: "t2" });
  });

  it("escolher a raiz no seletor manda destinationTicketId nulo", async () => {
    const { client } = setup({ existing: finished() });
    await userEvent.click(await screen.findByRole("button", { name: "Mudar destino das issues novas" }));
    const picker = await screen.findByRole("group", { name: "Escolher o destino" });
    await userEvent.click(await within(picker).findByRole("button", { name: "Raiz do projeto" }));
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar agora" }));
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", { destinationTicketId: null });
  });

  it("'Abrir no mapa' segue no cartão", async () => {
    const { onExit } = setup({ existing: finished() });
    await userEvent.click(await screen.findByRole("button", { name: "Abrir no mapa" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("abandonar a reimportação devolve o cartão da última concluída, que não muda", async () => {
    setup({ existing: finished(), script: [{ hold: new Promise<void>(() => {}) }] });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await userEvent.click(await screen.findByRole("button", { name: "Abandonar importação" }));
    await userEvent.click(await screen.findByRole("button", { name: "Abandonar" }));
    expect(await screen.findByRole("heading", { name: "Última importação · há 3 dias" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sincronizar agora" })).toBeEnabled();
  });

  it("erro ao abrir mostra a frase e deixa tentar de novo", async () => {
    setup({ existing: finished(), openError: ["conflict", "linear_destination_invalid"] });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sincronizar agora" })).toBeEnabled();
  });
});

describe("Reimportação › data relativa (relógio falso)", () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    ["2026-11-25T11:59:30.000Z", "Última importação · agora"],
    ["2026-11-25T09:00:00.000Z", "Última importação · há 3 horas"],
    ["2026-11-24T09:00:00.000Z", "Última importação · ontem"],
    ["2026-11-10T09:00:00.000Z", "Última importação · 10 de nov."],
  ])("%s → %s", async (finishedAt, title) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
    setup({ existing: finished({ finishedAt }) });
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  });
  it("sem data da conclusão, o título não deixa o ponto solto", async () => {
    setup({ existing: finished({ finishedAt: null }) });
    expect(await screen.findByRole("heading", { name: "Última importação" })).toBeInTheDocument();
  });
});

describe("Reimportação › durante e resumo", () => {
  it("anda pelas fases, com 'Verificando o que sumiu do Linear' no fim, e termina no resumo da reimportação", async () => {
    const { client } = setup({ existing: finished(), total: 4, reimportCounts: { updated: 3, keptTouched: 2, keptMoved: 1, missing: 4, missingProjects: 1, elsewhere: 1 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    expect(await screen.findByRole("heading", { name: "Sincronização concluída" })).toBeInTheDocument();
    const list = screen.getByLabelText("Contagens da importação");
    // Novos = issuesCreated + projectsCreated da rodada simulada (3 projetos + 4 issues).
    expect(within(list).getByText("Novos").nextSibling).toHaveTextContent("7");
    expect(within(list).getByText("Atualizados").nextSibling).toHaveTextContent("3");
    expect(within(list).getByText("Mantidos porque foram mexidos aqui").nextSibling).toHaveTextContent("2");
    expect(within(list).getByText("Mantidos onde você os moveu").nextSibling).toHaveTextContent("1");
    expect(within(list).getByText("Não encontrados no Linear").nextSibling).toHaveTextContent("5");
    expect(within(list).getByText("Em outro projeto").nextSibling).toHaveTextContent("1");
    expect(screen.queryByRole("button", { name: "Sincronizar agora" })).not.toBeInTheDocument();
    expect(client.stepLinearRun).toHaveBeenCalled();
  });

  it("a lista de fases tem 'Verificando o que sumiu do Linear' só na reimportação", async () => {
    const hold = new Promise<void>(() => {});
    setup({ existing: finished(), script: ["ok", { hold }] });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    const phases = await screen.findByRole("list", { name: "Fases da importação" });
    const items = within(phases).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    expect(within(phases).getByText(/Verificando o que sumiu do Linear/)).toBeInTheDocument();
    // "Atualizando situações" fica entre ligar sub-issues e as menções.
    const names = items.map((item) => item.textContent ?? "");
    const at = (text: RegExp) => names.findIndex((name) => text.test(name));
    expect(at(/Atualizando situações/)).toBe(at(/Ligar sub-issues aos pais/) + 1);
    expect(at(/Ligando menções/)).toBe(at(/Atualizando situações/) + 1);
  });

  it("o anúncio de status diz 'Atualizando as situações.' quando a fase chega", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    // projetos, issues (1 página), hierarquia, e a quarta etapa fica segurada em "statuses".
    setup({ existing: finished(), total: 2, projects: 0, script: ["ok", "ok", "ok", { hold }] });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    const region = (await screen.findAllByRole("status")).find((node) => node.classList.contains("linear-import-status"))!;
    await waitFor(() => expect(region).toHaveTextContent("Atualizando as situações."));
    release();
    await screen.findByRole("heading", { name: "Sincronização concluída" });
  });

  it("a primeira importação não tem essa fase", async () => {
    setup({ existing: { phase: "issues", counts: { issuesSeen: 2 } }, script: [{ hold: new Promise<void>(() => {}) }] });
    const phases = await screen.findByRole("list", { name: "Fases da importação" });
    expect(within(phases).getAllByRole("listitem")).toHaveLength(5);
    expect(within(phases).queryByText(/Verificando o que sumiu do Linear/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Importando…" })).toBeInTheDocument();
  });

  it("só mostra as linhas maiores que zero, além de Novos e Atualizados", async () => {
    setup({ existing: finished(), total: 0, projects: 0, reimportCounts: {} });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).getByText("Novos")).toBeInTheDocument();
    expect(within(list).getByText("Atualizados")).toBeInTheDocument();
    for (const name of ["Mantidos porque foram mexidos aqui", "Mantidos onde você os moveu", "Não encontrados no Linear", "Em outro projeto"]) expect(within(list).queryByText(name)).not.toBeInTheDocument();
  });

  it("os avisos: e-mail, descrições grandes e o que sumiu que não pôde ser conferido", async () => {
    setup({ existing: finished(), reimportCounts: { assigneeEmailUnavailable: true, descriptionUnavailable: true, missingNotChecked: true } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.getByText(/não deixou ler os e-mails dos responsáveis/)).toBeInTheDocument();
    expect(screen.getByText("Algumas descrições eram grandes demais e não foram relidas.")).toBeInTheDocument();
    expect(screen.getByText("Não foi possível conferir o que sumiu, porque alguns itens vieram em formato inválido.")).toBeInTheDocument();
  });

  it("'N campos preenchidos em tickets que já existiam' aparece com o plural certo e some quando é zero", async () => {
    setup({ existing: finished(), reimportCounts: { updated: 1, filled: 12 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.getByText("12 campos preenchidos em tickets que já existiam")).toBeInTheDocument();
  });

  it("comentários trazidos e mantidos porque foram editados aqui (ADR 0061, fatia 2), com plural; zero não aparece", async () => {
    setup({ existing: finished(), reimportCounts: { updated: 1, commentsCreated: 12, commentsKeptEdited: 1 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.getByText("12 comentários trazidos do Linear")).toBeInTheDocument();
    expect(screen.getByText("1 comentário mantido porque foi editado aqui")).toBeInTheDocument();
  });

  it("um comentário trazido: singular; nenhum mantido: a linha some", async () => {
    setup({ existing: finished(), reimportCounts: { updated: 1, commentsCreated: 1, commentsKeptEdited: 0 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.getByText("1 comentário trazido do Linear")).toBeInTheDocument();
    expect(screen.queryByText(/mantido porque foi editado/)).not.toBeInTheDocument();
  });

  it("um só campo preenchido: singular", async () => {
    setup({ existing: finished(), reimportCounts: { filled: 1 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.getByText("1 campo preenchido em tickets que já existiam")).toBeInTheDocument();
  });

  it("sem campos preenchidos (zero ou ausente) a linha não aparece", async () => {
    setup({ existing: finished(), reimportCounts: { updated: 1, filled: 0 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.queryByText(/campos? preenchidos?/)).not.toBeInTheDocument();
  });

  it("sem avisos quando os booleanos não vêm", async () => {
    setup({ existing: finished(), reimportCounts: { updated: 1 } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    expect(screen.queryByText(/grandes demais/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Não foi possível conferir/)).not.toBeInTheDocument();
  });

  it("a linha 'Mantidos onde você os moveu' aparece no cartão de uma primeira importação que a tem", async () => {
    setup({ existing: finished({ counts: { issuesCreated: 4, keptMoved: 2 } }) });
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).getByText("Mantidos onde você os moveu").nextSibling).toHaveTextContent("2");
  });

  it("a região de status anuncia a fase 'missing'", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    setup({ existing: finished(), total: 2, projects: 0, script: ["ok", "ok", "ok", "ok", "ok", "ok", { hold }] });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    const region = (await screen.findAllByRole("status")).find((node) => node.classList.contains("linear-import-status"))!;
    await waitFor(() => expect(region).toHaveTextContent("Verificando o que sumiu do Linear."));
    release();
    await screen.findByRole("heading", { name: "Sincronização concluída" });
    await waitFor(() => expect(region).toHaveTextContent("Sincronização concluída."));
  });
});

describe("Reimportação › campos preenchidos nos idiomas", () => {
  it.each([
    ["en", 3, "3 fields filled in tickets that already existed"],
    ["en", 1, "1 field filled in a ticket that already existed"],
    ["es-MX", 3, "3 campos completados en tickets que ya existían"],
    ["es-MX", 1, "1 campo completado en tickets que ya existían"],
  ] as const)("em %s com %i", async (language, filled, text) => {
    await setTestLanguage(language);
    setup({ existing: finished(), total: 2, reimportCounts: { filled } });
    await userEvent.click(await screen.findByRole("button", { name: language === "en" ? "Sync now" : "Sincronizar ahora" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    await setTestLanguage("pt-BR");
  });
});

describe("Reimportação › idiomas", () => {
  it.each([
    ["en", "Last import · 3 days ago", "Sync now", "Sync finished"],
    ["es-MX", "Última importación · hace 3 días", "Sincronizar ahora", "Sincronización terminada"],
  ] as const)("em %s", async (language, title, button, done) => {
    await setTestLanguage(language);
    setup({ existing: finished(), total: 2 });
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: button }));
    expect(await screen.findByRole("heading", { name: done })).toBeInTheDocument();
    await setTestLanguage("pt-BR");
  });
});

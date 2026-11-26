import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, ProjectLinear } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinear } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const FREE: ProjectLinear = { source: null, canLink: true, keyMatches: null };
const tickets = [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" }), makeTicket("t2", "p1", 2, "Fase dois", { key: "ENG-2" })];

function setup(options: { me?: Me; linear?: FakeLinear | undefined; connection?: boolean; link?: ProjectLinear; hash?: string } = {}) {
  window.location.hash = options.hash ?? "";
  const me = options.me ?? makePanelMe("admin");
  const linear: FakeLinear | undefined =
    options.linear !== undefined
      ? options.linear
      : { connection: options.connection === false ? null : makeLinearConnection(), projects: { p1: options.link ?? LINKED } };
  const client = makeClient({ me, projects: [project], tickets: { p1: tickets }, ...(linear ? { linear } : {}) });
  const onExit = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(<ImportScreen client={client} me={me} projectId="p1" onExit={onExit} onOpenSettings={onOpenSettings} />);
  return { client, onExit, onOpenSettings, ...view };
}
const linearTab = () => screen.findByRole("tab", { name: "Do Linear" });
async function openLinear() {
  await userEvent.click(await linearTab());
}

afterEach(() => {
  window.location.hash = "";
});

describe("Importação do Linear › onde fica", () => {
  it("sem o Linear no servidor a tela é só a lista, sem abas", async () => {
    setup({ linear: { configured: false } });
    expect(await screen.findByRole("heading", { name: "Importar lista", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("com o Linear configurado há duas abas e a lista segue sendo a primeira", async () => {
    setup();
    const tabs = await screen.findByRole("tablist", { name: "Origem da importação" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Por lista", "Do Linear"]);
    expect(screen.getByRole("tab", { name: "Por lista" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Lista" })).toBeInTheDocument();
  });

  it("a lista colada não se perde ao trocar de aba", async () => {
    setup();
    await userEvent.click(await screen.findByRole("textbox", { name: "Lista" }));
    await userEvent.paste("- Um item");
    await openLinear();
    await userEvent.click(screen.getByRole("tab", { name: "Por lista" }));
    expect(screen.getByRole("textbox", { name: "Lista" })).toHaveValue("- Um item");
  });

  it("vindo das Configurações (#linear) abre direto na aba do Linear", async () => {
    setup({ hash: "#linear" });
    expect(await screen.findByRole("heading", { name: "Importar do Linear", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Do Linear" })).toHaveAttribute("aria-selected", "true");
  });

  it("as setas trocam de aba e levam o foco", async () => {
    setup();
    const list = await screen.findByRole("tab", { name: "Por lista" });
    list.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Do Linear" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Do Linear" })).toHaveAttribute("aria-selected", "true");
  });

  it("com rodada em aberto, abre na aba do Linear e retoma sozinha até concluir", async () => {
    const { client } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues", counts: { issuesSeen: 5, projectsSeen: 3 } } } } });
    expect(await screen.findByRole("tab", { name: "Do Linear" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: "Importação concluída" })).toBeInTheDocument();
    expect(client.stepLinearRun).toHaveBeenCalled();
    expect(client.openLinearRun).not.toHaveBeenCalled();
  });
});

describe("Importação do Linear › sem poder importar ainda", () => {
  it("projeto sem vínculo: explica e leva às Configurações a quem pode ligar", async () => {
    const { onOpenSettings } = setup({ link: FREE });
    await openLinear();
    expect(await screen.findByText("Este projeto ainda não está ligado ao Linear")).toBeInTheDocument();
    expect(screen.getByText(/Ligue o projeto a um time do Linear em Configurações → Linear/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abrir Configurações → Linear" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
  });

  it("projeto sem vínculo para quem não administra: diz que um administrador precisa ligar", async () => {
    setup({ link: { ...FREE, canLink: false } });
    await openLinear();
    expect(await screen.findByText(/Um administrador do projeto precisa ligá-lo a um time do Linear/)).toBeInTheDocument();
  });

  it("ligado, mas a pessoa não tem chave: diz o workspace esperado e leva às Configurações", async () => {
    const { onOpenSettings } = setup({ connection: false });
    await openLinear();
    expect(await screen.findByText("Falta a sua chave do Linear")).toBeInTheDocument();
    expect(screen.getByText(/conecte a sua chave do workspace Acme em Configurações → Linear/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abrir Configurações → Linear" }));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
  });

  it("chave de outro workspace (keyMatches falso): nome do workspace e do time, sem botão de importar", async () => {
    setup({ link: { ...LINKED, keyMatches: false } });
    await openLinear();
    expect(await screen.findByText("A sua chave não serve a este projeto")).toBeInTheDocument();
    expect(screen.getByText(/ligado ao time ENG do workspace Acme/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
  });

  it("chave sem resposta do Linear (keyMatches nulo) não impede: o passo decide", async () => {
    setup({ link: { ...LINKED, keyMatches: null } });
    await openLinear();
    expect(await screen.findByRole("button", { name: "Importar" })).toBeEnabled();
  });

  it("agindo como outra pessoa: avisa e não deixa importar", async () => {
    setup({ me: { ...makePanelMe("admin"), actingAs: { realDisplayName: "Teodoro" } } });
    await openLinear();
    expect(await screen.findByText(/Agindo como outra pessoa, a importação do Linear não está disponível/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
  });
});

describe("Importação do Linear › antes de importar", () => {
  it("mostra origem e destino, sem a opção de procurar o lugar na árvore", async () => {
    setup();
    await openLinear();
    const card = (await screen.findByRole("button", { name: "Importar" })).closest(".linear-import-card")!;
    expect(within(card as HTMLElement).getByText("Origem")).toBeInTheDocument();
    expect(card).toHaveTextContent("ENG Engenharia · Acme");
    expect(card).toHaveTextContent("Raiz do projeto");
    expect(screen.queryByText(/Procurar o lugar/)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/A importação anda em passos curtos/)).toBeInTheDocument();
  });

  it("diz quantas issues vêm ('Vai trazer 412 issues'), pela prévia do servidor", async () => {
    const { client } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, preview: 412 } });
    await openLinear();
    const card = (await screen.findByRole("button", { name: "Importar" })).closest(".linear-import-card") as HTMLElement;
    expect(await within(card).findByText("Vai trazer")).toBeInTheDocument();
    expect(card).toHaveTextContent("412 issues");
    expect(client.getLinearPreview).toHaveBeenCalledWith("p1");
  });

  it("no singular: '1 issue'", async () => {
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, preview: 1 } });
    await openLinear();
    expect(await screen.findByText("1 issue")).toBeInTheDocument();
  });

  it.each([
    ["nula (o Linear não disse)", null],
    ["com erro", { error: ["unavailable", "linear_unavailable"] as ["unavailable", string] }],
  ])("prévia %s: sem número, e o botão segue livre", async (_name, preview) => {
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, preview } });
    await openLinear();
    expect(await screen.findByRole("button", { name: "Importar" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByText("Vai trazer")).not.toBeInTheDocument());
    expect(screen.queryByText(/\d+ issues?$/)).not.toBeInTheDocument();
  });

  it("a prévia lenta não segura o botão", async () => {
    const { client } = setup();
    vi.mocked(client.getLinearPreview).mockReturnValue(new Promise(() => {}));
    await openLinear();
    expect(await screen.findByRole("button", { name: "Importar" })).toBeEnabled();
  });

  it("importa na raiz por padrão, na ordem das fases, e termina no resumo", async () => {
    const { client } = setup();
    await openLinear();
    await userEvent.click(await screen.findByRole("button", { name: "Importar" }));
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", { destinationTicketId: null });
    expect(await screen.findByRole("heading", { name: "Importação concluída" })).toBeInTheDocument();
    const calls = vi.mocked(client.stepLinearRun).mock.calls;
    expect(calls.length).toBe(9);
    expect(calls.every(([project, run]) => project === "p1" && run === "run-1")).toBe(true);
  });

  it("o destino escolhido vai na abertura da rodada; a lista não oferece ideias", async () => {
    const { client } = setup();
    vi.mocked(client.listTickets).mockResolvedValue({ ok: true, data: [...tickets, makeTicket("t3", "p1", 3, "Uma ideia", { key: "ENG-3", idea: { stage: "raw", discarded: false } as never })] });
    await openLinear();
    await userEvent.click(await screen.findByRole("button", { name: "Trocar" }));
    const picker = await screen.findByRole("group", { name: "Escolher o destino" });
    expect(within(picker).queryByText("Uma ideia")).not.toBeInTheDocument();
    await userEvent.click(await within(picker).findByRole("button", { name: /ENG-2/ }));
    expect(screen.getByText("Fase dois")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Importar" }));
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", { destinationTicketId: "t2" });
  });

  it("filtra os tickets do seletor e Esc fecha só o seletor", async () => {
    setup();
    await openLinear();
    await userEvent.click(await screen.findByRole("button", { name: "Trocar" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Filtrar tickets" }), "dois");
    const picker = screen.getByRole("group", { name: "Escolher o destino" });
    expect(await within(picker).findByRole("button", { name: /ENG-2/ })).toBeInTheDocument();
    expect(within(picker).queryByRole("button", { name: /ENG-1/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Escolher o destino" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trocar" })).toHaveFocus();
  });

  it.each([
    ["linear_run_open", "Já existe uma importação do Linear em andamento"],
    ["linear_not_linked", "ainda não está ligado a um time do Linear"],
    ["linear_key_invalid", "O Linear não aceitou esta chave"],
    ["linear_workspace_mismatch", "outro workspace do Linear"],
  ])("erro ao abrir (%s) mostra a frase e deixa tentar de novo", async (code, text) => {
    const { client } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { openError: ["conflict", code] } } });
    await openLinear();
    await userEvent.click(await screen.findByRole("button", { name: "Importar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: "Importar" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Importar" }));
    expect(client.openLinearRun).toHaveBeenCalledTimes(2);
  });
});

describe("Importação do Linear › durante", () => {
  const held = () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    return { hold, release };
  };

  it("mostra a barra, as fases com estado e a frase 'pode fechar esta tela'", async () => {
    const { hold, release } = held();
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { total: 412, pageSize: 100, existing: { phase: "issues", totalExpected: 412, counts: { projectsSeen: 6, issuesSeen: 255 } }, script: [{ hold }] } } });
    const bar = await screen.findByRole("progressbar", { name: "Progresso da importação" });
    expect(bar).toHaveAttribute("aria-valuenow", "255");
    expect(bar).toHaveAttribute("aria-valuemax", "412");
    expect(screen.getByText("255 de 412", { selector: ".linear-import-count" })).toBeInTheDocument();
    expect(screen.getByText("pode fechar esta tela")).toBeInTheDocument();
    const phases = screen.getByRole("list", { name: "Fases da importação" });
    const items = within(phases).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "doing", "todo", "todo", "todo", "todo", "todo"]);
    expect(items[0]).toHaveTextContent("Projetos do Linear (6)");
    expect(items[1]).toHaveTextContent("Issues (255 de 412)");
    expect(items[0]).toHaveTextContent("feito");
    expect(items[1]).toHaveTextContent("em curso");
    expect(items[2]).toHaveTextContent("por vir");
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });

  it("sem total esperado a barra é indeterminada", async () => {
    const { hold, release } = held();
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { total: null, existing: { phase: "issues", totalExpected: null, counts: { issuesSeen: 40 } }, script: [{ hold }] } } });
    const bar = await screen.findByRole("progressbar");
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveClass("is-indeterminate");
    release();
    await screen.findByRole("heading", { name: "Importação concluída" });
  });

  it("nunca dispara dois passos ao mesmo tempo", async () => {
    let running = 0;
    let overlapped = false;
    const { client } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "projects" } } } });
    const step = client.stepLinearRun;
    client.stepLinearRun = vi.fn(async (...args: Parameters<typeof step>) => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await step(...args);
      running -= 1;
      return result;
    });
    await screen.findByRole("heading", { name: "Importação concluída" }, { timeout: 4000 });
    expect(overlapped).toBe(false);
  });

  it("o Linear pediu para esperar: mostra a hora em que volta", async () => {
    const { hold, release } = held();
    void hold;
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues" }, script: [{ waitSeconds: 3600 }] } } });
    expect(await screen.findByText(/O Linear pediu para esperar\. A importação volta às \d{1,2}:\d{2}/)).toBeInTheDocument();
    release();
  });

  it("503: diz que o Linear não respondeu e oferece 'Tentar de novo'", async () => {
    const script = Array.from({ length: 5 }, () => ({ error: ["unavailable", "linear_unavailable"] as ["unavailable", string] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues" }, script } } });
      expect(await screen.findByText(/O Linear não respondeu\. Tentando de novo/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      expect(screen.getByRole("alert")).toHaveTextContent(/O Linear não respondeu e a importação parou/);
      await act(async () => { await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: "Tentar de novo" })); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(await screen.findByRole("heading", { name: "Importação concluída" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("erro de chave: para, mostra a frase, leva às Configurações e 'Continuar' retoma", async () => {
    const { client, onOpenSettings } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues" }, script: [{ error: ["unavailable", "linear_key_invalid"] }] } } });
    expect(await screen.findByRole("alert")).toHaveTextContent("O Linear não aceitou esta chave");
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Abrir Configurações → Linear" }));
    expect(onOpenSettings).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByRole("heading", { name: "Importação concluída" })).toBeInTheDocument();
  });

  it.each([
    ["linear_workspace_mismatch", "outro workspace do Linear"],
    ["linear_team_not_visible", "não enxerga o time ligado"],
  ])("erro %s: frase própria e caminho para corrigir", async (code, text) => {
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues" }, script: [{ error: ["conflict", code] }] } } });
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: "Abrir Configurações → Linear" })).toBeInTheDocument();
  });

  it("ao sair da tela, o laço morre: nenhum passo depois de desmontar", async () => {
    const { hold } = held();
    const { client, unmount } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues" }, script: [{ hold }] } } });
    await waitFor(() => expect(client.stepLinearRun).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
  });

  it("a região de status existe desde o início e anuncia só fase e fim, nunca os passos", async () => {
    const { client } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { total: 40, pageSize: 5, existing: { phase: "projects", totalExpected: 40 } } } });
    await screen.findByRole("tab", { name: "Do Linear" });
    const region = (await screen.findAllByRole("status")).find((node) => node.classList.contains("linear-import-status"))!;
    expect(region).toBeInTheDocument();
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(region.textContent ?? ""));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    await screen.findByRole("heading", { name: "Importação concluída" });
    observer.disconnect();
    expect(vi.mocked(client.stepLinearRun).mock.calls.length).toBeGreaterThan(8);
    const phases = seen.filter((text) => text !== "");
    expect(phases.length).toBeLessThanOrEqual(4);
    expect(phases.every((text) => !/\d/.test(text))).toBe(true);
    await waitFor(() => expect(region).toHaveTextContent("Importação concluída."));
  });
});

describe("Importação do Linear › resumo", () => {
  it("mostra só as contagens maiores que zero, além de 'criados', e 'Abrir no mapa'", async () => {
    const counts = { projectsCreated: 6, issuesCreated: 406, issuesExisting: 3, issuesElsewhere: 0, flattened: 2, skipped: 0 };
    const { onExit } = setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "done", done: true, counts, finishedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } } } });
    await openLinear();
    // Ao voltar à tela com a importação já concluída, o que vale é o cartão da última importação (com as mesmas contagens).
    expect(await screen.findByRole("heading", { name: "Última importação · há 3 dias" })).toBeInTheDocument();
    const list = screen.getByLabelText("Contagens da importação");
    expect(within(list).getByText("Criados").nextSibling).toHaveTextContent("412");
    expect(within(list).getByText("Já existiam").nextSibling).toHaveTextContent("3");
    expect(within(list).getByText("Achatados").nextSibling).toHaveTextContent("2");
    expect(within(list).queryByText("Em outro projeto")).not.toBeInTheDocument();
    expect(within(list).queryByText("Pulados")).not.toBeInTheDocument();
    expect(screen.queryByText("Reimportar ainda não está disponível.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importar" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abrir no mapa" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("'criados' aparece mesmo com zero", async () => {
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "done", done: true, counts: { issuesExisting: 12 } } } } });
    await openLinear();
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).getByText("Criados").nextSibling).toHaveTextContent("0");
  });
});

describe("Importação do Linear › idiomas", () => {
  it.each([
    ["en", "From Linear", "Last import"],
    ["es-MX", "Desde Linear", "Última importación"],
  ] as const)("em %s", async (language, tab, done) => {
    await setTestLanguage(language);
    setup({ linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "done", done: true, counts: { issuesCreated: 4 } } } } });
    await userEvent.click(await screen.findByRole("tab", { name: tab }));
    expect(await screen.findByRole("heading", { name: done })).toBeInTheDocument();
    await setTestLanguage("pt-BR");
  });
});

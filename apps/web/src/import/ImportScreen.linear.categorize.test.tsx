import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminProvider } from "../api/ConsentRequired.js";
import type { LinearRun, ProjectLinear, ToCheckItem } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinear, FakeLinearCategorize } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-20T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const tickets = [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" })];
const finishedImport: Partial<LinearRun> = { phase: "done", done: true, finishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), destinationTicketId: "t1", counts: { projectsCreated: 2, issuesCreated: 10 } };
const item = (n: number, path: string[] = [], extra: Partial<ToCheckItem> = {}): ToCheckItem => ({ ticketId: `tk-${n}`, key: `ENG-${n}`, title: `Ticket número ${n}`, suggestedPath: path.map((title, index) => ({ id: `n-${index}`, title })), ...extra });

function setup(categorize: FakeLinearCategorize, options: { run?: Partial<LinearRun> | null; admin?: boolean; linear?: Partial<FakeLinear> } = {}) {
  window.location.hash = "#linear";
  const me = makePanelMe("admin");
  const client = makeClient({
    me,
    projects: [project],
    tickets: { p1: tickets },
    linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: options.run === null ? {} : { existing: options.run ?? finishedImport }, categorize, ...options.linear },
  });
  const onExit = vi.fn();
  const onOpenTicket = vi.fn();
  const view = render(
    <AdminProvider isAdmin={options.admin ?? true}>
      <ImportScreen client={client} me={me} projectId="p1" onExit={onExit} onOpenSettings={vi.fn()} onOpenTicket={onOpenTicket} />
    </AdminProvider>,
  );
  return { client, onExit, onOpenTicket, ...view };
}
const hold = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
const block = async () => within(await screen.findByRole("region", { name: "Arrumar na árvore" }));
const status = () => document.querySelector(".linear-import-status")!;

afterEach(() => {
  window.location.hash = "";
});

describe("Arrumar na árvore › antes de procurar", () => {
  it("com itens na raiz e IA disponível: a frase, o botão com o número, e o que vai à IA", async () => {
    setup({ candidates: 7 });
    const arrange = await block();
    expect(arrange.getByText("7 itens que vieram do Linear ainda estão onde a importação os pôs. A IA pode procurar o lugar de cada um na árvore. Na dúvida, o item fica onde está, marcado para você conferir.")).toBeInTheDocument();
    expect(arrange.getByRole("button", { name: "Procurar o lugar de 7 itens" })).toBeEnabled();
    expect(arrange.getByText("Vai à IA: título e descrição desses tickets, os títulos do que está dentro deles e a árvore do projeto (títulos e trechos).")).toBeInTheDocument();
    expect(arrange.queryByText(/raiz do destino/)).not.toBeInTheDocument();
  });

  it("acima do teto da rodada: o botão conta só os 200 da rodada e a frase diz que o resto fica para a próxima", async () => {
    setup({ candidates: 350, batchLimit: 200 });
    const arrange = await block();
    expect(arrange.getByRole("button", { name: "Procurar o lugar de 200 itens" })).toBeEnabled();
    expect(arrange.getByText("São 350 itens; esta rodada procura os 200 mais antigos e o resto fica para a próxima.")).toBeInTheDocument();
  });

  it("no teto exato ou abaixo, não há aviso de rodada", async () => {
    setup({ candidates: 200, batchLimit: 200 });
    const arrange = await block();
    expect(arrange.getByRole("button", { name: "Procurar o lugar de 200 itens" })).toBeInTheDocument();
    expect(arrange.queryByText(/esta rodada procura/)).not.toBeInTheDocument();
  });

  it("no singular, a frase e o botão concordam", async () => {
    setup({ candidates: 1 });
    const arrange = await block();
    expect(arrange.getByText(/^1 item que veio do Linear ainda está onde a importação o pôs\. A IA pode procurar o lugar dele na árvore\./)).toBeInTheDocument();
    expect(arrange.getByRole("button", { name: "Procurar o lugar de 1 item" })).toBeInTheDocument();
  });

  it("sem itens na raiz e nada a mostrar, o bloco não aparece", async () => {
    setup({ candidates: 0 });
    await screen.findByRole("heading", { name: /Última importação/ });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Arrumar na árvore" })).not.toBeInTheDocument());
  });

  it("sem aceite: a frase própria e o atalho para Configurações → IA e privacidade, sem botão de procurar", async () => {
    setup({ candidates: 7, reason: "assistant_consent_required" });
    const arrange = await block();
    expect(arrange.getByText(/precisa liberar o assistente de IA/)).toBeInTheDocument();
    const link = arrange.getByRole("link", { name: /Configurações/ });
    expect(link.getAttribute("href")).toMatch(/view=settings.*#ia$/);
    expect(arrange.queryByRole("button", { name: /Procurar o lugar/ })).not.toBeInTheDocument();
  });

  it("sem aceite e quem lê não administra: a frase sem o atalho", async () => {
    setup({ candidates: 7, reason: "assistant_consent_required" }, { admin: false });
    const arrange = await block();
    expect(arrange.getByText(/precisa liberar o assistente de IA/)).toBeInTheDocument();
    expect(arrange.queryByRole("link")).not.toBeInTheDocument();
  });

  it("IA sem configuração: a frase própria e nenhum botão de procurar", async () => {
    setup({ candidates: 7, reason: "assistant_not_configured" });
    const arrange = await block();
    expect(arrange.getByText(/A IA não está configurada neste ambiente/)).toBeInTheDocument();
    expect(arrange.queryByRole("button", { name: /Procurar o lugar/ })).not.toBeInTheDocument();
  });

  it("ao importar pela primeira vez, a tela não manda 'categorize' nem mostra a caixa", async () => {
    setup({ candidates: 0 }, { run: null });
    await userEvent.click(await screen.findByRole("button", { name: "Importar" }, { timeout: 3000 }).catch(() => screen.findByRole("button", { name: /Importar/ })));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("uma importação em andamento esconde o bloco", async () => {
    const { client } = setup({ candidates: 7 }, { run: { phase: "issues", done: false, counts: { issuesSeen: 5 } }, linear: { run: { total: 12, existing: { phase: "issues", done: false, counts: { issuesSeen: 5 } }, script: [{ hold: new Promise<void>(() => undefined) }] } } });
    await screen.findByRole("progressbar");
    expect(screen.queryByRole("region", { name: "Arrumar na árvore" })).not.toBeInTheDocument();
    expect(client.openLinearCategorize).not.toHaveBeenCalled();
  });
});

describe("Arrumar na árvore › durante", () => {
  it("abre uma rodada, mostra 'N de total', os contadores ao vivo e o aviso de que pode fechar", async () => {
    const gate = hold();
    const { client } = setup({ candidates: 12, plan: { placed: 6, toCheck: 3, kept: 3 }, pageSize: 4, script: ["ok", { hold: gate.promise }] });
    await userEvent.click((await block()).getByRole("button", { name: "Procurar o lugar de 12 itens" }));
    expect(client.openLinearCategorize).toHaveBeenCalledWith("p1");
    const arrange = await block();
    await waitFor(() => expect(arrange.getByText("4 de 12")).toBeInTheDocument());
    expect(arrange.getByRole("progressbar", { name: "Progresso da procura" })).toHaveAttribute("aria-valuenow", "4");
    expect(arrange.getByText("pode fechar esta tela")).toBeInTheDocument();
    expect(arrange.getByText("Movidos").previousSibling ?? arrange.getByText("Movidos").nextSibling).toHaveTextContent("4");
    expect(arrange.queryByRole("button", { name: /Procurar o lugar/ })).not.toBeInTheDocument();
    act(() => gate.release());
  });

  it("uma chamada por vez e na ordem; a região de status anuncia o começo e o fim, não cada passo", async () => {
    let inFlight = 0;
    let overlapped = false;
    const announcements: string[] = [];
    const { client } = setup({ candidates: 12, plan: { placed: 12 }, pageSize: 3 });
    const step = client.stepLinearCategorize;
    client.stepLinearCategorize = vi.fn(async (...args: Parameters<typeof step>) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await step(...args);
      inFlight -= 1;
      return result;
    });
    await screen.findByRole("region", { name: "Arrumar na árvore" });
    await waitFor(() => expect(status()).toHaveTextContent("Importação concluída."));
    const observer = new MutationObserver(() => { const text = status().textContent ?? ""; if (text !== "" && announcements.at(-1) !== text) announcements.push(text); });
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    await userEvent.click(screen.getByRole("button", { name: "Procurar o lugar de 12 itens" }));
    await waitFor(() => expect(screen.getByText(/12 movidos/)).toBeInTheDocument());
    await waitFor(() => expect(status()).toHaveTextContent("Procura do lugar dos itens concluída."));
    observer.disconnect();
    expect(overlapped).toBe(false);
    expect(vi.mocked(client.stepLinearCategorize).mock.calls.length).toBe(4);
    expect(announcements).toEqual(["Procurando o lugar dos itens.", "Procura do lugar dos itens concluída."]);
  });

  it("'Sincronizar agora' fica desabilitado, com a explicação, enquanto a procura está aberta", async () => {
    const gate = hold();
    setup({ candidates: 12, script: [{ hold: gate.promise }] });
    await userEvent.click((await block()).getByRole("button", { name: "Procurar o lugar de 12 itens" }));
    const reimport = await screen.findByRole("button", { name: "Sincronizar agora" });
    expect(reimport).toBeDisabled();
    expect(reimport).toHaveAccessibleDescription(/Sincronizar fica indisponível enquanto a procura/);
    act(() => gate.release());
    await waitFor(() => expect(screen.getByRole("button", { name: "Sincronizar agora" })).toBeEnabled());
  });

  it("espera dita pela IA: mostra 'aguardando' e não dá outro passo antes da hora", async () => {
    const { client } = setup({ candidates: 12, script: [{ waitSeconds: 3600 }] });
    await userEvent.click((await block()).getByRole("button", { name: "Procurar o lugar de 12 itens" }));
    expect(await screen.findByText(/A IA pediu para esperar\. A procura volta às/)).toBeInTheDocument();
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
  });

  it("erro do provedor: 'tentando de novo'; com mais de 2 falhas seguidas o Abandonar fica em destaque", async () => {
    setup({ candidates: 12, existing: { total: 12, errorStreak: 3, lastErrorCode: "assistant_unavailable" }, script: [{ hold: new Promise<void>(() => undefined) }] });
    const arrange = await block();
    const abandon = await arrange.findByRole("button", { name: "Abandonar" });
    expect(abandon.className).toContain("is-prominent");
  });

  it("erro inesperado de um passo (step_failed): frase própria enquanto tenta de novo", async () => {
    setup({ candidates: 12, existing: { total: 12 }, script: [{ providerError: "step_failed" }, { hold: new Promise<void>(() => undefined) }] });
    const arrange = await block();
    expect(await arrange.findByText("Um passo da procura falhou por um erro inesperado. Tentando de novo em instantes…")).toBeInTheDocument();
  });

  it("limite de uso da IA (assistant_rate_limited): frase própria, sem culpar o servidor", async () => {
    const { client } = setup({ candidates: 12, existing: { total: 12 }, script: [{ providerError: "assistant_rate_limited" }, { hold: new Promise<void>(() => undefined) }] });
    const arrange = await block();
    expect(await arrange.findByText("A IA atingiu o limite de uso por agora. Tentando de novo em instantes…")).toBeInTheDocument();
    expect(client.stepLinearCategorize).toHaveBeenCalled();
  });

  it("sem aceite no meio da procura: para com a frase e o atalho, e continua depois de corrigido", async () => {
    const { client } = setup({ candidates: 12, existing: { total: 12 }, script: [{ error: ["forbidden", "assistant_consent_required"] }] });
    const arrange = await block();
    expect(await arrange.findByText(/precisa liberar o assistente de IA/)).toBeInTheDocument();
    expect(arrange.getByRole("link", { name: /Configurações/ })).toBeInTheDocument();
    await userEvent.click(arrange.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(screen.getByText(/12 movidos/)).toBeInTheDocument());
    expect(vi.mocked(client.stepLinearCategorize).mock.calls.length).toBeGreaterThan(1);
  });

  it("reabrindo a tela com uma rodada aberta, ela retoma sozinha sem pedir para abrir outra", async () => {
    const { client } = setup({ candidates: 12, existing: { total: 12, done: 4, placed: 4 } });
    await waitFor(() => expect(screen.getByText(/12 movidos/)).toBeInTheDocument());
    expect(client.openLinearCategorize).not.toHaveBeenCalled();
    expect(client.stepLinearCategorize).toHaveBeenCalled();
  });

  it("abandonar pede confirmação na própria tela e para a procura; o que já foi decidido fica", async () => {
    const gate = hold();
    const { client } = setup({ candidates: 12, existing: { total: 12, done: 4, placed: 4 }, script: [{ hold: gate.promise }] });
    const arrange = await block();
    await userEvent.click(await arrange.findByRole("button", { name: "Abandonar" }));
    expect(client.abandonLinearCategorize).not.toHaveBeenCalled();
    const group = await screen.findByRole("group", { name: "Confirmar abandono da procura" });
    await userEvent.click(within(group).getByRole("button", { name: "Abandonar" }));
    expect(client.abandonLinearCategorize).toHaveBeenCalledWith("p1", "cat-1");
    expect(await screen.findByRole("heading", { name: "Procura abandonada" })).toBeInTheDocument();
    expect(screen.getByText(/4 movidos/)).toBeInTheDocument();
    act(() => gate.release());
  });

  it("ao desmontar no meio, nenhum passo novo é dado", async () => {
    const gate = hold();
    const { client, unmount } = setup({ candidates: 12, existing: { total: 12 }, script: [{ hold: gate.promise }] });
    await waitFor(() => expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1));
    unmount();
    act(() => gate.release());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
  });
});

describe("Arrumar na árvore › reimportar com a procura aberta", () => {
  it("o servidor recusa com linear_categorize_open: a tela mostra a frase e aponta para o bloco 'Arrumar na árvore'", async () => {
    setup({ candidates: 12 }, { linear: { run: { existing: finishedImport, openError: ["conflict", "linear_categorize_open"] } } });
    await userEvent.click(await screen.findByRole("button", { name: "Sincronizar agora" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Arrumar na árvore/);
    expect(alert).not.toHaveTextContent(/Abra a tela de importação/);
  });
});

describe("Arrumar na árvore › depois", () => {
  it("o resumo traz só o que for maior que zero e 'Abrir no mapa'", async () => {
    const { onExit } = setup({ candidates: 12, plan: { placed: 7, toCheck: 3, kept: 2 }, toCheckItems: [item(1), item(2), item(3)] });
    await userEvent.click((await block()).getByRole("button", { name: "Procurar o lugar de 12 itens" }));
    expect(await screen.findByText("7 movidos · 3 a conferir · 2 já no lugar")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Abrir no mapa" }).at(-1)!);
    expect(onExit).toHaveBeenCalled();
  });

  it("mostra as falhas quando houve", async () => {
    setup({ candidates: 4, plan: { placed: 3, failed: 1 } });
    await userEvent.click((await block()).getByRole("button", { name: "Procurar o lugar de 4 itens" }));
    expect(await screen.findByText("3 movidos · 1 falha")).toBeInTheDocument();
  });

  it("depois de terminar, o botão de procurar some quando não sobrou candidato", async () => {
    setup({ candidates: 4, plan: { placed: 4 } });
    await userEvent.click((await block()).getByRole("button", { name: "Procurar o lugar de 4 itens" }));
    await screen.findByText("4 movidos");
    expect(screen.queryByRole("button", { name: /Procurar o lugar de/ })).not.toBeInTheDocument();
  });
});

describe("Arrumar na árvore › a conferir", () => {
  const withItems = () => setup({ candidates: 0, toCheckItems: [item(1, ["Área", "Subárea"]), item(2, [], { title: "Um título muito longo ".repeat(12) })], existing: { phase: "done", finished: true, total: 3, done: 3, toCheck: 2 } });

  it("com itens a conferir o bloco aparece mesmo sem candidatos, e 'Ver os 2 a conferir' abre a lista", async () => {
    const { client } = withItems();
    const arrange = await block();
    await userEvent.click(arrange.getByRole("button", { name: "Ver os 2 a conferir" }));
    const list = await screen.findByRole("list", { name: "Itens a conferir" });
    expect(client.listLinearToCheck).toHaveBeenCalledWith("p1");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("ENG-1")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Sugestão: Área › Subárea")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Sem sugestão")).toBeInTheDocument();
  });

  it("cada item leva ao ticket pela mesma navegação do resto da aplicação", async () => {
    const { onOpenTicket } = withItems();
    await userEvent.click((await block()).getByRole("button", { name: "Ver os 2 a conferir" }));
    const list = await screen.findByRole("list", { name: "Itens a conferir" });
    await userEvent.click(within(list).getByRole("link", { name: /Ticket número 1/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("tk-1");
  });

  it("'Marcar como conferido' tira o item da lista e atualiza a contagem", async () => {
    const { client } = withItems();
    await userEvent.click((await block()).getByRole("button", { name: "Ver os 2 a conferir" }));
    const list = await screen.findByRole("list", { name: "Itens a conferir" });
    const reads = vi.mocked(client.getLinearCategorize).mock.calls.length;
    await userEvent.click(within(within(list).getAllByRole("listitem")[0]!).getByRole("button", { name: "Marcar como conferido" }));
    expect(client.dismissLinearToCheck).toHaveBeenCalledWith("p1", "tk-1");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    await waitFor(() => expect(vi.mocked(client.getLinearCategorize).mock.calls.length).toBeGreaterThan(reads));
    await userEvent.click(screen.getByRole("button", { name: "Esconder a lista" }));
    expect(await screen.findByRole("button", { name: "Ver o 1 a conferir" })).toBeInTheDocument();
  });

  it("erro ao marcar: mostra a falha no próprio item e o item continua", async () => {
    setup({ candidates: 0, toCheckItems: [item(1)], dismissError: ["unavailable"], existing: { phase: "done", finished: true, total: 1, done: 1, toCheck: 1 } });
    await userEvent.click((await block()).getByRole("button", { name: /a conferir/ }));
    const list = await screen.findByRole("list", { name: "Itens a conferir" });
    await userEvent.click(within(list).getByRole("button", { name: "Marcar como conferido" }));
    expect(await within(list).findByRole("alert")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  });

  it("erro ao ler a lista: mostra a falha e 'Tentar de novo'", async () => {
    setup({ candidates: 0, toCheckItems: [item(1)], toCheckError: ["unavailable"], existing: { phase: "done", finished: true, total: 1, done: 1, toCheck: 1 } });
    await userEvent.click((await block()).getByRole("button", { name: /a conferir/ }));
    expect(await screen.findByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("a lista se atualiza ao voltar à tela (foco da janela)", async () => {
    const { client } = withItems();
    await userEvent.click((await block()).getByRole("button", { name: "Ver os 2 a conferir" }));
    await screen.findByRole("list", { name: "Itens a conferir" });
    const before = vi.mocked(client.listLinearToCheck).mock.calls.length;
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(vi.mocked(client.listLinearToCheck).mock.calls.length).toBeGreaterThan(before));
  });
});

describe("Arrumar na árvore › idiomas", () => {
  it.each([
    ["en", "7 items that came from Linear are still where the import put them.", "Look for the place of 7 items", "title and description of those tickets, the titles of what is inside them, and the project tree"],
    ["es-MX", "7 elementos que vinieron de Linear siguen donde la importación los dejó.", "Buscar el lugar de 7 elementos", "título y descripción de esos tickets, los títulos de lo que hay dentro de ellos y el árbol del proyecto"],
  ] as const)("%s: a frase, o botão no plural e o que vai à IA", async (language, phrase, button, sends) => {
    await setTestLanguage(language);
    setup({ candidates: 7 });
    await screen.findByRole("button", { name: button });
    expect(await screen.findByText(new RegExp(phrase.replace(/[.]/g, "\\.")))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: button })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(sends, "i"))).toBeInTheDocument();
  });
});

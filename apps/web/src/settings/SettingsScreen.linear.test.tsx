import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api/client.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeLinearConnection, makeLinearTeam, makeMe, makeProject } from "../test/fakes.js";
import type { FakeLinear } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { SettingsScreen } from "./SettingsScreen.js";

const KEY = "lin_api_SEGREDO_a1b2";

const projects = [
  makeProject("p1", "ALFA", "Alfa"),
  makeProject("p2", "BETA", "Beta"),
  makeProject("p3", "OLD", "Antigo", { archivedAt: "2026-11-01T00:00:00.000Z" }),
];
const teams = [
  makeLinearTeam("ENG", "Engenharia", { linkedProject: { id: "p9", name: "TreePM" } }),
  makeLinearTeam("DES", "Design"),
  makeLinearTeam("OPS", "Operações", { linkedElsewhere: true }),
];

function setup(options: { me?: Me; linear?: FakeLinear | undefined; onOpenImport?: (projectId: string) => void; tweak?: (client: ReturnType<typeof makeClient>) => void } = {}) {
  window.location.hash = "linear";
  const me = options.me ?? makeMe();
  const client = makeClient({ me, projects, ...(options.linear ? { linear: options.linear } : {}) });
  options.tweak?.(client);
  render(
    <MemoryPreferencesProvider onSave={vi.fn()}>
      <SettingsScreen client={client} me={me} {...(options.onOpenImport ? { onOpenImport: options.onOpenImport } : {})} />
    </MemoryPreferencesProvider>,
  );
  return { client };
}
const section = () => screen.findByRole("region", { name: "Linear" });
const connected = (extra: Partial<FakeLinear> = {}): FakeLinear => ({ connection: makeLinearConnection(), teams, ...extra });

afterEach(() => {
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("Configurações › Linear › última importação do time", () => {
  const DAY = 86_400_000;
  const withImport = (when: string | null) => [makeLinearTeam("ENG", "Engenharia", { linkedProject: { id: "p9", name: "TreePM" }, lastImportedAt: when }), makeLinearTeam("DES", "Design", { lastImportedAt: new Date().toISOString() })];

  it("o time ligado mostra 'última importação há 3 dias'; sem data ou sem ligação, nada", async () => {
    setup({ linear: connected({ teams: withImport(new Date(Date.now() - 3 * DAY).toISOString()) }) });
    const list = await within(await section()).findByRole("list", { name: "Times que a sua chave enxerga" });
    const [eng, des] = within(list).getAllByRole("listitem");
    expect(eng).toHaveTextContent("Ligado ao projeto TreePM · última importação há 3 dias");
    expect(des).not.toHaveTextContent("última importação");
  });

  it("sem importação concluída, o texto não aparece", async () => {
    setup({ linear: connected({ teams: withImport(null) }) });
    const list = await within(await section()).findByRole("list", { name: "Times que a sua chave enxerga" });
    expect(list).not.toHaveTextContent("última importação");
  });

  it.each([
    ["en", "Linked to project TreePM · last import 3 days ago"],
    ["es-MX", "última importación hace 3 días"],
  ] as const)("em %s", async (language, text) => {
    await setTestLanguage(language);
    try {
      setup({ linear: connected({ teams: withImport(new Date(Date.now() - 3 * DAY).toISOString()) }) });
      expect(await screen.findByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    } finally {
      await setTestLanguage("pt-BR");
    }
  });

  it("relógio falso: 'ontem' e data absoluta a partir de sete dias", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
    try {
      setup({ linear: connected({ teams: withImport("2026-11-24T09:00:00.000Z") }) });
      expect(await within(await section()).findByText(/última importação ontem/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Configurações › Linear › visibilidade", () => {
  it("não aparece quando o servidor não tem o Linear configurado, e não consulta times", () => {
    const { client } = setup({ linear: { configured: false } });
    return waitFor(() => expect(client.getLinearConnection).toHaveBeenCalled()).then(() => {
      expect(screen.queryByRole("heading", { name: "Linear" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Idioma" })).toBeInTheDocument();
      expect(client.listLinearTeams).not.toHaveBeenCalled();
    });
  });

  it("aparece no grupo Integrações, sem a etiqueta de admin", async () => {
    setup({ linear: {} });
    await section();
    const link = screen.getByRole("link", { name: "Linear" });
    expect(link).toBeInTheDocument();
    expect(link).not.toHaveTextContent("admin");
    expect(within(link.closest("ul")!.parentElement!).getByText("Integrações")).toBeInTheDocument();
  });

  it("agindo como pessoa de teste mostra só a frase: nenhuma rota além de ler a ligação", async () => {
    const { client } = setup({ me: makeMe({ actingAs: "Teodoro" }), linear: connected() });
    const region = await section();
    expect(await within(region).findByText(/não pode ser usada como outra pessoa/)).toBeInTheDocument();
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
    expect(client.listLinearTeams).not.toHaveBeenCalled();
    expect(client.getProjectLinear).not.toHaveBeenCalled();
  });
});

describe("Configurações › Linear › sem chave", () => {
  it("mostra a orientação e um campo de senha que não grava nada no navegador", async () => {
    setup({ linear: {} });
    const region = await section();
    expect(within(region).getByText(/Personal API keys/)).toBeInTheDocument();
    expect(within(region).getByText(/só de leitura/)).toBeInTheDocument();
    const field = within(region).getByLabelText("Chave pessoal do Linear");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(within(region).getByRole("button", { name: "Conectar" })).toBeDisabled();
  });

  it("conecta com a chave sem espaços nas pontas; depois a chave não está mais em lugar nenhum da tela", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { client } = setup({ linear: { workspace: { id: "w", name: "Acme" } } });
    const region = await section();
    await userEvent.type(within(region).getByLabelText("Chave pessoal do Linear"), `  ${KEY}  `);
    await userEvent.click(within(region).getByRole("button", { name: "Conectar" }));
    expect(client.connectLinear).toHaveBeenCalledWith(KEY);
    expect(await within(region).findByText("Conectado")).toBeInTheDocument();
    expect(within(region).getByText("Workspace Acme")).toBeInTheDocument();
    expect(within(region).getByText("••••a1b2")).toBeInTheDocument();
    expect(within(region).getByText(/conectada em 24 de novembro de 2026/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("SEGREDO");
    expect(within(region).queryByLabelText("Chave pessoal do Linear")).not.toBeInTheDocument();
    expect(setItem.mock.calls.flat().join(" ")).not.toContain("SEGREDO");
    expect(window.localStorage.length).toBe(0);
  });

  it("chave recusada: erro na própria linha e o campo é esvaziado (o valor não fica na tela)", async () => {
    setup({ linear: { invalidKey: KEY } });
    const region = await section();
    const field = within(region).getByLabelText<HTMLInputElement>("Chave pessoal do Linear");
    await userEvent.type(field, KEY);
    await userEvent.click(within(region).getByRole("button", { name: "Conectar" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("O Linear não aceitou esta chave");
    expect(field.value).toBe("");
    expect(document.body.innerHTML).not.toContain("SEGREDO");
    expect(within(region).getByRole("button", { name: "Conectar" })).toBeDisabled();
  });

  it("limite do Linear: diz quantos segundos esperar", async () => {
    setup({ linear: { connectError: ["unavailable", "linear_rate_limited", { retryAfterSeconds: 42 }] } });
    const region = await section();
    await userEvent.type(within(region).getByLabelText("Chave pessoal do Linear"), KEY);
    await userEvent.click(within(region).getByRole("button", { name: "Conectar" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Tente de novo em 42 s.");
  });

  it("o Linear fora do ar: frase própria", async () => {
    setup({ linear: { connectError: ["unavailable", "linear_unavailable"] } });
    const region = await section();
    await userEvent.type(within(region).getByLabelText("Chave pessoal do Linear"), KEY);
    await userEvent.click(within(region).getByRole("button", { name: "Conectar" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("O Linear não respondeu");
    expect(document.body.innerHTML).not.toContain("SEGREDO");
  });
});

describe("Configurações › Linear › conectado", () => {
  it("mostra workspace, final da chave e data, com Substituir e Remover", async () => {
    setup({ linear: connected() });
    const region = await section();
    expect(await within(region).findByText("Workspace Acme")).toBeInTheDocument();
    expect(within(region).getByText("Conectado")).toBeInTheDocument();
    expect(within(region).getByText(/••••a1b2/)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Substituir" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Remover" })).toBeInTheDocument();
    expect(within(region).getByText(/não desfaz nenhuma ligação/, { selector: "p" })).toBeInTheDocument();
  });

  it("remover pede confirmação na própria tela (sem confirm do navegador) e volta ao estado sem chave", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { client } = setup({ linear: connected() });
    const region = await section();
    await userEvent.click(await within(region).findByRole("button", { name: "Remover" }));
    expect(client.disconnectLinear).not.toHaveBeenCalled();
    expect(within(region).getByText("Remover a chave não desfaz nenhuma ligação de projeto.")).toBeInTheDocument();
    await userEvent.click(within(region).getByRole("button", { name: /Confirmar/ }));
    expect(client.disconnectLinear).toHaveBeenCalledTimes(1);
    expect(await within(region).findByLabelText("Chave pessoal do Linear")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(within(region).queryByText("Times que a sua chave enxerga")).not.toBeInTheDocument();
  });

  it("substituir reabre o campo; cancelar volta sem trocar nada", async () => {
    const { client } = setup({ linear: connected() });
    const region = await section();
    await userEvent.click(await within(region).findByRole("button", { name: "Substituir" }));
    expect(within(region).getByLabelText("Chave pessoal do Linear")).toHaveAttribute("type", "password");
    await userEvent.click(within(region).getByRole("button", { name: "Cancelar" }));
    expect(within(region).queryByLabelText("Chave pessoal do Linear")).not.toBeInTheDocument();
    expect(client.connectLinear).not.toHaveBeenCalled();
  });

  it("substituir com chave nova mostra o novo workspace e recarrega os times", async () => {
    const { client } = setup({ linear: connected({ workspace: { id: "w2", name: "Outra" } }) });
    const region = await section();
    await userEvent.click(await within(region).findByRole("button", { name: "Substituir" }));
    await userEvent.type(within(region).getByLabelText("Chave pessoal do Linear"), KEY);
    await userEvent.click(within(region).getByRole("button", { name: "Conectar" }));
    expect(await within(region).findByText("Workspace Outra")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("SEGREDO");
    await waitFor(() => expect(client.listLinearTeams).toHaveBeenCalledTimes(2));
  });
});

describe("Configurações › Linear › times", () => {
  it("mostra carregando enquanto o Linear responde", async () => {
    setup({ linear: connected(), tweak: (client) => vi.mocked(client.listLinearTeams).mockReturnValue(new Promise(() => {})) });
    const region = await section();
    expect(await within(region).findByText("Consultando o Linear…")).toBeInTheDocument();
  });

  it("mostra os três estados de time", async () => {
    setup({ linear: connected() });
    const region = await section();
    const list = await within(region).findByRole("list", { name: "Times que a sua chave enxerga" });
    const [eng, des, ops] = within(list).getAllByRole("listitem");
    expect(eng).toHaveTextContent("ENG");
    expect(eng).toHaveTextContent("Engenharia");
    expect(eng).toHaveTextContent("ligação permanente");
    expect(eng).toHaveTextContent("Ligado ao projeto TreePM");
    expect(within(eng!).queryByRole("button")).not.toBeInTheDocument();
    expect(des).toHaveTextContent("Ainda não ligado a nenhum projeto");
    expect(within(des!).getByRole("button", { name: "Ligar o time DES a um projeto" })).toHaveTextContent("Ligar a um projeto…");
    expect(ops).toHaveTextContent("Já ligado a um projeto que você não enxerga");
    expect(ops).toHaveTextContent("indisponível");
    expect(within(ops!).queryByRole("button")).not.toBeInTheDocument();
  });

  it("sem times: diz que a chave não enxerga nenhum", async () => {
    setup({ linear: connected({ teams: [] }) });
    expect(await screen.findByText("A sua chave não enxerga nenhum time.")).toBeInTheDocument();
  });

  it("limite do Linear ao listar: mostra quantos segundos esperar e deixa tentar de novo", async () => {
    const { client } = setup({ linear: connected({ teamsError: ["unavailable", "linear_rate_limited", { retryAfterSeconds: 30 }] }) });
    const region = await section();
    expect(await within(region).findByRole("alert")).toHaveTextContent("Tente de novo em 30 s.");
    await userEvent.click(within(region).getByRole("button", { name: "Tentar de novo" }));
    expect(await within(region).findByText("Design")).toBeInTheDocument();
    expect(client.listLinearTeams).toHaveBeenCalledTimes(2);
  });

  it("Atualizar consulta de novo e mantém a lista enquanto isso", async () => {
    const { client } = setup({ linear: connected() });
    const region = await section();
    await within(region).findByText("Design");
    await userEvent.click(within(region).getByRole("button", { name: "Atualizar" }));
    expect(client.listLinearTeams).toHaveBeenCalledTimes(2);
    expect(within(region).getByText("Design")).toBeInTheDocument();
  });
});

describe("Configurações › Linear › ligar um projeto", () => {
  const openDialog = async () => {
    const region = await section();
    const opener = await within(region).findByRole("button", { name: "Ligar o time DES a um projeto" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog");
    return { region, opener, dialog };
  };

  it("lista só projetos ativos, sem origem, que a pessoa administra", async () => {
    const member: Me = { ...makeMe({ clerk: "member" }), roles: { clerk: "member", teams: [], projects: [{ projectId: "p2", role: "manager" }, { projectId: "p1", role: "contributor" }] } };
    const { client } = setup({ me: member, linear: connected({ projects: { p2: { source: { workspace: { id: "w", name: "Acme" }, team: { id: "x", key: "X", name: "X" }, linkedAt: "2026-11-01T00:00:00.000Z", linkedBy: { id: "u" } }, canLink: false, keyMatches: true } } }) });
    const { dialog } = await openDialog();
    expect(await within(dialog).findByText("Você não administra nenhum projeto que ainda esteja sem origem.", { exact: false })).toBeInTheDocument();
    expect(client.getProjectLinear).toHaveBeenCalledTimes(1);
    expect(client.getProjectLinear).toHaveBeenCalledWith("p2");
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("administrador escolhe entre os projetos ativos sem origem; arquivado fica de fora", async () => {
    setup({ linear: connected() });
    const { dialog } = await openDialog();
    const select = await within(dialog).findByRole("combobox", { name: "Projeto a ligar" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Escolha um projeto…", "ALFA · Alfa", "BETA · Beta"]);
  });

  it("o botão só habilita com a chave do time (sem diferenciar maiúsculas nem espaços nas pontas)", async () => {
    const { client } = setup({ linear: connected() });
    const { dialog } = await openDialog();
    await userEvent.selectOptions(await within(dialog).findByRole("combobox", { name: "Projeto a ligar" }), "p1");
    expect(within(dialog).getByRole("heading", { name: "Ligar Alfa ao time Design?" })).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Ligar para sempre" });
    const field = within(dialog).getByRole("textbox", { name: /digite a chave do time/ });
    expect(submit).toBeDisabled();
    await userEvent.type(field, "de");
    expect(submit).toBeDisabled();
    await userEvent.type(field, "s ");
    expect(submit).toBeEnabled();
    await userEvent.clear(field);
    await userEvent.type(field, "ENG");
    expect(submit).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "  des");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(client.linkProjectToLinear).toHaveBeenCalledWith("p1", { teamId: "team-des", confirmTeamKey: "des" });
  });

  it("depois de ligar, fecha o diálogo e a lista mostra o time como ligado (sem botão)", async () => {
    setup({ linear: connected() });
    const { region, dialog } = await openDialog();
    await userEvent.selectOptions(await within(dialog).findByRole("combobox", { name: "Projeto a ligar" }), "p2");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /digite a chave do time/ }), "DES");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ligar para sempre" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const item = (await within(region).findByText("Design")).closest("li")!;
    await waitFor(() => expect(item).toHaveTextContent("Ligado ao projeto Beta"));
    expect(item).toHaveTextContent("ligação permanente");
    expect(within(item).queryByRole("button")).not.toBeInTheDocument();
  });

  it("mostra o resumo, o aviso de ligação permanente e o descreve ao leitor de tela", async () => {
    setup({ linear: connected() });
    const { dialog } = await openDialog();
    await userEvent.selectOptions(await within(dialog).findByRole("combobox", { name: "Projeto a ligar" }), "p1");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Ligar Alfa ao time Design?");
    expect(within(dialog).getByRole("combobox", { name: "Projeto a ligar" })).toHaveValue("p1");
    expect(within(dialog).getByText("Acme")).toBeInTheDocument();
    const warning = within(dialog).getByText("Esta ligação é permanente.").closest("[id]")!;
    expect(dialog.getAttribute("aria-describedby")).toContain(warning.id);
    expect(warning).toHaveTextContent("não pode ser trocado nem desfeito");
  });

  it("erro do servidor aparece dentro do diálogo e o diálogo continua aberto", async () => {
    setup({ linear: connected({ linkError: ["unavailable", "linear_unavailable"] }) });
    const { dialog } = await openDialog();
    await userEvent.selectOptions(await within(dialog).findByRole("combobox", { name: "Projeto a ligar" }), "p1");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /digite a chave do time/ }), "DES");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ligar para sempre" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("O Linear não respondeu");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it.each(["linear_team_in_use", "linear_already_linked"])("%s: frase no diálogo e a lista é atualizada ao fechar", async (code) => {
    const { client } = setup({ linear: connected({ linkError: ["conflict", code] }) });
    const { dialog } = await openDialog();
    await userEvent.selectOptions(await within(dialog).findByRole("combobox", { name: "Projeto a ligar" }), "p1");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /digite a chave do time/ }), "DES");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ligar para sempre" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(code === "linear_team_in_use" ? "já está ligado a outro projeto" : "já está ligado a um time do Linear");
    expect(client.listLinearTeams).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(client.listLinearTeams).toHaveBeenCalledTimes(2));
  });

  it("Esc cancela sem ligar e o foco volta ao botão de origem", async () => {
    const { client } = setup({ linear: connected() });
    const { opener } = await openDialog();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(client.linkProjectToLinear).not.toHaveBeenCalled();
  });

  it("o foco fica preso no diálogo: Tab no último volta ao primeiro, Shift+Tab no primeiro vai ao último", async () => {
    setup({ linear: connected() });
    const { dialog } = await openDialog();
    await userEvent.selectOptions(await within(dialog).findByRole("combobox", { name: "Projeto a ligar" }), "p1");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /digite a chave do time/ }), "DES");
    const cancel = within(dialog).getByRole("button", { name: "Cancelar" });
    const submit = within(dialog).getByRole("button", { name: "Ligar para sempre" });
    submit.focus();
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(submit);
    expect(document.activeElement).toBe(within(dialog).getByRole("combobox"));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(submit);
    expect(cancel).toBeInTheDocument();
  });
});

describe("Configurações › Linear › Abrir importação", () => {
  it("o time ligado a um projeto ganha o botão, que leva à importação desse projeto", async () => {
    const onOpenImport = vi.fn();
    setup({ linear: connected(), onOpenImport });
    const row = (await screen.findByText("Engenharia")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Abrir a importação do projeto TreePM" }));
    expect(onOpenImport).toHaveBeenCalledWith("p9");
  });

  it("times livres ou de projeto que a pessoa não enxerga não têm o botão", async () => {
    setup({ linear: connected(), onOpenImport: vi.fn() });
    await screen.findByText("Design");
    expect(screen.getAllByRole("button", { name: /Abrir a importação/ })).toHaveLength(1);
  });

  it("sem o atalho de navegação, o botão não aparece", async () => {
    setup({ linear: connected() });
    await screen.findByText("Engenharia");
    expect(screen.queryByRole("button", { name: /Abrir a importação/ })).not.toBeInTheDocument();
  });
});

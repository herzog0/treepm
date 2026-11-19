import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project } from "../api/client.js";
import { failed, makeProject, ok } from "../test/fakes.js";
import { ProjectsSection } from "./ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson, makeTeam } from "./testing.js";

const people = [
  makePerson("person-1", "Ana"),
  makePerson("p2", "Bruno"),
  makePerson("p3", "Carla"),
  makePerson("p4", "Davi", { active: false }),
];
const teams = [makeTeam("t1", "Plataforma"), makeTeam("t2", "Design System")];

const alpha = makeProject("p1", "ALFA", "Alfa", {
  members: [
    { personId: "person-1", role: "manager" },
    { personId: "p2", role: "reader" },
  ],
  teamIds: ["t1"],
});
const beta = makeProject("p-b", "BETA", "Beta", { visibility: "private" });
const old = makeProject("p-o", "VELHO", "Velho", { archivedAt: "2026-01-01T00:00:00Z" });

function setup(opts: { client?: ApiClient; me?: Me; projects?: Project[]; selected?: Project | null } = {}) {
  const client = opts.client ?? makePanelClient({ projects: opts.projects ?? [alpha, beta, old], people, teams });
  const onChanged = vi.fn();
  const props = {
    client,
    me: opts.me ?? makePanelMe("admin"),
    projects: opts.projects ?? [alpha, beta, old],
    selectedProject: opts.selected ?? null,
    onChanged,
  };
  const view = render(<ProjectsSection {...props} />);
  const rerender = (next: Partial<typeof props>) => view.rerender(<ProjectsSection {...props} {...next} />);
  return { client, onChanged, rerender };
}

const openDetail = async (name: string) => {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("heading", { name });
};

describe("lista de projetos", () => {
  it("mostra nome, chave e as marcas de privado e arquivado", () => {
    setup();
    const list = screen.getByRole("list");
    expect(within(list).getByText("ALFA")).toBeInTheDocument();
    expect(within(list).getByText("Privado")).toBeInTheDocument();
    expect(within(list).getByText("Arquivado")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  });

  it("clicar em um item abre o detalhe e voltar fecha", async () => {
    setup();
    await openDetail("Alfa");
    await userEvent.click(screen.getByRole("button", { name: "Voltar para a lista" }));
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alfa" })).not.toBeInTheDocument();
  });

  it("abre o detalhe quando selectedProject chega e ressincroniza quando muda", async () => {
    const { rerender } = setup({ selected: alpha });
    expect(await screen.findByRole("heading", { name: "Alfa" })).toBeInTheDocument();
    rerender({ selectedProject: beta });
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alfa" })).not.toBeInTheDocument();
  });

  it("depois de voltar, a mesma seleção não reabre sozinha, mas uma nova sim", async () => {
    const { rerender } = setup({ selected: alpha });
    await screen.findByRole("heading", { name: "Alfa" });
    await userEvent.click(screen.getByRole("button", { name: "Voltar para a lista" }));
    rerender({ selectedProject: alpha });
    expect(screen.queryByRole("heading", { name: "Alfa" })).not.toBeInTheDocument();
    rerender({ selectedProject: beta });
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeInTheDocument();
  });
});

describe("criar projeto", () => {
  it("não aparece para quem não é administrador da organização", () => {
    setup({ me: makePanelMe("member", [{ projectId: "p1", role: "manager" }]) });
    expect(screen.queryByRole("button", { name: "Novo projeto" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Chave" })).not.toBeInTheDocument();
  });

  it("administrador abre o formulário pelo botão", async () => {
    setup();
    expect(screen.queryByRole("textbox", { name: "Chave" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Novo projeto" }));
    expect(screen.getByRole("textbox", { name: "Nome" })).toBeInTheDocument();
  });

  it("sem projetos e com permissão, o formulário já aparece aberto", () => {
    setup({ projects: [] });
    expect(screen.getByRole("textbox", { name: "Chave" })).toBeInTheDocument();
  });

  it("sem projetos e sem permissão, só o texto de vazio", () => {
    setup({ projects: [], me: makePanelMe("member") });
    expect(screen.getByText("Nenhum projeto criado.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("converte a chave para maiúsculas ao digitar", async () => {
    setup({ projects: [] });
    const key = screen.getByRole("textbox", { name: "Chave" });
    await userEvent.type(key, "ab1");
    expect(key).toHaveValue("AB1");
  });

  it.each(["A", "1AB", "ABCDEFGHIJK", "A-B"])("recusa a chave inválida %s com explicação", async (value) => {
    const { client, onChanged } = setup({ projects: [] });
    await userEvent.type(screen.getByRole("textbox", { name: "Nome" }), "Novo");
    await userEvent.type(screen.getByRole("textbox", { name: "Chave" }), value);
    await userEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/letra maiúscula.*2 a 10/);
    expect(client.createProject).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("recusa nome vazio", async () => {
    const { client } = setup({ projects: [] });
    await userEvent.type(screen.getByRole("textbox", { name: "Chave" }), "NOVO");
    await userEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Informe o nome do projeto.");
    expect(client.createProject).not.toHaveBeenCalled();
  });

  it("cria com a visibilidade escolhida, chama onChanged e deixa o projeto aberto", async () => {
    const created = makeProject("p9", "NOVO", "Novo");
    const client = makePanelClient({ people, teams });
    vi.mocked(client.createProject).mockResolvedValue(ok(created));
    const { onChanged } = setup({ client, projects: [] });
    await userEvent.type(screen.getByRole("textbox", { name: "Nome" }), "  Novo ");
    await userEvent.type(screen.getByRole("textbox", { name: "Chave" }), "novo");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Visibilidade" }), "private");
    await userEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(client.createProject).toHaveBeenCalledWith({ name: "Novo", key: "NOVO", visibility: "private" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "Novo" })).toBeInTheDocument();
  });

  it("project_key_taken aparece junto da chave, preserva o texto e não chama onChanged", async () => {
    const client = makePanelClient({ people, teams });
    vi.mocked(client.createProject).mockResolvedValue(failed("conflict", "project_key_taken"));
    const { onChanged } = setup({ client, projects: [] });
    await userEvent.type(screen.getByRole("textbox", { name: "Nome" }), "Novo");
    await userEvent.type(screen.getByRole("textbox", { name: "Chave" }), "ALFA");
    await userEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    const key = screen.getByRole("textbox", { name: "Chave" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe um projeto com essa chave.");
    expect(key).toHaveAccessibleDescription("Já existe um projeto com essa chave.");
    expect(key).toHaveValue("ALFA");
    expect(screen.getByRole("textbox", { name: "Nome" })).toHaveValue("Novo");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("outro erro aparece junto do botão", async () => {
    const client = makePanelClient({ people, teams });
    vi.mocked(client.createProject).mockResolvedValue(failed("forbidden"));
    const { onChanged } = setup({ client, projects: [] });
    await userEvent.type(screen.getByRole("textbox", { name: "Nome" }), "Novo");
    await userEvent.type(screen.getByRole("textbox", { name: "Chave" }), "NOVO");
    await userEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem permissão");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("desabilita o botão enquanto envia", async () => {
    const client = makePanelClient({ people, teams });
    let finish: (value: Awaited<ReturnType<ApiClient["createProject"]>>) => void = () => undefined;
    vi.mocked(client.createProject).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    setup({ client, projects: [] });
    await userEvent.type(screen.getByRole("textbox", { name: "Nome" }), "Novo");
    await userEvent.type(screen.getByRole("textbox", { name: "Chave" }), "NOVO");
    await userEvent.click(screen.getByRole("button", { name: "Criar projeto" }));
    expect(screen.getByRole("button", { name: "Criar projeto" })).toBeDisabled();
    finish(failed("unavailable"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Criar projeto" })).toBeEnabled());
  });
});

describe("detalhe — leitura", () => {
  it("mostra pessoas com papel e times associados, com o aviso sobre times", async () => {
    setup({ selected: alpha });
    await screen.findByRole("heading", { name: "Alfa" });
    const members = await screen.findByRole("list", { name: "Pessoas com acesso" });
    expect(within(members).getByText("Ana")).toBeInTheDocument();
    expect(within(members).getByText("Bruno")).toBeInTheDocument();
    const teamList = await screen.findByRole("list", { name: "Times do projeto" });
    expect(within(teamList).getByText("Plataforma")).toBeInTheDocument();
    expect(screen.getByText(/não dá acesso às pessoas dele/i)).toBeInTheDocument();
  });

  it("mostra carregamento e erro ao buscar pessoas e times", async () => {
    const client = makePanelClient({ people, teams });
    vi.mocked(client.listPeople).mockResolvedValueOnce(failed("unavailable"));
    setup({ client, selected: alpha });
    expect(screen.getByText("Carregando pessoas…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível.");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Bruno")).toBeInTheDocument();
  });

  it.each([
    ["leitor", makePanelMe("member", [{ projectId: "p1", role: "reader" }])],
    ["colaborador", makePanelMe("member", [{ projectId: "p1", role: "contributor" }])],
    ["membro sem papel", makePanelMe("member")],
    ["gestor de outro projeto", makePanelMe("member", [{ projectId: "outro", role: "manager" }])],
  ])("%s vê tudo somente leitura", async (_name, me) => {
    setup({ me, selected: alpha });
    await screen.findByText("Bruno");
    await screen.findByText("Plataforma");
    expect(screen.queryByRole("button", { name: /arquivar|revogar|associar|dar acesso|salvar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("projeto arquivado mostra a marca", async () => {
    setup({ selected: old });
    await screen.findByRole("heading", { name: "Velho" });
    expect(screen.getAllByText("Arquivado").length).toBeGreaterThan(0);
  });
});

describe.each([
  ["administrador da organização", makePanelMe("admin")],
  ["gestor do projeto", makePanelMe("member", [{ projectId: "p1", role: "manager" }])],
])("detalhe — %s", (_name, me) => {
  const ready = async (client: ApiClient) => {
    const view = setup({ client, me, selected: alpha });
    await screen.findByText("Bruno");
    await screen.findByText("Plataforma");
    return view;
  };
  const makeClient = () => makePanelClient({ projects: [alpha], people, teams });

  it("renomeia o projeto", async () => {
    const client = makeClient();
    vi.mocked(client.updateProject).mockResolvedValue(ok({ ...alpha, name: "Alfa 2" }));
    const { onChanged } = await ready(client);
    const field = screen.getByRole("textbox", { name: "Nome do projeto" });
    await userEvent.clear(field);
    await userEvent.type(field, "Alfa 2");
    await userEvent.click(screen.getByRole("button", { name: "Salvar nome" }));
    expect(client.updateProject).toHaveBeenCalledWith("p1", { name: "Alfa 2" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("erro ao renomear aparece e preserva o texto", async () => {
    const client = makeClient();
    vi.mocked(client.updateProject).mockResolvedValue(failed("forbidden"));
    const { onChanged } = await ready(client);
    const field = screen.getByRole("textbox", { name: "Nome do projeto" });
    await userEvent.clear(field);
    await userEvent.type(field, "Alfa 2");
    await userEvent.click(screen.getByRole("button", { name: "Salvar nome" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem permissão");
    expect(field).toHaveValue("Alfa 2");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("muda a visibilidade", async () => {
    const client = makeClient();
    vi.mocked(client.updateProject).mockResolvedValue(ok({ ...alpha, visibility: "private" }));
    const { onChanged } = await ready(client);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Visibilidade" }), "private");
    expect(client.updateProject).toHaveBeenCalledWith("p1", { visibility: "private" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("arquiva só depois da confirmação", async () => {
    const client = makeClient();
    vi.mocked(client.updateProject).mockResolvedValue(ok({ ...alpha, archivedAt: "2026-02-02T00:00:00Z" }));
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Arquivar projeto" }));
    expect(client.updateProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    expect(client.updateProject).toHaveBeenCalledWith("p1", { archived: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("cancelar o arquivamento não chama a API", async () => {
    const client = makeClient();
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Arquivar projeto" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(client.updateProject).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("erro ao arquivar aparece e não chama onChanged", async () => {
    const client = makeClient();
    vi.mocked(client.updateProject).mockResolvedValue(failed("unavailable"));
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Arquivar projeto" }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A API está indisponível.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("desarquiva sem confirmação", async () => {
    const archived = { ...alpha, archivedAt: "2026-01-01T00:00:00Z" };
    const client = makePanelClient({ projects: [archived], people, teams });
    vi.mocked(client.updateProject).mockResolvedValue(ok({ ...archived, archivedAt: null }));
    const onChanged = vi.fn();
    render(<ProjectsSection client={client} me={me} projects={[archived]} selectedProject={archived} onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole("button", { name: "Desarquivar projeto" }));
    expect(client.updateProject).toHaveBeenCalledWith("p1", { archived: false });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("altera o papel de uma pessoa", async () => {
    const client = makeClient();
    vi.mocked(client.putProjectMember).mockResolvedValue(ok({ personId: "p2", role: "contributor" }));
    const { onChanged } = await ready(client);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Papel de Bruno" }), "contributor");
    expect(client.putProjectMember).toHaveBeenCalledWith("p1", "p2", { role: "contributor" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("erro ao alterar papel aparece na linha da pessoa", async () => {
    const client = makeClient();
    vi.mocked(client.putProjectMember).mockResolvedValue(failed("conflict", "person_inactive"));
    const { onChanged } = await ready(client);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Papel de Bruno" }), "manager");
    const row = screen.getByText("Bruno").closest("li") as HTMLElement;
    expect(await within(row).findByRole("alert")).toHaveTextContent("A pessoa não está mais na organização.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("revoga o acesso só depois da confirmação", async () => {
    const client = makeClient();
    vi.mocked(client.removeProjectMember).mockResolvedValue(ok(undefined));
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Revogar acesso de Bruno" }));
    expect(client.removeProjectMember).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    expect(client.removeProjectMember).toHaveBeenCalledWith("p1", "p2");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("erro ao revogar aparece e não chama onChanged", async () => {
    const client = makeClient();
    vi.mocked(client.removeProjectMember).mockResolvedValue(failed("not_found"));
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Revogar acesso de Bruno" }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não encontramos esse item.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("oferece só pessoas ativas que ainda não têm papel e dá acesso com o papel escolhido", async () => {
    const client = makeClient();
    vi.mocked(client.putProjectMember).mockResolvedValue(ok({ personId: "p3", role: "contributor" }));
    const { onChanged } = await ready(client);
    const select = screen.getByRole("combobox", { name: "Pessoa" });
    const options = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Carla");
    expect(options).not.toContain("Ana");
    expect(options).not.toContain("Bruno");
    expect(options).not.toContain("Davi");
    await userEvent.selectOptions(select, "p3");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Papel da nova pessoa" }), "contributor");
    await userEvent.click(screen.getByRole("button", { name: "Dar acesso" }));
    expect(client.putProjectMember).toHaveBeenCalledWith("p1", "p3", { role: "contributor" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("person_inactive ao dar acesso vira mensagem", async () => {
    const client = makeClient();
    vi.mocked(client.putProjectMember).mockResolvedValue(failed("conflict", "person_inactive"));
    const { onChanged } = await ready(client);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Pessoa" }), "p3");
    await userEvent.click(screen.getByRole("button", { name: "Dar acesso" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A pessoa não está mais na organização.");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("não dá acesso sem escolher uma pessoa", async () => {
    const client = makeClient();
    await ready(client);
    expect(screen.getByRole("button", { name: "Dar acesso" })).toBeDisabled();
  });

  it("associa um time ainda não associado", async () => {
    const client = makeClient();
    vi.mocked(client.putProjectTeam).mockResolvedValue(ok({ projectId: "p1", teamId: "t2" }));
    const { onChanged } = await ready(client);
    const select = screen.getByRole("combobox", { name: "Time" });
    const options = within(select).getAllByRole("option").map((option) => option.textContent);
    expect(options).toContain("Design System");
    expect(options).not.toContain("Plataforma");
    await userEvent.selectOptions(select, "t2");
    await userEvent.click(screen.getByRole("button", { name: "Associar time" }));
    expect(client.putProjectTeam).toHaveBeenCalledWith("p1", "t2");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("erro ao associar time aparece e não chama onChanged", async () => {
    const client = makeClient();
    vi.mocked(client.putProjectTeam).mockResolvedValue(failed("forbidden"));
    const { onChanged } = await ready(client);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Time" }), "t2");
    await userEvent.click(screen.getByRole("button", { name: "Associar time" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem permissão");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("desassocia um time", async () => {
    const client = makeClient();
    vi.mocked(client.removeProjectTeam).mockResolvedValue(ok(undefined));
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Desassociar Plataforma" }));
    expect(client.removeProjectTeam).toHaveBeenCalledWith("p1", "t1");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("erro ao desassociar aparece e não chama onChanged", async () => {
    const client = makeClient();
    vi.mocked(client.removeProjectTeam).mockResolvedValue(failed("not_found"));
    const { onChanged } = await ready(client);
    await userEvent.click(screen.getByRole("button", { name: "Desassociar Plataforma" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não encontramos esse item.");
    expect(onChanged).not.toHaveBeenCalled();
  });
});

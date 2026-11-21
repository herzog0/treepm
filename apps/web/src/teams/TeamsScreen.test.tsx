import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Person, Team } from "../api/client.js";
import { failed, makeClient, makeMe, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TeamsScreen } from "./TeamsScreen.js";

const person = (id: string, displayName: string, active = true): Person => ({
  id,
  displayName,
  email: `${displayName.toLowerCase()}@example.com`,
  avatarUrl: null,
  clerkRole: "member",
  active,
});
const PEOPLE = [person("p-ana", "Ana"), person("p-bia", "Bia"), person("p-caio", "Caio"), person("p-duda", "Duda", false)];
const alfa = (): Team => ({
  id: "t-alfa",
  name: "Alfa",
  members: [
    { personId: "p-ana", role: "admin" },
    { personId: "p-bia", role: "member" },
  ],
});
const beta = (): Team => ({ id: "t-beta", name: "Beta", members: [] });

const meAsOrgAdmin = (): Me => makeMe({ clerk: "admin" });
const meAsTeamAdmin = (teamId = "t-alfa"): Me => {
  const me = makeMe({ clerk: "member" });
  return { ...me, roles: { ...me.roles, teams: [{ teamId, role: "admin" }] } };
};
const meAsMember = (): Me => {
  const me = makeMe({ clerk: "member" });
  return { ...me, roles: { ...me.roles, teams: [{ teamId: "t-alfa", role: "member" }] } };
};

/** Cliente com estado: as mutações alteram `teams`, e as listagens refletem isso. */
function setup(me: Me, initial: Team[] = [alfa(), beta()], overrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
  let teams = initial;
  const client = {
    ...makeClient(),
    listTeams: vi.fn(async () => ok(structuredClone(teams))),
    listPeople: vi.fn(async () => ok(PEOPLE)),
    createTeam: vi.fn(async ({ name }: { name: string }) => {
      const team = { id: "t-new", name, members: [] };
      teams = [...teams, team];
      return ok(team);
    }),
    renameTeam: vi.fn(async (id: string, { name }: { name: string }) => {
      teams = teams.map((t) => (t.id === id ? { ...t, name } : t));
      return ok(teams.find((t) => t.id === id) as Team);
    }),
    removeTeam: vi.fn(async (id: string) => {
      teams = teams.filter((t) => t.id !== id);
      return ok(undefined);
    }),
    putTeamMember: vi.fn(async (id: string, personId: string, { role }: { role: "admin" | "member" }) => {
      teams = teams.map((t) =>
        t.id === id ? { ...t, members: [...t.members.filter((m) => m.personId !== personId), { personId, role }] } : t,
      );
      return ok({ personId, role });
    }),
    removeTeamMember: vi.fn(async (id: string, personId: string) => {
      teams = teams.map((t) => (t.id === id ? { ...t, members: t.members.filter((m) => m.personId !== personId) } : t));
      return ok(undefined);
    }),
    ...overrides,
  } as unknown as ApiClient;
  const user = userEvent.setup();
  render(<TeamsScreen client={client} me={me} />);
  return { client, user };
}

const openTeam = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${name}\\b`) }));
  return screen.findByRole("region", { name: `Time ${name}` });
};

describe("TeamsScreen — lista", () => {
  it("mostra carregando e depois os times com número de membros", async () => {
    setup(meAsOrgAdmin());
    expect(screen.getByRole("status")).toHaveTextContent("Carregando times");
    expect(await screen.findByRole("button", { name: /^Alfa\b.*2 membros/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Beta\b.*0 membros/ })).toBeInTheDocument();
  });

  it("usa o singular para um membro", async () => {
    setup(meAsOrgAdmin(), [{ id: "t1", name: "Solo", members: [{ personId: "p-ana", role: "admin" }] }]);
    expect(await screen.findByRole("button", { name: /1 membro$/ })).toBeInTheDocument();
  });

  it("mostra erro com tentar de novo e se recupera", async () => {
    const listTeams = vi
      .fn()
      .mockResolvedValueOnce(failed("unavailable"))
      .mockResolvedValue(ok([alfa()]));
    const { user } = setup(meAsOrgAdmin(), [], { listTeams });
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível.");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("button", { name: /^Alfa\b/ })).toBeInTheDocument();
  });

  it("mostra mensagem de lista vazia", async () => {
    setup(meAsMember(), []);
    expect(await screen.findByText("Nenhum time cadastrado.")).toBeInTheDocument();
  });

  it("sem time aberto, orienta a escolher um", async () => {
    setup(meAsMember());
    await screen.findByRole("button", { name: /^Alfa\b/ });
    expect(screen.getByText("Escolha um time para ver os membros.")).toBeInTheDocument();
  });

  it("informa que convites são feitos no menu da organização", async () => {
    setup(meAsMember());
    expect(await screen.findByText(/menu da organização, no cabeçalho/)).toBeInTheDocument();
  });

  it("mostra erro ao carregar pessoas no time aberto, com nova tentativa", async () => {
    const listPeople = vi.fn().mockResolvedValueOnce(failed("unavailable")).mockResolvedValue(ok(PEOPLE));
    const { user } = setup(meAsMember(), [alfa()], { listPeople });
    await user.click(await screen.findByRole("button", { name: /^Alfa\b/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("API indisponível.");
    await user.click(within(alert).getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("ana@example.com")).toBeInTheDocument();
  });
});

describe("TeamsScreen — time aberto (somente leitura)", () => {
  it("membro comum vê nome, e-mail e papel, sem controles", async () => {
    const { user } = setup(meAsMember());
    const region = await openTeam(user, "Alfa");
    expect(within(region).getByText("Ana")).toBeInTheDocument();
    expect(within(region).getByText("ana@example.com")).toBeInTheDocument();
    expect(within(region).getByText("Administrador do time")).toBeInTheDocument();
    expect(within(region).getByText("Bia")).toBeInTheDocument();
    expect(within(region).getByText("Membro")).toBeInTheDocument();
    expect(within(region).queryByRole("combobox")).toBeNull();
    expect(within(region).queryByRole("textbox")).toBeNull();
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("não mostra criar time para quem não é administrador da organização", async () => {
    setup(meAsTeamAdmin());
    await screen.findByRole("button", { name: /^Alfa\b/ });
    expect(screen.queryByRole("textbox", { name: "Nome do novo time" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Criar time" })).toBeNull();
  });

  it("administrador de outro time não gere este", async () => {
    const { user } = setup(meAsTeamAdmin("t-beta"));
    const region = await openTeam(user, "Alfa");
    expect(within(region).queryByRole("button")).toBeNull();
    expect(within(region).queryByRole("textbox")).toBeNull();
  });

  it("mostra o id quando a pessoa não está na lista de pessoas", async () => {
    const { user } = setup(meAsMember(), [{ id: "t1", name: "Fantasma", members: [{ personId: "p-x", role: "member" }] }]);
    const region = await openTeam(user, "Fantasma");
    expect(within(region).getByText("p-x")).toBeInTheDocument();
  });
});

describe("TeamsScreen — criar time", () => {
  it("administrador da organização cria e o time fica aberto", async () => {
    const { client, user } = setup(meAsOrgAdmin());
    await user.type(await screen.findByRole("textbox", { name: "Nome do novo time" }), "Gama");
    await user.click(screen.getByRole("button", { name: "Criar time" }));
    expect(client.createTeam).toHaveBeenCalledWith({ name: "Gama" });
    expect(await screen.findByRole("region", { name: "Time Gama" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Gama\b/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Nome do novo time" })).toHaveValue("");
  });

  it("não envia nome vazio", async () => {
    const { client } = setup(meAsOrgAdmin());
    expect(await screen.findByRole("button", { name: "Criar time" })).toBeDisabled();
    expect(client.createTeam).not.toHaveBeenCalled();
  });

  it("team_name_taken aparece junto do campo e mantém o texto", async () => {
    const { user } = setup(meAsOrgAdmin(), [alfa()], { createTeam: vi.fn(async () => failed("conflict", "team_name_taken")) });
    const input = await screen.findByRole("textbox", { name: "Nome do novo time" });
    await user.type(input, "Alfa");
    await user.click(screen.getByRole("button", { name: "Criar time" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe um time com esse nome.");
    expect(input).toHaveValue("Alfa");
    expect(input).toHaveAccessibleDescription("Já existe um time com esse nome.");
  });

  it.each([
    ["en", "A team with that name already exists."],
    ["es-MX", "Ya existe un equipo con ese nombre."],
  ] as const)("team_name_taken aparece em %s", async (language, message) => {
    await setTestLanguage(language);
    const { user } = setup(meAsOrgAdmin(), [alfa()], { createTeam: vi.fn(async () => failed("conflict", "team_name_taken")) });
    const input = await screen.findByRole("textbox", { name: /./ });
    await user.type(input, "Alfa");
    await user.click(screen.getAllByRole("button").find((b) => !(b as HTMLButtonElement).disabled && /create|crear/i.test(b.textContent ?? ""))!);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("desabilita o botão enquanto envia", async () => {
    let release: (value: unknown) => void = () => {};
    const createTeam = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const { user } = setup(meAsOrgAdmin(), [alfa()], { createTeam });
    await user.type(await screen.findByRole("textbox", { name: "Nome do novo time" }), "Gama");
    await user.click(screen.getByRole("button", { name: "Criar time" }));
    expect(screen.getByRole("button", { name: "Criar time" })).toBeDisabled();
    release(failed("unavailable"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Criar time" })).toBeEnabled());
  });
});

describe("TeamsScreen — renomear", () => {
  it.each([
    ["administrador da organização", meAsOrgAdmin],
    ["administrador do time", meAsTeamAdmin],
  ])("%s renomeia e a lista reflete", async (_label, makeMeFor) => {
    const { client, user } = setup(makeMeFor());
    const region = await openTeam(user, "Alfa");
    const input = within(region).getByRole("textbox", { name: "Nome do time" });
    expect(input).toHaveValue("Alfa");
    await user.clear(input);
    await user.type(input, "Alfa 2");
    await user.click(within(region).getByRole("button", { name: "Renomear" }));
    expect(client.renameTeam).toHaveBeenCalledWith("t-alfa", { name: "Alfa 2" });
    expect(await screen.findByRole("button", { name: /^Alfa 2\b/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Time Alfa 2" })).toBeInTheDocument();
  });

  it("erro aparece junto do campo e preserva o texto", async () => {
    const { user } = setup(meAsOrgAdmin(), [alfa(), beta()], {
      renameTeam: vi.fn(async () => failed("conflict", "team_name_taken")),
    });
    const region = await openTeam(user, "Alfa");
    const input = within(region).getByRole("textbox", { name: "Nome do time" });
    await user.clear(input);
    await user.type(input, "Beta");
    await user.click(within(region).getByRole("button", { name: "Renomear" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Já existe um time com esse nome.");
    expect(input).toHaveValue("Beta");
  });

  it("só habilita Renomear quando o nome muda", async () => {
    const { user } = setup(meAsOrgAdmin());
    const region = await openTeam(user, "Alfa");
    expect(within(region).getByRole("button", { name: "Renomear" })).toBeDisabled();
  });
});

describe("TeamsScreen — remover time", () => {
  it("só administrador da organização vê Remover time", async () => {
    const { user } = setup(meAsTeamAdmin());
    const region = await openTeam(user, "Alfa");
    expect(within(region).queryByRole("button", { name: "Remover time" })).toBeNull();
  });

  it("pede confirmação, remove e volta para a lista sem time aberto", async () => {
    const { client, user } = setup(meAsOrgAdmin());
    const region = await openTeam(user, "Alfa");
    await user.click(within(region).getByRole("button", { name: "Remover time" }));
    expect(client.removeTeam).not.toHaveBeenCalled();
    await user.click(within(region).getByRole("button", { name: "Confirmar remoção do time" }));
    expect(client.removeTeam).toHaveBeenCalledWith("t-alfa");
    await waitFor(() => expect(screen.queryByRole("region", { name: "Time Alfa" })).toBeNull());
    expect(screen.queryByRole("button", { name: /^Alfa\b/ })).toBeNull();
    expect(screen.getByText("Escolha um time para ver os membros.")).toBeInTheDocument();
  });

  it("cancelar descarta a confirmação", async () => {
    const { client, user } = setup(meAsOrgAdmin());
    const region = await openTeam(user, "Alfa");
    await user.click(within(region).getByRole("button", { name: "Remover time" }));
    await user.click(within(region).getByRole("button", { name: "Cancelar" }));
    expect(within(region).getByRole("button", { name: "Remover time" })).toBeInTheDocument();
    expect(client.removeTeam).not.toHaveBeenCalled();
  });

  it("erro na remoção aparece e o time continua aberto", async () => {
    const { user } = setup(meAsOrgAdmin(), [alfa()], { removeTeam: vi.fn(async () => failed("forbidden")) });
    const region = await openTeam(user, "Alfa");
    await user.click(within(region).getByRole("button", { name: "Remover time" }));
    await user.click(within(region).getByRole("button", { name: "Confirmar remoção do time" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Você não tem permissão para fazer isso.");
    expect(screen.getByRole("region", { name: "Time Alfa" })).toBeInTheDocument();
  });
});

describe("TeamsScreen — membros", () => {
  it.each([
    ["administrador da organização", meAsOrgAdmin],
    ["administrador do time", meAsTeamAdmin],
  ])("%s altera o papel por um seletor", async (_label, makeMeFor) => {
    const { client, user } = setup(makeMeFor());
    const region = await openTeam(user, "Alfa");
    const select = within(region).getByRole("combobox", { name: "Papel de Bia" });
    expect(select).toHaveValue("member");
    await user.selectOptions(select, "admin");
    expect(client.putTeamMember).toHaveBeenCalledWith("t-alfa", "p-bia", { role: "admin" });
    await waitFor(() => expect(within(region).getByRole("combobox", { name: "Papel de Bia" })).toHaveValue("admin"));
  });

  it("erro ao alterar papel aparece e mantém o papel anterior", async () => {
    const { user } = setup(meAsOrgAdmin(), [alfa()], { putTeamMember: vi.fn(async () => failed("forbidden")) });
    const region = await openTeam(user, "Alfa");
    await user.selectOptions(within(region).getByRole("combobox", { name: "Papel de Bia" }), "admin");
    expect(await within(region).findByRole("alert")).toHaveTextContent("Você não tem permissão para fazer isso.");
    expect(within(region).getByRole("combobox", { name: "Papel de Bia" })).toHaveValue("member");
  });

  it("remove membro depois de confirmar", async () => {
    const { client, user } = setup(meAsTeamAdmin());
    const region = await openTeam(user, "Alfa");
    await user.click(within(region).getByRole("button", { name: "Remover Bia" }));
    expect(client.removeTeamMember).not.toHaveBeenCalled();
    await user.click(within(region).getByRole("button", { name: "Confirmar remoção de Bia" }));
    expect(client.removeTeamMember).toHaveBeenCalledWith("t-alfa", "p-bia");
    await waitFor(() => expect(within(region).queryByText("bia@example.com")).toBeNull());
    expect(await screen.findByRole("button", { name: /^Alfa\b.*1 membro$/ })).toBeInTheDocument();
  });

  it("cancelar a remoção de membro não chama a API", async () => {
    const { client, user } = setup(meAsOrgAdmin());
    const region = await openTeam(user, "Alfa");
    await user.click(within(region).getByRole("button", { name: "Remover Bia" }));
    await user.click(within(region).getByRole("button", { name: "Cancelar" }));
    expect(within(region).getByRole("button", { name: "Remover Bia" })).toBeInTheDocument();
    expect(client.removeTeamMember).not.toHaveBeenCalled();
  });

  it("erro ao remover membro aparece", async () => {
    const { user } = setup(meAsOrgAdmin(), [alfa()], { removeTeamMember: vi.fn(async () => failed("not_found")) });
    const region = await openTeam(user, "Alfa");
    await user.click(within(region).getByRole("button", { name: "Remover Bia" }));
    await user.click(within(region).getByRole("button", { name: "Confirmar remoção de Bia" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Não encontramos esse item.");
  });

  it("inclui pessoa que ainda não está no time, escolhendo o papel", async () => {
    const { client, user } = setup(meAsTeamAdmin());
    const region = await openTeam(user, "Alfa");
    const select = within(region).getByRole("combobox", { name: "Pessoa a incluir" });
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Escolha uma pessoa", "Caio"]); // sem Ana/Bia (já no time) e sem Duda (inativa)
    expect(within(region).getByRole("button", { name: "Incluir" })).toBeDisabled();
    await user.selectOptions(select, "p-caio");
    await user.selectOptions(within(region).getByRole("combobox", { name: "Papel da pessoa a incluir" }), "admin");
    await user.click(within(region).getByRole("button", { name: "Incluir" }));
    expect(client.putTeamMember).toHaveBeenCalledWith("t-alfa", "p-caio", { role: "admin" });
    expect(await within(region).findByText("caio@example.com")).toBeInTheDocument();
    // Caio era a única pessoa elegível: a inclusão some junto com ele.
    expect(within(region).queryByRole("combobox", { name: "Pessoa a incluir" })).toBeNull();
  });

  it("person_inactive vira mensagem junto da inclusão e preserva a escolha", async () => {
    const { user } = setup(meAsOrgAdmin(), [alfa()], {
      putTeamMember: vi.fn(async () => failed("conflict", "person_inactive")),
    });
    const region = await openTeam(user, "Alfa");
    const select = within(region).getByRole("combobox", { name: "Pessoa a incluir" });
    await user.selectOptions(select, "p-caio");
    await user.click(within(region).getByRole("button", { name: "Incluir" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("A pessoa não está mais na organização.");
    expect(select).toHaveValue("p-caio");
  });

  it("sem pessoas para incluir, avisa", async () => {
    const { user } = setup(meAsOrgAdmin(), [{ id: "t1", name: "Cheio", members: PEOPLE.filter((p) => p.active).map((p) => ({ personId: p.id, role: "member" as const })) }]);
    const region = await openTeam(user, "Cheio");
    expect(within(region).getByText("Todas as pessoas ativas da organização já estão neste time.")).toBeInTheDocument();
    expect(within(region).queryByRole("combobox", { name: "Pessoa a incluir" })).toBeNull();
  });
});

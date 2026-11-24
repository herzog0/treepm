import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, Person } from "../api/client.js";
import { ActAsProvider } from "../people/ActAs.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeMe, makePerson } from "../test/fakes.js";
import { SettingsScreen } from "./SettingsScreen.js";

const ana = makePerson("person-1", "Ana Admin", { clerkRole: "admin" });
const rafa = makePerson("p-rafa", "Rafael Moura", { active: false });
const bia = makePerson("p-bia", "Bia Nogueira", { isTest: true });
const cadu = makePerson("p-cadu", "Cadu Prado", { isTest: true, active: false });
const people: Person[] = [ana, makePerson("p-alice", "Alice Lima"), rafa, bia, cadu];

function setup(options: { me?: Me; list?: Person[] } = {}) {
  window.location.hash = "#pessoas";
  const me = options.me ?? makeMe({ clerk: "admin" });
  const client = makeClient({ me, people: options.list ?? people });
  vi.mocked(client.createTestPerson).mockResolvedValue({ ok: true, data: makePerson("p-new", "Nova", { isTest: true }) });
  vi.mocked(client.deactivateTestPerson).mockResolvedValue({ ok: true, data: { ...bia, active: false } });
  vi.mocked(client.reactivateTestPerson).mockResolvedValue({ ok: true, data: { ...cadu, active: true } });
  const user = userEvent.setup();
  render(
    <StrictMode>
      <MemoryPreferencesProvider onSave={vi.fn()}>
        <ActAsProvider>
          <SettingsScreen client={client} me={me} />
        </ActAsProvider>
      </MemoryPreferencesProvider>
    </StrictMode>,
  );
  return { client, user };
}

afterEach(() => {
  window.sessionStorage.clear();
  window.location.hash = "";
});

describe("seção Pessoas (ADR 0057)", () => {
  it("não aparece para quem não é administrador, nem para o administrador agindo como outra pessoa", () => {
    setup({ me: makeMe({ clerk: "member" }) });
    expect(screen.queryByRole("region", { name: "Pessoas" })).toBeNull();
  });
  it("não aparece enquanto se age como outra pessoa", () => {
    setup({ me: makeMe({ clerk: "admin", actingAs: "Ana" }) });
    expect(screen.queryByRole("region", { name: "Pessoas" })).toBeNull();
  });

  it("lista as pessoas em dois cartões; só as linhas de teste têm botões", async () => {
    setup();
    const region = await screen.findByRole("region", { name: "Pessoas" });
    const org = within(await within(region).findByRole("list", { name: "Pessoas da organização" }));
    expect(org.getAllByRole("listitem")).toHaveLength(3);
    expect(org.getByText("Alice Lima")).toBeInTheDocument();
    expect(org.getByText("inativa")).toBeInTheDocument();
    expect(org.queryAllByRole("button")).toHaveLength(0);
    const test = within(within(region).getByRole("list", { name: "Pessoas de teste" }));
    expect(test.getAllByText("teste")).toHaveLength(2);
    expect(test.getByRole("button", { name: "Entrar como Bia Nogueira" })).toBeInTheDocument();
    expect(test.getByRole("button", { name: "Desativar Bia Nogueira" })).toBeInTheDocument();
    // inativa: sem "Entrar como", com "Reativar"
    expect(test.queryByRole("button", { name: "Entrar como Cadu Prado" })).toBeNull();
    expect(test.getByRole("button", { name: "Reativar Cadu Prado" })).toBeInTheDocument();
    expect(within(region).getByText("1 de 20")).toBeInTheDocument();
  });

  it("cria uma pessoa de teste com o nome aparado e recarrega a lista", async () => {
    const { client, user } = setup();
    const region = await screen.findByRole("region", { name: "Pessoas" });
    await within(region).findByRole("list", { name: "Pessoas de teste" });
    const create = within(region).getByRole("button", { name: "Criar pessoa de teste" });
    expect(create).toBeDisabled();
    await user.type(within(region).getByRole("textbox", { name: "Nome da pessoa de teste" }), "  Dani  ");
    await user.click(create);
    await waitFor(() => expect(client.createTestPerson).toHaveBeenCalledWith("Dani"));
    await waitFor(() => expect(vi.mocked(client.listPeople).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("desativa e reativa", async () => {
    const { client, user } = setup();
    await user.click(await screen.findByRole("button", { name: "Desativar Bia Nogueira" }));
    await waitFor(() => expect(client.deactivateTestPerson).toHaveBeenCalledWith("p-bia"));
    await user.click(screen.getByRole("button", { name: "Reativar Cadu Prado" }));
    await waitFor(() => expect(client.reactivateTestPerson).toHaveBeenCalledWith("p-cadu"));
  });

  it("'Entrar como' guarda a escolha por aba e mostra a faixa; 'Voltar a ser eu' limpa", async () => {
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Entrar como Bia Nogueira" }));
    expect(JSON.parse(window.sessionStorage.getItem("treepm.actAs") ?? "null")).toEqual({ id: "p-bia", displayName: "Bia Nogueira" });
    expect(await screen.findByRole("status")).toHaveTextContent("Você está vendo como Bia Nogueira (teste)");
    await user.click(screen.getByRole("button", { name: "Voltar a ser eu" }));
    expect(window.sessionStorage.getItem("treepm.actAs")).toBeNull();
    expect(screen.queryByText(/Você está vendo como/)).toBeNull();
  });
});

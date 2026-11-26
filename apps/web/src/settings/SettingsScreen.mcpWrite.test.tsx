import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api/client.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { fakeToken, makeClient, makeMe, makeProject, makeToken } from "../test/fakes.js";
import type { FakeMcp } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { SettingsScreen } from "./SettingsScreen.js";

// ADR 0043, fatia 3: o alcance do token e a chave "Permitir escrita por MCP".
const projects = [makeProject("p1", "ALFA", "Alfa")];

/** A seção que `section()` consulta: as chaves da organização ("Clientes de IA (MCP)") ou os tokens da pessoa ("Seus tokens"). */
let at: "mcp" | "tokens" = "tokens";
function setup(options: { me?: Me; mcp?: FakeMcp; at?: "mcp" | "tokens" } = {}) {
  at = options.at ?? "tokens";
  window.location.hash = at;
  const me = options.me ?? makeMe({ mcp: true, mcpWrite: true });
  const client = makeClient({ me, projects, mcp: { secret: fakeToken("segredo"), ...options.mcp } });
  const user = userEvent.setup();
  render(
    <MemoryPreferencesProvider onSave={vi.fn()}>
      <SettingsScreen client={client} me={me} />
    </MemoryPreferencesProvider>,
  );
  return { client, user };
}
const section = () => screen.getByRole("region", { name: at === "mcp" ? "Clientes de IA (MCP)" : /^(Seus|Tus) tokens$/ });
const writeSwitch = () => within(section()).getByRole("switch", { name: "Permitir escrita por MCP" });
const scopeGroup = async () => within(await within(section()).findByRole("radiogroup", { name: "Alcance" }));

afterEach(async () => {
  window.location.hash = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  await setTestLanguage("pt-BR");
});

describe("Configurações › MCP: a chave de escrita", () => {
  it("shows an administrator the write switch below the access one, reflecting the state", () => {
    setup({ at: "mcp", me: makeMe({ mcp: true, mcpWrite: true }) });
    const access = within(section()).getByRole("switch", { name: "Permitir acesso por MCP" });
    expect(writeSwitch()).toBeChecked();
    expect(writeSwitch()).toBeEnabled();
    expect(access.compareDocumentPosition(writeSwitch()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("treats an API that does not report the write key as off", () => {
    setup({ at: "mcp", me: makeMe({ mcp: true }) });
    expect(writeSwitch()).not.toBeChecked();
  });

  it("disables the write switch while access is off", () => {
    setup({ at: "mcp", me: makeMe({ mcp: false, mcpWrite: true }) });
    expect(writeSwitch()).toBeDisabled();
  });

  it("does not show the write switch to someone who is not an administrator", () => {
    setup({ at: "mcp", me: makeMe({ mcp: true, mcpWrite: true, clerk: "member" }) });
    expect(within(section()).queryByRole("switch", { name: "Permitir escrita por MCP" })).not.toBeInTheDocument();
  });

  it("turns writing on through the client and shows the result", async () => {
    const { client, user } = setup({ at: "mcp", me: makeMe({ mcp: true, mcpWrite: false }) });
    await user.click(writeSwitch());
    await waitFor(() => expect(writeSwitch()).toBeChecked());
    expect(client.setMcpWriteEnabled).toHaveBeenCalledWith(true);
  });

  it("says so, and stays as it was, when the switch fails", async () => {
    const { user } = setup({ at: "mcp", me: makeMe({ mcp: true, mcpWrite: false }), mcp: { writeSwitchError: "unavailable" } });
    await user.click(writeSwitch());
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Não foi possível mudar a escrita por MCP");
    expect(writeSwitch()).not.toBeChecked();
  });

  it("no longer says that access is only for reading, without qualification", () => {
    setup({ at: "mcp", me: makeMe({ mcp: false }) });
    expect(within(section()).queryByText(/aos projetos que enxergam, só para leitura\.$/)).not.toBeInTheDocument();
    expect(within(section()).getByText(/Por padrão o acesso é só de leitura/)).toBeInTheDocument();
  });
});

describe("Configurações › MCP: o alcance do token", () => {
  it("offers 'Só leitura' as the default and 'Leitura e escrita', each with its sentence", async () => {
    const { user } = setup();
    const group = await scopeGroup();
    expect(group.getByRole("radio", { name: "Só leitura" })).toBeChecked();
    expect(within(section()).getByText(/consulta os tickets do projeto/)).toBeInTheDocument();
    await user.click(group.getByRole("radio", { name: "Leitura e escrita" }));
    expect(within(section()).getByText(/criar tickets, mudar a situação e a prioridade, editar título, descrição e prazo, mover tickets na árvore, mexer em dependências, sincronizar com o Linear, comentar e marcar trabalho em andamento, com as permissões da sua própria conta/)).toBeInTheDocument();
  });

  it("creates a read token without sending a scope, and a write token with it", async () => {
    const { client, user } = setup();
    const group = await scopeGroup();
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), "Leitor");
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    await waitFor(() => expect(client.createAccessToken).toHaveBeenCalledTimes(1));
    expect(client.createAccessToken).toHaveBeenLastCalledWith({ projectId: "p1", name: "Leitor", expiresInDays: 90 });
    await user.click(group.getByRole("radio", { name: "Leitura e escrita" }));
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), "Escritor");
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    await waitFor(() => expect(client.createAccessToken).toHaveBeenCalledTimes(2));
    expect(client.createAccessToken).toHaveBeenLastCalledWith({ projectId: "p1", name: "Escritor", expiresInDays: 90, scope: "write" });
  });

  it("keeps 'Leitura e escrita' available with the key off, warning that it only writes once an administrator turns it on", async () => {
    const { user } = setup({ me: makeMe({ mcp: true, mcpWrite: false }) });
    const group = await scopeGroup();
    expect(group.getByRole("radio", { name: "Leitura e escrita" })).toBeEnabled();
    expect(within(section()).queryByText(/só vai escrever quando um administrador ligar a chave/)).not.toBeInTheDocument();
    await user.click(group.getByRole("radio", { name: "Leitura e escrita" }));
    expect(within(section()).getByText(/só vai escrever quando um administrador ligar a chave/)).toBeInTheDocument();
  });

  it("gives no such warning with the key on", async () => {
    const { user } = setup({ me: makeMe({ mcp: true, mcpWrite: true }) });
    await user.click((await scopeGroup()).getByRole("radio", { name: "Leitura e escrita" }));
    expect(within(section()).queryByText(/só vai escrever quando um administrador ligar a chave/)).not.toBeInTheDocument();
  });

  it("shows each token's scope in the list; a token without the field counts as read", async () => {
    setup({ mcp: { tokens: [makeToken("a", "Escritor", { scope: "write" }), makeToken("b", "Leitor", { scope: "read" }), makeToken("c", "Antigo")] } });
    const list = await within(section()).findByRole("list", { name: "Seus tokens" });
    const scopeOf = (name: string) => (within(list).getByRole("heading", { name }).closest("li") as HTMLElement).querySelector(".mcp-token-scope")?.textContent;
    expect(scopeOf("Escritor")).toBe("Leitura e escrita");
    expect(scopeOf("Leitor")).toBe("Só leitura");
    expect(scopeOf("Antigo")).toBe("Só leitura");
  });

  it("speaks the other languages", async () => {
    await setTestLanguage("es-MX");
    setup({ at: "mcp" });
    expect(within(section()).getByRole("switch", { name: "Permitir escritura por MCP" })).toBeInTheDocument();
    cleanup();
    setup();
    expect(await within(section()).findByRole("radio", { name: "Lectura y escritura" })).toBeInTheDocument();
  });
});

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api/client.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { fakeToken, makeClient, makeMe, makeProject, makeToken } from "../test/fakes.js";
import type { FakeMcp } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { SettingsScreen } from "./SettingsScreen.js";

const projects = [
  makeProject("p0", "OLD", "Antigo", { archivedAt: "2026-10-01T00:00:00.000Z" }),
  makeProject("p1", "ALFA", "Alfa"),
  makeProject("p2", "BETA", "Beta"),
];
const past = "2026-01-01T00:00:00.000Z";
const SECRET = fakeToken("segredo");
const origin = window.location.origin;
const member = makeMe({ mcp: true, clerk: "member" });

/** A seção que `section()` consulta: a dos tokens da pessoa ("Seus tokens") ou a das chaves da organização ("Clientes de IA (MCP)"). */
let at: "mcp" | "tokens" = "tokens";
function setup(options: { me?: Me; mcp?: FakeMcp; at?: "mcp" | "tokens" } = {}) {
  at = options.at ?? "tokens";
  window.location.hash = at;
  const me = options.me ?? makeMe({ mcp: true });
  const client = makeClient({ me, projects, mcp: { secret: SECRET, ...options.mcp } });
  const user = userEvent.setup();
  render(
    <MemoryPreferencesProvider onSave={vi.fn()}>
      <SettingsScreen client={client} me={me} />
    </MemoryPreferencesProvider>,
  );
  return { client, user };
}
const section = () => screen.getByRole("region", { name: at === "mcp" ? "Clientes de IA (MCP)" : "Seus tokens" });
const nav = () => screen.getByRole("navigation", { name: "Seções das configurações" });
const ownList = () => within(section()).getByRole("list", { name: "Seus tokens" });
const orgList = () => within(section()).getByRole("list", { name: "Tokens da organização" });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Configurações › Clientes de IA (MCP): a chave", () => {
  it("is absent when the API does not report mcp", () => {
    const { client } = setup({ at: "mcp", me: makeMe() });
    expect(screen.queryByRole("region", { name: "Clientes de IA (MCP)" })).not.toBeInTheDocument();
    expect(client.listAccessTokens).not.toHaveBeenCalled();
  });

  it("shows an administrator only the switch, off, and nothing else, when the key is off", async () => {
    const { client } = setup({ at: "mcp", me: makeMe({ mcp: false }) });
    const toggle = within(section()).getByRole("switch", { name: "Permitir acesso por MCP" });
    expect(toggle).not.toBeChecked();
    expect(within(section()).getByText(/só de leitura/)).toBeInTheDocument();
    expect(within(section()).queryByRole("heading", { name: "Seus tokens" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("button", { name: "Criar token" })).not.toBeInTheDocument();
    expect(client.listAccessTokens).not.toHaveBeenCalled();
  });

  it("tells a non-administrator to ask for permission, with nothing else, when the key is off", () => {
    const { client } = setup({ at: "mcp", me: makeMe({ mcp: false, clerk: "member" }) });
    expect(within(section()).getByText("Um administrador da organização precisa permitir o acesso por MCP.")).toBeInTheDocument();
    expect(within(section()).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(section()).queryByRole("heading", { name: "Seus tokens" })).not.toBeInTheDocument();
    expect(client.listAccessTokens).not.toHaveBeenCalled();
  });

  it("turns the key on right away and loads the tokens", async () => {
    const { client, user } = setup({ at: "mcp", me: makeMe({ mcp: false }), mcp: { enabled: false } });
    await user.click(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" }));
    expect(client.setMcpEnabled).toHaveBeenCalledWith(true);
    expect(await within(section()).findByText("Nenhum token na organização.")).toBeInTheDocument();
    expect(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" })).toBeChecked();
  });

  it("turns the key off and hides the token lists", async () => {
    const { client, user } = setup({ at: "mcp", mcp: { tokens: [makeToken("a", "Notebook")] } });
    expect((await within(section()).findAllByText("Notebook"))[0]).toBeInTheDocument();
    await user.click(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" }));
    expect(client.setMcpEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(within(section()).queryAllByText("Notebook")).toHaveLength(0));
    expect(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" })).not.toBeChecked();
    // A lista da própria pessoa e o formulário de criar token também somem (estão em "Seus tokens").
    await user.click(within(nav()).getByRole("link", { name: "Seus tokens" }));
    at = "tokens";
    expect(await within(section()).findByText(/O acesso por MCP está desligado/)).toBeInTheDocument();
    expect(within(section()).queryByText("Notebook")).not.toBeInTheDocument();
    expect(within(section()).queryByRole("list", { name: "Seus tokens" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("button", { name: "Criar token" })).not.toBeInTheDocument();
  });

  it("puts the switch back and shows the section error when saving fails", async () => {
    const { client, user } = setup({ at: "mcp", me: makeMe({ mcp: false }), mcp: { enabled: false, switchError: "unavailable" } });
    await user.click(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Não foi possível mudar o acesso por MCP. Tente de novo.");
    expect(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" })).not.toBeChecked();
    expect(within(section()).queryByRole("heading", { name: "Seus tokens" })).not.toBeInTheDocument();
    expect(client.listAccessTokens).not.toHaveBeenCalled();
  });
});

describe("Configurações › Seus tokens e Como ligar um cliente: a divisão em seções", () => {
  it("with the key off, Seus tokens says so to an administrator and calls nothing", () => {
    const { client } = setup({ me: makeMe({ mcp: false }) });
    expect(within(section()).getByText(/Ligue-o em Clientes de IA \(MCP\)/)).toBeInTheDocument();
    expect(within(section()).queryByRole("button", { name: "Criar token" })).not.toBeInTheDocument();
    expect(client.listAccessTokens).not.toHaveBeenCalled();
  });

  it("with the key off, Seus tokens tells a member to ask an administrator", () => {
    setup({ me: makeMe({ mcp: false, clerk: "member" }) });
    expect(within(section()).getByText("Um administrador da organização precisa permitir o acesso por MCP.")).toBeInTheDocument();
  });

  it("shows the connect card with the key on, whose button opens Seus tokens", async () => {
    const { user } = setup({ at: "mcp" });
    const card = await within(section()).findByRole("heading", { name: "Como ligar um cliente" });
    expect(card).toBeInTheDocument();
    await user.click(within(section()).getByRole("button", { name: "Ir para Seus tokens" }));
    expect(await screen.findByRole("region", { name: "Seus tokens" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#tokens");
  });

  it("does not show the connect card with the key off", () => {
    setup({ at: "mcp", me: makeMe({ mcp: false }) });
    expect(within(section()).queryByRole("heading", { name: "Como ligar um cliente" })).not.toBeInTheDocument();
  });

  it("keeps the switches when going to Seus tokens and back (the state lives in the page)", async () => {
    const { user } = setup({ at: "mcp", me: makeMe({ mcp: false }), mcp: { enabled: false } });
    await user.click(within(section()).getByRole("switch", { name: "Permitir acesso por MCP" }));
    await within(section()).findByRole("heading", { name: "Como ligar um cliente" });
    await user.click(within(screen.getByRole("navigation", { name: "Seções das configurações" })).getByRole("link", { name: "Seus tokens" }));
    expect(await screen.findByRole("button", { name: "Criar token" })).toBeInTheDocument();
  });
});

describe("Configurações › Clientes de IA (MCP): a lista", () => {
  it("shows an empty sentence when the person has no tokens", async () => {
    setup();
    expect(await within(section()).findByText("Você ainda não criou nenhum token.")).toBeInTheDocument();
  });

  it("shows name, project, prefix, dates, last use and status, with active tokens first and the others dimmed and without actions", async () => {
    setup({ me: member,
      mcp: {
        tokens: [
          makeToken("rev", "Revogado", { createdAt: "2026-11-19T12:00:00.000Z", revokedAt: "2026-11-20T12:00:00.000Z" }),
          makeToken("old", "Antigo", { createdAt: "2026-11-01T12:00:00.000Z", expiresAt: past }),
          makeToken("a", "Notebook", { createdAt: "2026-11-10T12:00:00.000Z", tokenPrefix: "abcd1234", lastUsedAt: "2026-11-15T12:00:00.000Z", expiresAt: "2027-02-08T12:00:00.000Z" }),
          makeToken("b", "Desktop", { createdAt: "2026-11-18T12:00:00.000Z" }),
          makeToken("other", "De outra pessoa", { person: { id: "person-2", displayName: "Bia" } }),
        ],
      },
    });
    await within(section()).findByText("Notebook");
    const items = within(ownList()).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("heading", { level: 4 }).textContent)).toEqual(["Desktop", "Notebook", "Revogado", "Antigo"]);
    expect(within(section()).queryByText("De outra pessoa")).not.toBeInTheDocument();

    const notebook = items[1]!;
    expect(within(notebook).getByText("ALFA")).toBeInTheDocument();
    expect(within(notebook).getByText("…abcd1234…").tagName).toBe("CODE");
    expect(within(notebook).getByText("10 de novembro de 2026")).toBeInTheDocument();
    expect(within(notebook).getByText("15 de novembro de 2026")).toBeInTheDocument();
    expect(within(notebook).getByText("8 de fevereiro de 2027")).toBeInTheDocument();
    expect(within(notebook).getByText("Ativo")).toBeInTheDocument();
    expect(within(notebook).getByRole("button", { name: "Revogar Notebook" })).toBeInTheDocument();

    expect(within(items[0]!).getByText("nunca")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Revogado", { selector: ".mcp-token-status" })).toBeInTheDocument();
    expect(within(items[3]!).getByText("Vencido")).toBeInTheDocument();
    for (const dimmed of [items[2]!, items[3]!]) {
      expect(dimmed).toHaveClass("mcp-token-inactive");
      expect(within(dimmed).queryByRole("button")).not.toBeInTheDocument();
    }
    expect(within(section()).queryByRole("list", { name: "Tokens da organização" })).not.toBeInTheDocument();
  });

  it("revokes a token only after the second step, and cancelling keeps it", async () => {
    const { client, user } = setup({ me: member, mcp: { tokens: [makeToken("a", "Notebook")] } });
    await user.click(await within(section()).findByRole("button", { name: "Revogar Notebook" }));
    expect(client.revokeAccessToken).not.toHaveBeenCalled();
    expect(within(section()).getByText("O cliente que usa este token perde o acesso na hora.")).toBeInTheDocument();
    await user.click(within(section()).getByRole("button", { name: "Cancelar" }));
    expect(client.revokeAccessToken).not.toHaveBeenCalled();
    await user.click(within(section()).getByRole("button", { name: "Revogar Notebook" }));
    await user.click(within(section()).getByRole("button", { name: "Confirmar: Revogar Notebook" }));
    expect(client.revokeAccessToken).toHaveBeenCalledWith("a");
    await waitFor(() => expect(within(ownList()).queryByRole("button", { name: /Revogar/ })).not.toBeInTheDocument());
    expect(within(ownList()).getByText("Revogado", { selector: ".mcp-token-status" })).toBeInTheDocument();
  });

  it("shows the revoke error in the section", async () => {
    const { client, user } = setup({ me: member, mcp: { tokens: [makeToken("a", "Notebook")] } });
    await user.click(await within(section()).findByRole("button", { name: "Revogar Notebook" }));
    vi.mocked(client.revokeAccessToken).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } });
    await user.click(within(section()).getByRole("button", { name: "Confirmar: Revogar Notebook" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("A API está indisponível.");
    expect(within(section()).getByRole("button", { name: "Revogar Notebook" })).toBeInTheDocument();
  });

  it("shows a load error with retry when the list cannot be read", async () => {
    const me = member;
    window.location.hash = "tokens";
    const client = makeClient({ me, projects, mcp: { tokens: [makeToken("a", "Notebook")] } });
    vi.mocked(client.listAccessTokens).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } });
    render(<MemoryPreferencesProvider onSave={vi.fn()}><SettingsScreen client={client} me={me} /></MemoryPreferencesProvider>);
    expect(await within(section()).findByRole("alert")).toHaveTextContent("API indisponível.");
    await userEvent.click(within(section()).getByRole("button", { name: "Tentar novamente" }));
    expect(await within(section()).findByText("Notebook")).toBeInTheDocument();
  });
});

describe("Configurações › Clientes de IA (MCP): tokens da organização", () => {
  const tokens = [
    makeToken("mine", "Meu notebook"),
    makeToken("bia", "Servidor da Bia", { person: { id: "person-2", displayName: "Bia" }, createdAt: "2026-11-12T12:00:00.000Z" }),
    makeToken("biaold", "Antigo da Bia", { person: { id: "person-2", displayName: "Bia" }, expiresAt: past }),
  ];

  it("shows an administrator everyone's tokens with the person, the own ones in both lists", async () => {
    const { user } = setup({ at: "mcp", mcp: { tokens } });
    await within(section()).findByRole("list", { name: "Tokens da organização" });
    const items = within(orgList()).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(orgList()).getAllByText("Bia", { selector: ".mcp-token-person" })).toHaveLength(2);
    expect(within(orgList()).getByText("Meu notebook")).toBeInTheDocument();
    // A lista da própria pessoa fica em outra seção.
    await user.click(within(screen.getByRole("navigation", { name: "Seções das configurações" })).getByRole("link", { name: "Seus tokens" }));
    at = "tokens";
    await within(section()).findByRole("list", { name: "Seus tokens" });
    expect(within(ownList()).getByText("Meu notebook")).toBeInTheDocument();
    expect(within(ownList()).queryByText("Servidor da Bia")).not.toBeInTheDocument();
  });

  it("lets an administrator revoke another person's active token in two steps, never an inactive one", async () => {
    const { client, user } = setup({ at: "mcp", mcp: { tokens } });
    await within(section()).findByRole("list", { name: "Tokens da organização" });
    expect(within(orgList()).queryByRole("button", { name: "Revogar Antigo da Bia" })).not.toBeInTheDocument();
    await user.click(within(orgList()).getByRole("button", { name: "Revogar Servidor da Bia" }));
    expect(client.revokeAccessToken).not.toHaveBeenCalled();
    await user.click(within(orgList()).getByRole("button", { name: "Confirmar: Revogar Servidor da Bia" }));
    expect(client.revokeAccessToken).toHaveBeenCalledWith("bia");
    await waitFor(() => expect(within(orgList()).queryByRole("button", { name: "Revogar Servidor da Bia" })).not.toBeInTheDocument());
  });

  it("does not show the organization list to a member, nor ask for it", async () => {
    const { client } = setup({ at: "mcp", me: makeMe({ mcp: true, clerk: "member" }), mcp: { tokens } });
    await within(section()).findByRole("button", { name: "Ir para Seus tokens" });
    expect(within(section()).queryByRole("list", { name: "Tokens da organização" })).not.toBeInTheDocument();
    expect(within(section()).queryByRole("switch")).not.toBeInTheDocument();
    expect(client.listOrganizationAccessTokens).not.toHaveBeenCalled();
  });

  it("shows an empty sentence for the organization", async () => {
    setup({ at: "mcp", mcp: { tokens: [] } });
    expect(await within(section()).findByText("Nenhum token na organização.")).toBeInTheDocument();
  });
});

describe("Configurações › Clientes de IA (MCP): criar token", () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, name = "Notebook") {
    await within(section()).findByRole("button", { name: "Criar token" });
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), name);
  }

  it("lists the projects with the non-archived first, with 90 days preselected and the name required", async () => {
    const { user } = setup();
    await within(section()).findByRole("button", { name: "Criar token" });
    await waitFor(() => expect(within(section()).getAllByRole("option")).toHaveLength(3));
    expect(within(section()).getAllByRole("option").map((option) => option.textContent)).toEqual(["ALFA · Alfa", "BETA · Beta", "OLD · Antigo (arquivado)"]);
    expect(within(section()).getByRole("radio", { name: "90 dias" })).toBeChecked();
    expect(within(section()).getByRole("radio", { name: "30 dias" })).not.toBeChecked();
    expect(within(section()).getByRole("radio", { name: "365 dias" })).not.toBeChecked();
    expect(within(section()).getByRole("textbox", { name: "Nome" })).toHaveAttribute("maxlength", "80");
    expect(within(section()).getByRole("button", { name: "Criar token" })).toBeDisabled();
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), "   ");
    expect(within(section()).getByRole("button", { name: "Criar token" })).toBeDisabled();
  });

  it.each([[30, "30 dias"], [90, "90 dias"], [365, "365 dias"]] as const)("creates with %i days", async (days, label) => {
    const { client, user } = setup();
    await fill(user, " Notebook ");
    await waitFor(() => expect(within(section()).getAllByRole("option")).toHaveLength(3));
    await user.selectOptions(within(section()).getByRole("combobox", { name: "Projeto" }), "BETA · Beta");
    await user.click(within(section()).getByRole("radio", { name: label }));
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    expect(client.createAccessToken).toHaveBeenCalledWith({ projectId: "p2", name: "Notebook", expiresInDays: days });
  });

  it("creates tokens in the real format: tpm_<organization>_<43-character secret>, listed as …<first 8 of the secret>…", async () => {
    const { user } = setup({ mcp: { secret: undefined as unknown as string } });
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    const token = fakeToken("new1");
    expect(token).toMatch(/^tpm_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/);
    expect(within(panel).getByText(token)).toBeInTheDocument();
    expect(await within(ownList()).findByText(`…${token.slice(-43).slice(0, 8)}…`)).toBeInTheDocument();
  });

  it("shows the token once, with the warning, and it is gone when the panel is closed", async () => {
    const { user } = setup();
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    expect(within(panel).getByText(SECRET)).toBeInTheDocument();
    expect(within(panel).getByText("Copie o token agora: ele não será mostrado de novo.")).toBeInTheDocument();
    expect(within(panel).getAllByRole("status")[0]).toHaveTextContent("Copie o token agora");
    // A lista recarregada mostra só o começo do token.
    await waitFor(() => expect(within(ownList()).getByText("Notebook")).toBeInTheDocument());
    expect(within(ownList()).queryByText(SECRET)).not.toBeInTheDocument();
    expect(within(section()).getByRole("textbox", { name: "Nome" })).toHaveValue("");

    await user.click(within(panel).getByRole("button", { name: "Fechar" }));
    expect(within(section()).queryByRole("region", { name: "Token criado" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("shows the three snippets with the address and the token filled in", async () => {
    const { user } = setup();
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    const url = `${origin}/api/mcp/ALFA`;

    const tabs = within(panel).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Claude Code", "Cursor", "Codex"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByRole("tabpanel")).toHaveTextContent(`claude mcp add --transport http treepm-alfa ${url} --header "Authorization: Bearer ${SECRET}"`);

    await user.click(within(panel).getByRole("tab", { name: "Cursor" }));
    const cursor = JSON.parse(within(panel).getByRole("tabpanel").querySelector("code")!.textContent!) as unknown;
    expect(cursor).toEqual({ mcpServers: { "treepm-alfa": { url, headers: { Authorization: `Bearer ${SECRET}` } } } });

    await user.click(within(panel).getByRole("tab", { name: "Codex" }));
    const codex = within(panel).getByRole("tabpanel");
    expect(codex).toHaveTextContent("[mcp_servers.treepm-alfa]");
    expect(codex).toHaveTextContent(`url = "${url}"`);
    expect(codex).toHaveTextContent('bearer_token_env_var = "TREEPM_MCP_TOKEN"');
    expect(codex).toHaveTextContent(`export TREEPM_MCP_TOKEN="${SECRET}"`);
    expect(codex.textContent).not.toContain(`Bearer ${SECRET}`);
  });

  it("moves between the tabs with the arrow keys", async () => {
    const { user } = setup();
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    within(panel).getByRole("tab", { name: "Claude Code" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(within(panel).getByRole("tab", { name: "Cursor" })).toHaveAttribute("aria-selected", "true");
    expect(within(panel).getByRole("tab", { name: "Cursor" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(panel).getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");
  });

  it("copies the token and each snippet, and says so in a live region", async () => {
    const { user } = setup();
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    const live = within(panel).getAllByRole("status")[1]!;

    await user.click(within(panel).getByRole("button", { name: "Copiar token" }));
    expect(await navigator.clipboard.readText()).toBe(SECRET);
    expect(live).toHaveTextContent("Copiado");

    await user.click(within(panel).getByRole("button", { name: "Copiar comando" }));
    expect(await navigator.clipboard.readText()).toBe(`claude mcp add --transport http treepm-alfa ${origin}/api/mcp/ALFA --header "Authorization: Bearer ${SECRET}"`);

    await user.click(within(panel).getByRole("tab", { name: "Codex" }));
    await user.click(within(panel).getByRole("button", { name: "Copiar variável" }));
    expect(await navigator.clipboard.readText()).toBe(`export TREEPM_MCP_TOKEN="${SECRET}"`);
    await user.click(within(panel).getByRole("button", { name: "Copiar config.toml" }));
    expect(await navigator.clipboard.readText()).toBe(`[mcp_servers.treepm-alfa]\nurl = "${origin}/api/mcp/ALFA"\nbearer_token_env_var = "TREEPM_MCP_TOKEN"`);
  });

  it("says when the browser refuses to copy", async () => {
    const { user } = setup();
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("negado"));
    await user.click(within(panel).getByRole("button", { name: "Copiar token" }));
    expect(await within(panel).findByText("Não foi possível copiar. Selecione o texto e copie à mão.")).toBeInTheDocument();
  });

  it("never writes the token to localStorage, sessionStorage, the URL or the console", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { user } = setup();
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const panel = await within(section()).findByRole("region", { name: "Token criado" });
    await user.click(within(panel).getByRole("button", { name: "Copiar token" }));
    for (const store of [window.localStorage, window.sessionStorage]) {
      expect(JSON.stringify({ ...store })).not.toContain("tpm_");
      expect(store.length).toBe(0);
    }
    expect(window.location.href).not.toContain("tpm_");
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain("tpm_");
    consoleSpies.forEach((spy) => spy.mockRestore());
  });

  it("drops the previous token from the screen when a new one is created", async () => {
    const { user } = setup({ mcp: { secret: undefined as unknown as string } });
    await fill(user, "Primeiro");
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    await within(section()).findByText(fakeToken("new1"));
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), "Segundo");
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    await within(section()).findByText(fakeToken("new2"));
    expect(within(section()).queryByText(fakeToken("new1"))).not.toBeInTheDocument();
  });

  it("shows the limit error with its own message and keeps the form", async () => {
    const { user } = setup({ mcp: { createError: ["conflict", "access_token_limit"] } });
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Você já tem 10 tokens ativos. Revogue algum antes de criar outro.");
    expect(within(section()).getByRole("textbox", { name: "Nome" })).toHaveValue("Notebook");
    expect(within(section()).queryByRole("region", { name: "Token criado" })).not.toBeInTheDocument();
  });

  it("goes back to the off state when the key was turned off meanwhile", async () => {
    const { user } = setup({ mcp: { createError: ["forbidden", "mcp_disabled"] } });
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    expect(await within(section()).findByText(/O acesso por MCP está desligado/)).toBeInTheDocument();
    expect(within(section()).queryByRole("button", { name: "Criar token" })).not.toBeInTheDocument();
    expect(within(section()).getByRole("alert")).toHaveTextContent("O acesso por MCP foi desligado.");
    // A chave volta a aparecer desligada na seção das chaves.
    await user.click(within(nav()).getByRole("link", { name: /^Clientes de IA/ }));
    at = "mcp";
    expect(await within(section()).findByRole("switch", { name: "Permitir acesso por MCP" })).not.toBeChecked();
  });

  it("shows a message when the project is gone", async () => {
    const { user } = setup({ mcp: { createError: ["not_found"] } });
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("O projeto não existe mais ou você não o enxerga.");
  });

  it("shows a generic error for other failures", async () => {
    const { user } = setup({ mcp: { createError: ["unavailable"] } });
    await fill(user);
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("A API está indisponível.");
  });

  it("does not offer to create a token when the person sees no project", async () => {
    const me = makeMe({ mcp: true });
    window.location.hash = "tokens";
    const client = makeClient({ me, projects: [], mcp: {} });
    render(<MemoryPreferencesProvider onSave={vi.fn()}><SettingsScreen client={client} me={me} /></MemoryPreferencesProvider>);
    expect(await within(section()).findByText("Você ainda não vê nenhum projeto para ligar a um token.")).toBeInTheDocument();
    expect(within(section()).queryByRole("button", { name: "Criar token" })).not.toBeInTheDocument();
  });
});


describe("Configurações › Clientes de IA (MCP): idiomas", () => {
  it.each([
    ["en", "AI clients (MCP)", "Allow MCP access", "Create token", "Your tokens"],
    ["es-MX", "Clientes de IA (MCP)", "Permitir acceso por MCP", "Crear token", "Tus tokens"],
  ] as const)("renders in %s", async (language, title, switchLabel, create, yourTokens) => {
    await setTestLanguage(language);
    setup({ at: "mcp" });
    const region = await screen.findByRole("region", { name: title });
    expect(within(region).getByRole("switch", { name: switchLabel })).toBeChecked();
    act(() => {
      window.location.hash = "tokens";
    });
    const tokens = await screen.findByRole("region", { name: yourTokens });
    expect(await within(tokens).findByRole("button", { name: create })).toBeInTheDocument();
  });
});

describe("Configurações › o que sobrevive à troca de seção", () => {
  const goTo = async (user: ReturnType<typeof userEvent.setup>, name: string | RegExp, to: "mcp" | "tokens") => {
    await user.click(within(nav()).getByRole("link", { name }));
    at = to;
  };

  it("o token recém-criado continua na tela depois de ir a Clientes de IA e voltar; só \"Fechar\" o tira", async () => {
    const { user } = setup({ mcp: { secret: undefined as unknown as string } });
    await within(section()).findByRole("button", { name: "Criar token" });
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), "Notebook");
    await user.click(within(section()).getByRole("button", { name: "Criar token" }));
    const token = fakeToken("new1");
    expect(await within(section()).findByText(token)).toBeInTheDocument();

    await goTo(user, /^Clientes de IA/, "mcp");
    await within(section()).findByRole("switch", { name: "Permitir acesso por MCP" });
    await goTo(user, "Seus tokens", "tokens");
    expect(await within(section()).findByText(token)).toBeInTheDocument();
    expect(within(section()).getByRole("region", { name: "Token criado" })).toBeInTheDocument();

    await user.click(within(section()).getByRole("button", { name: "Fechar" }));
    expect(within(section()).queryByText(token)).not.toBeInTheDocument();
    await goTo(user, /^Clientes de IA/, "mcp");
    await goTo(user, "Seus tokens", "tokens");
    expect(within(section()).queryByRole("region", { name: "Token criado" })).not.toBeInTheDocument();
  });

  it("o formulário de criar token pela metade continua depois de trocar de seção", async () => {
    const { user } = setup();
    await within(section()).findByRole("button", { name: "Criar token" });
    await waitFor(() => expect(within(section()).getAllByRole("option")).toHaveLength(3));
    await user.type(within(section()).getByRole("textbox", { name: "Nome" }), "Pela metade");
    await user.selectOptions(within(section()).getByRole("combobox", { name: "Projeto" }), "BETA · Beta");
    await user.click(within(section()).getByRole("radio", { name: "365 dias" }));
    await user.click(within(section()).getByRole("radio", { name: "Leitura e escrita" }));

    await goTo(user, /^Clientes de IA/, "mcp");
    await within(section()).findByRole("switch", { name: "Permitir acesso por MCP" });
    await goTo(user, "Seus tokens", "tokens");
    await within(section()).findByRole("button", { name: "Criar token" });
    expect(within(section()).getByRole("textbox", { name: "Nome" })).toHaveValue("Pela metade");
    expect(within(section()).getByRole("combobox", { name: "Projeto" })).toHaveValue("p2");
    expect(within(section()).getByRole("radio", { name: "365 dias" })).toBeChecked();
    expect(within(section()).getByRole("radio", { name: "Leitura e escrita" })).toBeChecked();
  });

  it("o erro de gravar a chave aparece também em Seus tokens se a pessoa trocou de seção durante a gravação", async () => {
    const { client, user } = setup({ at: "mcp", mcp: { enabled: true } });
    await within(section()).findByRole("switch", { name: "Permitir acesso por MCP" });
    let fail!: () => void;
    vi.mocked(client.setMcpWriteEnabled).mockImplementationOnce(() => new Promise((resolve) => { fail = () => resolve({ ok: false, error: { kind: "unavailable" } }); }));
    await user.click(within(section()).getByRole("switch", { name: "Permitir escrita por MCP" }));
    await goTo(user, "Seus tokens", "tokens");
    await within(section()).findByRole("button", { name: "Criar token" });
    await act(async () => fail());
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Não foi possível mudar a escrita por MCP. Tente de novo.");
  });

  it("o membro com o acesso ligado vê uma linha com o estado, não um cartão vazio", async () => {
    setup({ at: "mcp", me: makeMe({ mcp: true, clerk: "member" }), mcp: { writeEnabled: false } });
    expect(await within(section()).findByText("O acesso por MCP está ligado; a escrita está desligada.")).toBeInTheDocument();
    expect(within(section()).queryByRole("heading", { name: "Acesso" })).not.toBeInTheDocument();
  });

  it("o membro vê que a escrita está ligada", async () => {
    setup({ at: "mcp", me: makeMe({ mcp: true, mcpWrite: true, clerk: "member" }), mcp: { writeEnabled: true } });
    expect(await within(section()).findByText("O acesso por MCP está ligado; a escrita está ligada.")).toBeInTheDocument();
  });
});

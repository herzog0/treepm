import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api/client.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeInstallation, makeMe } from "../test/fakes.js";
import type { FakeGithub } from "../test/fakes.js";
import { SettingsScreen } from "./SettingsScreen.js";

const assign = vi.fn();
const originalLocation = window.location;

function setup(options: { me?: Me; github?: FakeGithub | undefined } = {}) {
  const me = options.me ?? makeMe({ github: true });
  const client = makeClient({ me, ...(options.github ? { github: options.github } : {}) });
  render(
    <MemoryPreferencesProvider onSave={vi.fn()}>
      <SettingsScreen client={client} me={me} />
    </MemoryPreferencesProvider>,
  );
  return { client };
}
const section = () => screen.getByRole("region", { name: "GitHub" });

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  assign.mockReset();
});

describe("Configurações › GitHub", () => {
  it("shows nothing and calls nothing when GitHub is disabled", async () => {
    const { client } = setup({ me: makeMe({ github: false }), github: { enabled: false } });
    expect(screen.queryByRole("heading", { name: "GitHub" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Câmera" })).toBeInTheDocument();
    expect(client.getGithubInstallation).not.toHaveBeenCalled();
  });

  it("treats a /api/me without the github field as disabled", () => {
    const { client } = setup({ me: makeMe() });
    expect(screen.queryByRole("heading", { name: "GitHub" })).not.toBeInTheDocument();
    expect(client.getGithubInstallation).not.toHaveBeenCalled();
  });

  it("offers an administrator to connect when the organization is not linked", async () => {
    setup({ github: { installation: null } });
    expect(await screen.findByText("A organização não está ligada ao GitHub.")).toBeInTheDocument();
    expect(within(section()).getByRole("button", { name: "Conectar GitHub" })).toBeInTheDocument();
    expect(within(section()).getByText("O TreePM só lê: nomes de repositórios, branches e pull requests. Nenhum código é copiado.")).toBeInTheDocument();
  });

  it("tells a non-administrator to ask for one, with no button", async () => {
    setup({ me: makeMe({ github: true, clerk: "member" }), github: { installation: null } });
    expect(await screen.findByText("Peça a um administrador da organização para conectar.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conectar GitHub" })).not.toBeInTheDocument();
  });

  it("starts the connection and sends the browser to the returned URL", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    const { client } = setup({ github: { installation: null, connectUrl: "https://github.com/apps/x/installations/new?state=s1" } });
    await userEvent.click(await screen.findByRole("button", { name: "Conectar GitHub" }));
    expect(client.connectGithub).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://github.com/apps/x/installations/new?state=s1");
  });

  it("shows the connect error next to the button and does not navigate", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    const { client } = setup({ github: { installation: null } });
    vi.mocked(client.connectGithub).mockResolvedValue({ ok: false, error: { kind: "forbidden" } });
    await userEvent.click(await screen.findByRole("button", { name: "Conectar GitHub" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não tem permissão para fazer isso.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows the linked account and date", async () => {
    setup({ github: { installation: makeInstallation({ accountLogin: "herzog0", connectedAt: "2026-11-20T15:00:00.000Z" }) } });
    expect(await screen.findByText("Ligada à conta herzog0 desde 20 de novembro de 2026.")).toBeInTheDocument();
    expect(screen.queryByText(/só os repositórios escolhidos/)).not.toBeInTheDocument();
    expect(screen.queryByText("A organização não está ligada ao GitHub.")).not.toBeInTheDocument();
  });

  it("says the app sees only the chosen repositories when the selection is 'selected'", async () => {
    setup({ github: { installation: makeInstallation({ repositorySelection: "selected" }) } });
    expect(await screen.findByText("O app vê só os repositórios escolhidos na instalação.")).toBeInTheDocument();
  });

  it("lets an administrator disconnect only after a confirmation that explains the effect", async () => {
    const { client } = setup({ github: { installation: makeInstallation() } });
    await userEvent.click(await screen.findByRole("button", { name: "Desconectar" }));
    expect(client.disconnectGithub).not.toHaveBeenCalled();
    expect(
      screen.getByText("Os repositórios ligados aos projetos e os vínculos de código dos tickets serão removidos do TreePM. O app continua instalado no GitHub até você removê-lo lá."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar: Desconectar" }));
    expect(client.disconnectGithub).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("A organização não está ligada ao GitHub.")).toBeInTheDocument();
  });

  it("cancelling the confirmation keeps the connection", async () => {
    const { client } = setup({ github: { installation: makeInstallation() } });
    await userEvent.click(await screen.findByRole("button", { name: "Desconectar" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(client.disconnectGithub).not.toHaveBeenCalled();
    expect(screen.getByText(/Ligada à conta/)).toBeInTheDocument();
  });

  it("hides Desconectar from a non-administrator", async () => {
    setup({ me: makeMe({ github: true, clerk: "member" }), github: { installation: makeInstallation() } });
    expect(await screen.findByText(/Ligada à conta/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desconectar" })).not.toBeInTheDocument();
  });

  it("shows a load error with retry when the installation cannot be read", async () => {
    const me = makeMe({ github: true });
    const client = makeClient({ me, github: { installation: makeInstallation() } });
    vi.mocked(client.getGithubInstallation).mockResolvedValueOnce({ ok: false, error: { kind: "unavailable" } });
    render(<MemoryPreferencesProvider onSave={vi.fn()}><SettingsScreen client={client} me={me} /></MemoryPreferencesProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível.");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText(/Ligada à conta/)).toBeInTheDocument();
  });
});

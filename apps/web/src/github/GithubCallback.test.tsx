import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeClient, makeInstallation, makeMe } from "../test/fakes.js";
import { GithubCallback } from "./GithubCallback.js";

const arrive = (search: string) => window.history.pushState({}, "", `/github/callback${search}`);
const goodSearch = "?code=secret-code&state=secret-state&installation_id=42&setup_action=install";

function setup(search = goodSearch, github: Parameters<typeof makeClient>[0] = { me: makeMe({ github: true }), github: {} }) {
  arrive(search);
  const client = makeClient(github);
  const onOpenSettings = vi.fn();
  const view = render(
    <StrictMode>
      <GithubCallback client={client} onOpenSettings={onOpenSettings} />
    </StrictMode>,
  );
  return { client, onOpenSettings, ...view };
}

afterEach(() => window.history.pushState({}, "", "/"));

describe("GithubCallback", () => {
  it("completes the connection exactly once (even with the double effect) and shows progress meanwhile", async () => {
    const { client } = setup();
    expect(screen.getByRole("status")).toHaveTextContent("Conferindo a conexão com o GitHub…");
    expect(await screen.findByText("GitHub conectado à conta herzog0.")).toBeInTheDocument();
    expect(client.completeGithubConnection).toHaveBeenCalledTimes(1);
    expect(client.completeGithubConnection).toHaveBeenCalledWith({ code: "secret-code", state: "secret-state", installationId: 42 });
  });

  it("names the account the API returned", async () => {
    setup(goodSearch, { me: makeMe({ github: true }), github: { pendingInstallation: makeInstallation({ accountLogin: "outra-conta" }) } });
    expect(await screen.findByText("GitHub conectado à conta outra-conta.")).toBeInTheDocument();
  });

  it.each([["", "missing"], ["&installation_id=abc", "not a number"], ["&installation_id=0", "zero"], ["&installation_id=-3", "negative"], ["&installation_id=4.5", "fractional"]])(
    "omits installationId when it %s is not a positive integer",
    async (extra) => {
      const { client } = setup(`?code=c&state=s${extra}`);
      await screen.findByText(/GitHub conectado/);
      expect(client.completeGithubConnection).toHaveBeenCalledWith({ code: "c", state: "s" });
    },
  );

  it("takes code and state off the address bar before calling the API", async () => {
    arrive(goodSearch);
    const seen: string[] = [];
    const client = makeClient({ me: makeMe({ github: true }), github: {} });
    vi.mocked(client.completeGithubConnection).mockImplementation(async () => {
      seen.push(window.location.pathname + window.location.search);
      return { ok: true, data: { installation: makeInstallation() } };
    });
    render(<GithubCallback client={client} onOpenSettings={vi.fn()} />);
    await screen.findByText(/GitHub conectado/);
    expect(seen).toEqual(["/github/callback"]);
  });

  it("never prints code or state on the screen", async () => {
    setup();
    await screen.findByText(/GitHub conectado/);
    expect(document.body).not.toHaveTextContent("secret-code");
    expect(document.body).not.toHaveTextContent("secret-state");
  });

  it("Continuar sends the URL to the application root and opens the settings", async () => {
    const { onOpenSettings } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Continuar" }));
    expect(window.location.pathname).toBe("/");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid_state", "bad", "A conexão expirou. Comece de novo em Configurações."],
    ["invalid_code", "bad", "A conexão expirou. Comece de novo em Configurações."],
    ["installation_not_yours", "forbidden", "Esta instalação não é da sua conta do GitHub."],
    ["organization_account_unsupported", "conflict", "Por enquanto o TreePM só aceita o app instalado em conta pessoal do GitHub."],
    ["no_installation", "conflict", "O GitHub não encontrou a instalação do app. Instale de novo."],
    ["installation_unavailable", "conflict", "O GitHub não encontrou a instalação do app. Instale de novo."],
    ["installation_ambiguous", "conflict", "Há mais de uma instalação do app na sua conta. Comece de novo em Configurações."],
    ["already_connected", "conflict", "Esta organização já está ligada ao GitHub."],
    ["installation_in_use", "conflict", "Esta instalação do GitHub já está em uso."],
    ["github_unavailable", "unavailable", "O GitHub não respondeu. Tente de novo em instantes."],
  ] as const)("explains %s", async (code, kind, message) => {
    const type = kind === "bad" ? "invalid" : kind;
    const { onOpenSettings } = setup(goodSearch, { me: makeMe({ github: true }), github: { completeError: [type, code] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(/GitHub conectado/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent("secret");
  });

  it("explains a 403 without its own code as an administrator-only action", async () => {
    setup(goodSearch, { me: makeMe({ github: true, clerk: "member" }), github: {} });
    expect(await screen.findByRole("alert")).toHaveTextContent("Só um administrador da organização pode conectar o GitHub.");
  });

  it("falls back to a generic message for an unknown error", async () => {
    setup(goodSearch, { me: makeMe({ github: true }), github: { completeError: ["server_error"] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível concluir a conexão com o GitHub.");
  });

  it("says the installation was not finished when there is no code, without calling the API", async () => {
    const { client } = setup("?state=s");
    expect(await screen.findByText("A instalação não foi concluída no GitHub.")).toBeInTheDocument();
    expect(client.completeGithubConnection).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Voltar" })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("says the request must be approved when setup_action is request, without calling the API", async () => {
    const { client } = setup("?code=c&state=s&setup_action=request");
    expect(await screen.findByText("O pedido de instalação foi enviado e precisa ser aprovado no GitHub.")).toBeInTheDocument();
    expect(client.completeGithubConnection).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });
});

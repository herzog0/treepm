import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConsent, Me } from "../api/client.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeMe } from "../test/fakes.js";
import type { FakeAiConsent } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { SettingsScreen } from "./SettingsScreen.js";

const given = { inForce: true, version: "rascunho-2", acceptedBy: "Ana", acceptedAt: "2026-11-22T12:00:00.000Z", outdated: false };
const none = { inForce: false, version: null, acceptedBy: null, acceptedAt: null, outdated: false };
const state = (extra: Partial<AiConsent> = {}): Partial<AiConsent> => ({ currentVersion: "rascunho-2", ...extra });

function setup(options: { me?: Me; consent?: FakeAiConsent; onChange?: () => void } = {}) {
  window.location.hash = "ia";
  const me = options.me ?? makeMe({ assistant: true, consent: false });
  const client = makeClient({ me, aiConsent: options.consent ?? {} });
  const user = userEvent.setup();
  const onChange = options.onChange ?? vi.fn();
  render(
    <MemoryPreferencesProvider onSave={vi.fn()}>
      <SettingsScreen client={client} me={me} onConsentChange={onChange} />
    </MemoryPreferencesProvider>,
  );
  return { client, user, onChange };
}
const section = async () => screen.findByRole("region", { name: "IA e privacidade" });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("seção IA e privacidade", () => {
  it("não tem texto novo: sem frase de abertura e sem selo Ligado/Desligado nos cartões (texto legal é só o que já existia)", async () => {
    setup({ consent: { state: state({ assistant: given }) } });
    const region = await section();
    await within(region).findByText(/enviado à Anthropic e à TypeSafe/);
    expect(region.querySelector(".settings-lead")).toBeNull();
    expect(within(region).queryByText("Ligado")).toBeNull();
    expect(within(region).queryByText("Desligado")).toBeNull();
    expect(region.querySelector(".settings-badge")).toBeNull();
  });

  it("não aparece quando o servidor não tem a IA configurada", () => {
    setup({ me: makeMe({ assistant: false }) });
    expect(screen.queryByRole("region", { name: "IA e privacidade" })).toBeNull();
  });

  it("administrador, sem aceite: texto do que sai, links em outra aba e o botão de aceitar", async () => {
    setup();
    const region = await section();
    const text = within(region);
    expect(await text.findByText(/enviado à Anthropic e à TypeSafe/)).toBeInTheDocument();
    expect(text.getByText(/Nomes, e-mails e identificadores de pessoas não são enviados/)).toBeInTheDocument();
    const terms = text.getByRole("link", { name: /Termos de uso/ });
    const privacy = text.getByRole("link", { name: /Política de privacidade/ });
    expect(terms).toHaveAttribute("href", "/termos");
    expect(privacy).toHaveAttribute("href", "/privacidade");
    for (const link of [terms, privacy]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }
    expect(text.getByRole("button", { name: "Aceitar e ligar o assistente" })).toBeEnabled();
    expect(text.queryByRole("button", { name: /Retirar/ })).toBeNull();
  });

  it("aceitar chama a API com a versão atual, mostra quem aceitou e avisa a tela para recarregar o estado", async () => {
    const { client, user, onChange } = setup();
    await user.click(await screen.findByRole("button", { name: "Aceitar e ligar o assistente" }));
    expect(client.acceptAiConsent).toHaveBeenCalledWith("assistant", "rascunho-2");
    expect(await screen.findByText(/Aceito por Ana em .* \(versão rascunho-2\)\./)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Aceitar e ligar o assistente" })).toBeNull();
  });

  it("retirar pede confirmação que diz o que para de funcionar e só então chama a API", async () => {
    const { client, user } = setup({ consent: { state: state({ assistant: given }) } });
    await user.click(await screen.findByRole("button", { name: "Retirar o aceite" }));
    expect(screen.getByText(/O assistente deixa de funcionar na organização/)).toBeInTheDocument();
    expect(client.withdrawAiConsent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(client.withdrawAiConsent).toHaveBeenCalledWith("assistant");
    expect(await screen.findByRole("button", { name: "Aceitar e ligar o assistente" })).toBeInTheDocument();
  });

  it("leitura de código: sem GitHub ligado a parte nem aparece", async () => {
    setup({ consent: { state: state({ assistant: given }) } });
    await section();
    await screen.findByRole("button", { name: "Retirar o aceite" });
    expect(screen.queryByText("Leitura de código pela IA")).toBeNull();
  });

  it("leitura de código: com GitHub e sem o assistente aceito, vem desabilitada e explica", async () => {
    setup({ consent: { state: state({ codeReading: { ...none, githubConnected: true, offerable: false } }) } });
    const button = await screen.findByRole("button", { name: "Aceitar a leitura de código" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Aceite antes o assistente de IA.")).toBeInTheDocument();
    expect(screen.getByText(/enviados à Anthropic, e só a ela/)).toBeInTheDocument();
    expect(screen.getByText(/ainda não está disponível/)).toBeInTheDocument();
  });

  it("leitura de código: oferecida, aceita e retirada com confirmação", async () => {
    const { client, user } = setup({ consent: { state: state({ assistant: given, codeReading: { ...none, githubConnected: true, offerable: true } }) } });
    await user.click(await screen.findByRole("button", { name: "Aceitar a leitura de código" }));
    expect(client.acceptAiConsent).toHaveBeenCalledWith("code_reading", "rascunho-2");
    const withdraws = await screen.findAllByRole("button", { name: "Retirar o aceite" });
    expect(withdraws).toHaveLength(2);
    await user.click(withdraws[1] as HTMLElement);
    expect(screen.getByText(/deixa de poder ler código/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(client.withdrawAiConsent).toHaveBeenCalledWith("code_reading");
  });

  it("versão desatualizada: avisa que os documentos mudaram e pede para aceitar de novo", async () => {
    setup({ consent: { state: state({ assistant: { ...given, version: "rascunho-0", inForce: false, outdated: true } }) } });
    expect(await screen.findByText(/Os documentos mudaram \(versão rascunho-2\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aceitar e ligar o assistente" })).toBeEnabled();
  });

  it("quem não é administrador vê o estado, sem botões, e a frase de que um administrador precisa aceitar", async () => {
    const me = makeMe({ assistant: true, consent: false, clerk: "member" });
    setup({ me });
    expect(await screen.findByText("Um administrador da organização precisa aceitar.")).toBeInTheDocument();
    expect(screen.getByText("O assistente está desligado.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aceitar|Retirar/ })).toBeNull();
  });

  it("quem não é administrador vê quem aceitou e quando", async () => {
    setup({ me: makeMe({ assistant: true, clerk: "member" }), consent: { state: state({ assistant: given }) } });
    expect(await screen.findByText("O assistente está ligado.")).toBeInTheDocument();
    expect(screen.getByText(/Aceito por Ana em/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retirar/ })).toBeNull();
  });

  it("os documentos mudaram durante a leitura (409): mostra o aviso e recarrega o estado", async () => {
    const { user } = setup({ consent: { changeError: ["conflict", "consent_version_changed"] } });
    await user.click(await screen.findByRole("button", { name: "Aceitar e ligar o assistente" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Os documentos mudaram enquanto você lia");
  });

  it("falha ao aceitar: mensagem na seção, sem trocar o estado", async () => {
    const { user } = setup({ consent: { changeError: ["unavailable"] } });
    await user.click(await screen.findByRole("button", { name: "Aceitar e ligar o assistente" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A API está indisponível");
    expect(screen.getByRole("button", { name: "Aceitar e ligar o assistente" })).toBeEnabled();
  });

  it("os três idiomas mostram a seção", async () => {
    for (const [language, heading] of [["en", "AI and privacy"], ["es-MX", "IA y privacidad"]] as const) {
      await setTestLanguage(language);
      const { unmount } = (() => {
        const me = makeMe({ assistant: true, consent: false });
        const client = makeClient({ me, aiConsent: {} });
        window.location.hash = "ia";
        return render(<MemoryPreferencesProvider onSave={vi.fn()}><SettingsScreen client={client} me={me} /></MemoryPreferencesProvider>);
      })();
      await waitFor(() => expect(screen.getByRole("region", { name: heading })).toBeInTheDocument());
      unmount();
    }
    await setTestLanguage("pt-BR");
  });
});

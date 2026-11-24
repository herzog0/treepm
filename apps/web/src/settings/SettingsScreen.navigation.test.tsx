import { StrictMode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api/client.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeMe } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { DEFAULT_SETTINGS_SECTIONS } from "./sections.js";
import type { SettingsSection } from "./sections.js";

function setup(me: Me | undefined, sections?: readonly SettingsSection[]) {
  const client = me ? makeClient({ me, mcp: {} }) : undefined;
  return render(
    <MemoryPreferencesProvider onSave={vi.fn()}>
      <SettingsScreen client={client} me={me} {...(sections ? { sections } : {})} />
    </MemoryPreferencesProvider>,
  );
}
const nav = () => screen.getByRole("navigation", { name: "Seções das configurações" });
const links = () => within(nav()).getAllByRole("link").map((link) => link.textContent ?? "");
const groups = () => within(nav()).queryAllByRole("list").map((list) => document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent);

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  window.location.hash = "";
});

describe("navegação das Configurações", () => {
  it("sem API (só o idioma): uma seção, no grupo Você", () => {
    setup(undefined);
    expect(links()).toEqual(["Idioma"]);
    expect(groups()).toEqual(["Você"]);
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
  });

  it("administrador com tudo ligado: três grupos, com a marca admin só onde há ajuste de administrador", () => {
    setup(makeMe({ clerk: "admin", github: true, assistant: true, mcp: true }));
    expect(groups()).toEqual(["Você", "Organização", "Integrações"]);
    expect(links()).toEqual(["Idioma", "Seus tokens", "Pessoas admin", "IA e privacidade admin", "GitHub admin", "Clientes de IA admin"]);
  });

  it("membro com tudo ligado: as mesmas seções, sem a marca admin", () => {
    setup(makeMe({ clerk: "member", github: true, assistant: true, mcp: true }));
    expect(links()).toEqual(["Idioma", "Seus tokens", "IA e privacidade", "GitHub", "Clientes de IA"]);
    expect(within(nav()).queryByText("admin")).not.toBeInTheDocument();
  });

  it.each([
    { name: "GitHub desligado", me: makeMe({ github: false, assistant: true, mcp: true }), missing: "GitHub" },
    { name: "IA não configurada", me: makeMe({ github: true, assistant: false, mcp: true }), missing: "IA e privacidade" },
    { name: "MCP indisponível", me: makeMe({ github: true, assistant: true }), missing: "Clientes de IA" },
  ])("$name: a seção some da navegação", ({ me, missing }) => {
    setup(me);
    expect(links().map((text) => text.replace(" admin", ""))).not.toContain(missing);
  });

  it("sem nenhuma integração: Você e, para o administrador, Organização (só Pessoas); Integrações não aparece", () => {
    setup(makeMe({ github: false, assistant: false }));
    expect(groups()).toEqual(["Você", "Organização"]);
    expect(links()).toEqual(["Idioma", "Pessoas admin"]);
  });

  it("MCP indisponível some também a seção Seus tokens", () => {
    setup(makeMe({ github: true }));
    expect(links()).toEqual(["Idioma", "Pessoas admin", "GitHub admin"]);
  });

  it("abre a primeira seção disponível e marca a atual com aria-current", () => {
    setup(makeMe({ mcp: true }));
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Idioma" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByRole("link", { name: "Seus tokens" })).not.toHaveAttribute("aria-current");
  });

  it("mostra uma seção por vez", () => {
    window.location.hash = "#mcp";
    setup(makeMe({ mcp: true, github: true }));
    expect(screen.getByRole("heading", { level: 2, name: "Clientes de IA (MCP)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Idioma" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("a âncora abre a seção correspondente", () => {
    window.location.hash = "#github";
    setup(makeMe({ github: true, mcp: true }));
    expect(screen.getByRole("heading", { level: 2, name: "GitHub" })).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: /GitHub/ })).toHaveAttribute("aria-current", "page");
  });

  it("âncora desconhecida ou de seção que a pessoa não vê abre a primeira disponível", () => {
    window.location.hash = "#nao-existe";
    const first = setup(makeMe({ github: true }));
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
    first.unmount();
    window.location.hash = "#mcp";
    setup(makeMe({ github: true }));
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
  });

  it("clicar na navegação troca a seção, grava a âncora no endereço e leva o foco ao título", async () => {
    setup(makeMe({ github: true, mcp: true }));
    await userEvent.click(within(nav()).getByRole("link", { name: /GitHub/ }));
    const title = await screen.findByRole("heading", { level: 2, name: "GitHub" });
    expect(window.location.hash).toBe("#github");
    await waitFor(() => expect(title).toHaveFocus());
    expect(within(nav()).getByRole("link", { name: /GitHub/ })).toHaveAttribute("aria-current", "page");
  });

  it("não rouba o foco ao abrir a página", () => {
    setup(makeMe({ github: true }));
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).not.toHaveFocus();
  });

  it("não rouba o foco quando a API termina de carregar e a seção da âncora aparece", async () => {
    window.location.hash = "#github";
    const me = makeMe({ github: true });
    const client = makeClient({ me, mcp: {} });
    const view = (props: { me?: Me }) => (
      <MemoryPreferencesProvider onSave={vi.fn()}>
        <SettingsScreen client={client} {...props} />
      </MemoryPreferencesProvider>
    );
    const { rerender } = render(view({}));
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
    rerender(view({ me }));
    const title = await screen.findByRole("heading", { level: 2, name: "GitHub" });
    expect(title).not.toHaveFocus();
  });

  it("voltar no histórico (mudança da âncora) troca a seção", async () => {
    setup(makeMe({ github: true, mcp: true }));
    act(() => {
      window.location.hash = "#mcp";
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Clientes de IA (MCP)" })).toBeInTheDocument();
  });

  it("cada seção tem título e uma frase que diz para que serve", () => {
    setup(makeMe({ mcp: true }));
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
    expect(screen.getByText("A língua dos menus, botões e avisos da interface.")).toBeInTheDocument();
  });

  it("a seção aberta é uma região nomeada pelo título", () => {
    setup(makeMe({ mcp: true }));
    expect(screen.getByRole("region", { name: "Idioma" })).toBeInTheDocument();
  });

  it("nas três línguas a navegação tem rótulo e grupos traduzidos", async () => {
    await setTestLanguage("en");
    setup(makeMe({ github: true, assistant: true, mcp: true }));
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeInTheDocument();
    const english = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(english).getAllByRole("list").map((list) => document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent)).toEqual(["You", "Organization", "Integrations"]);
    expect(within(english).getAllByRole("link").map((link) => link.textContent)).toEqual(["Language", "Your tokens", "People admin", "AI and privacy admin", "GitHub admin", "AI clients admin"]);
  });
});

describe("revisão 1: navegação", () => {
  it("o item da navegação do MCP é curto (não quebra linha), e o título da seção continua com (MCP)", () => {
    window.location.hash = "#mcp";
    setup(makeMe({ mcp: true, clerk: "admin" }));
    expect(within(nav()).getByRole("link", { name: "Clientes de IA admin" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 2, name: "Clientes de IA (MCP)" })).toBeInTheDocument();
  });

  it("a frase de abertura do MCP não afirma nada que dependa da chave", () => {
    window.location.hash = "#mcp";
    setup(makeMe({ mcp: false, clerk: "admin" }));
    expect(screen.getByText("Tokens para clientes de IA, como o Claude Code, acessarem os tickets desta organização.")).toBeInTheDocument();
  });

  it.each([
    ["en", "Tokens for AI clients, such as Claude Code, to access this organization's tickets."],
    ["es-MX", "Tokens para que clientes de IA, como Claude Code, accedan a los tickets de esta organización."],
  ] as const)("a frase do MCP em %s", async (language, lead) => {
    await setTestLanguage(language);
    window.location.hash = "#mcp";
    setup(makeMe({ mcp: true }));
    expect(screen.getByText(lead)).toBeInTheDocument();
  });

  it("IA e privacidade não ganha frase de abertura: só o título e os textos que já existiam", () => {
    window.location.hash = "#ia";
    const { container } = setup(makeMe({ assistant: true, consent: true, clerk: "admin" }));
    expect(screen.getByRole("heading", { level: 2, name: "IA e privacidade" })).toBeInTheDocument();
    expect(container.querySelector(".settings-lead")).toBeNull();
  });

  it("não rouba o foco ao abrir a página sob StrictMode, mas leva ao título ao trocar de seção", async () => {
    window.location.hash = "#idioma";
    const me = makeMe({ github: true, mcp: true });
    render(
      <StrictMode>
        <MemoryPreferencesProvider onSave={vi.fn()}>
          <SettingsScreen client={makeClient({ me, mcp: {} })} me={me} />
        </MemoryPreferencesProvider>
      </StrictMode>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).not.toHaveFocus();
    await userEvent.click(within(nav()).getByRole("link", { name: /GitHub/ }));
    const title = await screen.findByRole("heading", { level: 2, name: "GitHub" });
    await waitFor(() => expect(title).toHaveFocus());
  });

  it("a seção montada é nova a cada troca (key pelo id): o estado de uma não vaza para a outra", async () => {
    setup(makeMe({ github: true, mcp: true }));
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThan(0);
    await userEvent.click(within(nav()).getByRole("link", { name: /GitHub/ }));
    await screen.findByRole("heading", { level: 2, name: "GitHub" });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});

describe("registro de seções", () => {
  const fake: SettingsSection = {
    id: "mentira",
    group: "organization",
    title: () => "Seção de mentira",
    lead: () => "Só para o teste.",
    adminTag: true,
    available: () => true,
    render: () => <p>Conteúdo de mentira</p>,
  };

  it("aceita uma seção nova, sem mexer na casca", async () => {
    window.location.hash = "#mentira";
    setup(makeMe({ clerk: "admin" }), [...DEFAULT_SETTINGS_SECTIONS, fake]);
    expect(groups()).toEqual(["Você", "Organização"]);
    expect(screen.getByRole("heading", { level: 2, name: "Seção de mentira" })).toBeInTheDocument();
    expect(screen.getByText("Conteúdo de mentira")).toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Seção de mentira admin" })).toHaveAttribute("aria-current", "page");
  });

  it("uma seção indisponível não aparece, e seu grupo some se ficar vazio", () => {
    setup(makeMe({ clerk: "member" }), [...DEFAULT_SETTINGS_SECTIONS, { ...fake, available: () => false }]);
    expect(groups()).toEqual(["Você"]);
    expect(links()).toEqual(["Idioma"]);
  });
});

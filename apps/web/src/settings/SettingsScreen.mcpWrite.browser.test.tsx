import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { fakeToken, makeClient, makeMe, makeProject, makeToken } from "../test/fakes.js";
import { SettingsScreen } from "./SettingsScreen.js";

// ADR 0043: a tela de tokens com o alcance, desenhada de verdade.
const CAPTURES = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"];

describe("Configurações › MCP em navegador real", () => {
  it("mostra a chave de escrita, a escolha do alcance e o alcance de cada token", async () => {
    await page.viewport(1100, 1500);
    const me = makeMe({ mcp: true, mcpWrite: false });
    const client = makeClient({
      me,
      projects: [makeProject("p1", "ALFA", "Alfa")],
      mcp: { secret: fakeToken("s"), tokens: [makeToken("a", "Coordenação", { scope: "write" }), makeToken("b", "Leitor do Cursor", { scope: "read" })] },
    });
    const screen = await render(
      <MemoryPreferencesProvider onSave={vi.fn()}>
        <SettingsScreen client={client} me={me} />
      </MemoryPreferencesProvider>,
    );
    await expect.element(screen.getByRole("switch", { name: "Permitir escrita por MCP" })).toBeVisible();
    await screen.getByRole("radio", { name: "Leitura e escrita" }).click();
    await expect.element(screen.getByText(/só vai escrever quando um administrador ligar a chave/)).toBeVisible();
    await expect.element(screen.getByText("Coordenação").first()).toBeVisible();
    if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/configuracoes-mcp-alcance.png` });
  });
});

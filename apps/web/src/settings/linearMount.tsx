import { vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { makeClient, makeLinearConnection, makeLinearTeam, makeMe, makeProject } from "../test/fakes.js";
import type { FakeLinear } from "../test/fakes.js";
import { SettingsScreen } from "./SettingsScreen.js";

/** Apoio dos testes de navegador da seção "Linear" (medidas e capturas): monta as Configurações já na seção, como a casca da aplicação. */
export const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

export const TEAMS = [
  makeLinearTeam("ENG", "Engenharia", { linkedProject: { id: "p9", name: "TreePM" } }),
  makeLinearTeam("DES", "Design"),
  makeLinearTeam("OPS", "Operações", { linkedElsewhere: true }),
];

export const PROJECTS = [makeProject("p1", "TREEPM", "TreePM"), makeProject("p2", "SITE", "Site institucional")];

export async function mountLinear(options: { width?: number; height?: number; linear?: FakeLinear } = {}) {
  await page.viewport(options.width ?? 1440 - 296, options.height ?? 900);
  window.location.hash = "linear";
  const me = makeMe({ clerk: "admin", mcp: true, github: true });
  const client = makeClient({ me, projects: PROJECTS, linear: options.linear ?? { connection: makeLinearConnection(), teams: TEAMS } });
  const screen = await render(
    <div style={{ display: "grid", height: "100dvh", gridTemplateRows: "minmax(0, 1fr)" }}>
      <main className="tenant-settings" style={{ minWidth: 0, minHeight: 0, overflow: "auto" }}>
        <MemoryPreferencesProvider onSave={vi.fn()}>
          <SettingsScreen client={client} me={me} />
        </MemoryPreferencesProvider>
      </main>
    </div>,
  );
  await document.fonts.ready;
  await settle();
  return { screen, client };
}

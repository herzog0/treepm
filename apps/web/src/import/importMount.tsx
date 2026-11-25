import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinear } from "../test/fakes.js";
import type { ProjectLinear } from "../api/client.js";
import { ImportScreen } from "./ImportScreen.js";

/** Apoio dos testes de navegador da importação do Linear (medidas e capturas): monta a tela como a casca da aplicação. */
export const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

export const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "DES", name: "Design" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
export const FREE: ProjectLinear = { source: null, canLink: true, keyMatches: null };

export async function mountImport(options: { width?: number; height?: number; linear?: FakeLinear; hash?: string } = {}) {
  await page.viewport(options.width ?? 1440, options.height ?? 900);
  window.location.hash = options.hash ?? "#linear";
  const me = makePanelMe("admin");
  const project = makeProject("p1", "TREEPM", "TreePM");
  const tickets = [makeTicket("t1", "p1", 1, "Fundações", { key: "TREEPM-1" }), makeTicket("t2", "p1", 2, "Mapa espacial", { key: "TREEPM-2" })];
  const client = makeClient({ me, projects: [project], tickets: { p1: tickets }, linear: options.linear ?? { connection: makeLinearConnection(), projects: { p1: LINKED } } });
  const screen = await render(<ImportScreen client={client} me={me} projectId="p1" onExit={() => undefined} onOpenSettings={() => undefined} />);
  await document.fonts.ready;
  await settle();
  return { screen, client };
}

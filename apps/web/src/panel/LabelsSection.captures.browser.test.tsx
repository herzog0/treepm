import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { Label } from "../api/client.js";
import { makeProject, makeTicket } from "../test/fakes.js";
import { SidePanel } from "./SidePanel.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

// Capturas da seção "Etiquetas" nas configurações do projeto (ADR 0065): só com `VITE_TREEPM_CAPTURES_DIR=1`; saem em capturas-E1/.
const DIR = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES_DIR"];
const shot = (name: string) => page.screenshot({ path: `../../../../capturas-E1/${name}.png`, save: true });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await page.viewport(1440, 900);
});
afterEach(async () => {
  await page.viewport(1440, 900);
});

const alpha = makeProject("p1", "ENG", "Engenharia");
const labels: Label[] = [
  { id: "l1", name: "Bug", color: "rose" },
  { id: "l2", name: "Front-end", color: "cyan" },
  { id: "l3", name: "Integração com o Linear e a importação de históricos antigos", color: "indigo" },
  { id: "l4", name: "Velha", color: "gray" },
];
const tickets = [
  makeTicket("t1", "p1", 1, "Um", { labels: [labels[0]!, labels[1]!] }),
  makeTicket("t2", "p1", 2, "Dois", { labels: [labels[0]!, labels[2]!] }),
  makeTicket("t3", "p1", 3, "Três", { labels: [labels[0]!] }),
];

async function mount() {
  const me = makePanelMe("admin");
  const client = makePanelClient({ projects: [alpha], people: [makePerson("person-1", "Ana")], me, tickets: { p1: tickets }, labels: { p1: labels } });
  const noop = () => undefined;
  const screen = await render(
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "var(--tp-bg)" }}>
      <SidePanel client={client} me={me} projects={[alpha]} tab="projects" selectedProjectId="p1" onTabChange={noop} onClose={noop} onChanged={noop} />
    </div>,
  );
  const region = screen.getByRole("region", { name: "Etiquetas" });
  await expect.element(region.getByText("Velha")).toBeVisible();
  document.querySelector(".panel-labels")?.scrollIntoView({ block: "start" });
  await settle(400);
  return screen;
}

const widths = [
  [1440, "1440"],
  [414, "414"],
] as const;

describe.skipIf(!DIR)("capturas da seção Etiquetas nas configurações do projeto (ADR 0065)", () => {
  for (const [width, tag] of widths) {
    it(`a seção Etiquetas · ${tag}`, async () => {
      await page.viewport(width, 900);
      await mount();
      await shot(`configuracoes-etiquetas-${tag}-escuro`);
    });

    it(`confirmação de apagar · ${tag}`, async () => {
      await page.viewport(width, 900);
      const screen = await mount();
      await screen.getByRole("button", { name: "Apagar etiqueta Bug" }).click();
      await expect.element(screen.getByText("Apagar a etiqueta Bug? Ela sai de 3 tickets.")).toBeVisible();
      await settle(200);
      await shot(`configuracoes-apagar-confirmacao-${tag}-escuro`);
    });
  }
});

import { useState } from "react";
import { afterEach, describe, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "../map/OrganizationMap.js";

// Capturas da conferência visual do play e da prioridade (ADR 0047 e 0048): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em .vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const DIR = "../../.vitest/cap";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}.png`, save: true });
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const tickets = (blocked = false) => [
  makeTicket("t1", "p1", 1, "Acesso e conta com um título bastante comprido para exercitar as reticências", { key: "ALFA-1", status: "in_progress", assigneeIds: ["person-1"], priority: 5 }),
  makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2", assigneeIds: ["person-1"], priority: 4 }),
  makeTicket("t3", "p1", 3, "Relatórios", { key: "ALFA-3", status: "in_progress", assigneeIds: ["person-2"], parentId: "t1" }),
  makeTicket("t4", "p1", 4, "Cobrança", { key: "ALFA-4", assigneeIds: ["person-1"], priority: 2 }),
  makeTicket("t5", "p1", 5, "Cartão", { key: "ALFA-5", assigneeIds: ["person-2"] }),
].map((ticket) => ({ ...ticket, blocked }));

function Host({ blocked = false, initial = null }: { blocked?: boolean; initial?: string | null }) {
  const [open, setOpen] = useState<string | null>(initial);
  const [api] = useState(() => makeTreeClient({ projects: [project], tickets: { p1: tickets(blocked) }, people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const byLabel = (label: string) => q<HTMLButtonElement>(`[aria-label="${label}"]`)!;
async function start(name: string) {
  byLabel("Modo play").click();
  await settle(300);
  [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((el) => el.textContent?.includes(name))!.click();
  await settle(2500);
}

describe.skipIf(!ON)("capturas do play e da prioridade", () => {
  afterEach(() => document.body.replaceChildren());
  for (const [tag, width, height] of [["1440", 1440, 900], ["390", 390, 844], ["800", 800, 900]] as const) {
    const touch = () => cdp().send("Emulation.setTouchEmulationEnabled", { enabled: width < 721, maxTouchPoints: 5 });
    it(`menu, passos e stand-up em ${tag}`, async () => {
      await touch();
      await page.viewport(width, height);
      await render(<Host />);
      await settle(1200);
      byLabel("Modo play").click();
      await settle(400);
      await shot(`${tag}-01-menu-do-play`);
      document.body.replaceChildren();
    });
    it(`barra do play em ${tag}`, async () => {
      await touch();
      await page.viewport(width, height);
      await render(<Host />);
      await settle(1200);
      await start("Meu trabalho");
      byLabel("Avançar").click();
      await settle(1500);
      await shot(`${tag}-02-play-passo-do-meio`);
      for (let i = 0; i < 6 && !byLabel("Avançar").disabled; i++) { byLabel("Avançar").click(); await settle(900); }
      await settle(1200);
      await shot(`${tag}-03-play-no-fim`);
    });
    it(`stand-up em ${tag}`, async () => {
      await touch();
      await page.viewport(width, height);
      await render(<Host />);
      await settle(1200);
      await start("Stand-up");
      await shot(`${tag}-04-standup`);
    });
    it(`prioridade na página em ${tag}`, async () => {
      await touch();
      await page.viewport(width, height);
      await render(<Host initial="t4" />);
      await settle(2500);
      await shot(`${tag}-05-prioridade-propria`);
      document.body.replaceChildren();
      await render(<Host initial="t3" />);
      await settle(2500);
      await shot(`${tag}-06-prioridade-herdada`);
    });
    it(`próximo ticket para trabalhar em ${tag}`, async () => {
      await touch();
      await page.viewport(width, height);
      await render(<Host />);
      await settle(1200);
      q<HTMLInputElement>(".command-field input")!.focus();
      await settle(500);
      await shot(`${tag}-07-proximo-com-fila`);
      document.body.replaceChildren();
      await render(<Host blocked />);
      await settle(1200);
      q<HTMLInputElement>(".command-field input")!.focus();
      await settle(500);
      [...document.querySelectorAll<HTMLElement>("[role=option]")].find((el) => el.textContent?.includes("Próximo ticket"))?.click();
      await settle(600);
      await shot(`${tag}-08-proximo-fila-vazia`);
    });
  }
});

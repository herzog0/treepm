import { useState } from "react";
import { afterEach, describe, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "../map/map.css";
import "../map/agent-work.css";
import "@treepm/react/styles.css";
import type { Project, TicketSummary } from "../api/client.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe } from "../panel/testing.js";
import { dependencyProject, dependencyTickets } from "../test/dependencyMap.js";
import { makeTreeClient } from "../test/fakes.js";
import { generatedProject, generatedTickets } from "../test/generatedProject.js";
import { wheel } from "../test/touch.js";

// Capturas da árvore explodida (ADR 0070): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em `screenshots/arvore/` na raiz do
// worktree (fora do Git). O app só tem o tema escuro.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const DIR = "../../../../screenshots/arvore";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}.png`, save: true });
const settle = (ms = 800) => new Promise((resolve) => setTimeout(resolve, ms));

function Host({ project, tickets }: { project: Project; tickets: TicketSummary[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [api] = useState(() => makeTreeClient({ projects: [project], tickets: { [project.id]: tickets }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

const cardOf = (title: RegExp) => [...document.querySelectorAll<HTMLElement>(".exploded-card")].find((card) => title.test(card.getAttribute("aria-label") ?? ""));
const centerOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};
/** Wheel no centro do card até ele ter pelo menos `width` px na tela. */
async function zoomTo(title: RegExp, width: number) {
  for (let step = 0; step < 30; step += 1) {
    const card = cardOf(title);
    if (!card) throw new Error(`card ${title} fora da tela`);
    if (card.getBoundingClientRect().width >= width) break;
    await wheel(centerOf(card), -240);
    await settle(120);
  }
  await settle();
}
const press = (name: RegExp) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => name.test(entry.getAttribute("aria-label") ?? entry.textContent ?? ""));
  if (!button) throw new Error(`botão ${name} não encontrado`);
  button.click();
};

const FIXTURES = [
  { tag: "loja-33", project: dependencyProject, tickets: () => dependencyTickets(), zoomOn: /Pagamento/, select: /Pagamento/, parent: "Checkout" },
  { tag: "gerado-80", project: generatedProject, tickets: () => generatedTickets(80, 16), zoomOn: /GEN-11 /, select: /GEN-11 /, parent: "Etapa 2" },
] as const;

describe.skipIf(!ON)("capturas da árvore explodida", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.tag}: de longe, de perto, selecionado e com foco num pai`, async () => {
      window.history.replaceState(null, "", "/?layout=tree");
      await page.viewport(1440, 900);
      await render(<Host project={fixture.project} tickets={fixture.tickets()} />);
      await settle(1200);
      await shot(`${fixture.tag}-1-de-longe`);
      await zoomTo(fixture.zoomOn, 230);
      await shot(`${fixture.tag}-2-de-perto`);
      cardOf(fixture.select)!.click();
      await settle(900);
      for (let step = 0; step < 2; step += 1) {
        await wheel(centerOf(cardOf(fixture.select)!), 240);
        await settle(150);
      }
      await settle();
      await shot(`${fixture.tag}-3-selecionado`);
      press(new RegExp(`^Ver só ${fixture.parent}$`));
      await settle(1200);
      await shot(`${fixture.tag}-4-foco-no-pai`);
    });
  }
});

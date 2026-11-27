import { useState } from "react";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { Project, TicketSummary } from "../api/client.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe } from "../panel/testing.js";
import { makeTreeClient } from "./fakes.js";
import { wheel } from "./touch.js";

// Passos das capturas da árvore explodida, os mesmos para qualquer lista: a primeira vista, um pedaço de perto, a árvore inteira (⌂) e
// um ticket selecionado. O ticket selecionado é o card na tela com mais dependências, escolhido pelos dados na hora: nada da lista fica
// escrito aqui.

const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

function Host({ project, tickets }: { project: Project; tickets: readonly TicketSummary[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [api] = useState(() => makeTreeClient({ projects: [project], tickets: { [project.id]: [...tickets] }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

const cards = () => [...document.querySelectorAll<HTMLElement>(".exploded-card")];
const center = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};
function nearMiddle(): HTMLElement {
  const stage = document.querySelector(".exploded-stage")!.getBoundingClientRect();
  const middle = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 };
  return cards().sort((a, b) => Math.hypot(center(a).x - middle.x, center(a).y - middle.y) - Math.hypot(center(b).x - middle.x, center(b).y - middle.y))[0]!;
}
function mostLinked(tickets: readonly TicketSummary[]): HTMLElement {
  const links = new Map<string, number>();
  for (const ticket of tickets) {
    for (const dependency of ticket.dependencies ?? []) {
      links.set(ticket.key, (links.get(ticket.key) ?? 0) + 1);
      const target = tickets.find((other) => other.id === dependency.id);
      if (target) links.set(target.key, (links.get(target.key) ?? 0) + 1);
    }
  }
  const keyOf = (card: HTMLElement) => (card.getAttribute("aria-label") ?? "").split(" · ")[0]!;
  const stage = document.querySelector(".exploded-stage")!.getBoundingClientRect();
  const inside = cards().filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.left >= stage.left && rect.right <= stage.left + stage.width * 0.55 && rect.top >= stage.top + 30 && rect.bottom <= stage.bottom;
  });
  return inside.sort((a, b) => (links.get(keyOf(b)) ?? 0) - (links.get(keyOf(a)) ?? 0))[0]!;
}

/** As quatro capturas, em `dir` (relativo ao arquivo de teste que chama), com os nomes do brief. */
export async function captureTree(project: Project, tickets: readonly TicketSummary[], dir: string) {
  const shot = (name: string) => page.screenshot({ path: `${dir}/${name}.png`, save: true });
  window.history.replaceState(null, "", "/?layout=tree");
  await page.viewport(1440, 900);
  const first = await render(<Host project={project} tickets={tickets} />);
  await settle(1500);
  await shot("1-primeira-vista");
  await wheel(center(nearMiddle()), -240);
  await settle();
  await shot("4-de-perto");
  document.querySelector<HTMLButtonElement>("button[aria-label='Ver a árvore inteira']")!.click();
  await settle(1200);
  await shot("2-arvore-inteira");
  await first.unmount();

  window.history.replaceState(null, "", "/?layout=tree");
  await render(<Host project={project} tickets={tickets} />);
  await settle(1500);
  mostLinked(tickets).click();
  await settle(1200);
  await shot("3-selecionado");
}

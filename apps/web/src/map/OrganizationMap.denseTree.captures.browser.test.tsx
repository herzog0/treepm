import { useState } from "react";
import { afterEach, describe, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "./map.css";
import "./agent-work.css";
import "@treepm/react/styles.css";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { wheel } from "../test/touch.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Capturas da árvore densa (ADR 0067, TREEPM-559): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em .vitest/cap (fora
// do Git) com o prefixo de `VITE_TREEPM_CAPTURE_TAG` (por exemplo `antes` ou `depois`), e quem roda os move para fora do repositório.
const env = import.meta.env as Record<string, string | undefined>;
const ON = env["VITE_TREEPM_CAPTURES"] === "1";
const TAG = env["VITE_TREEPM_CAPTURE_TAG"] ?? "mapa";
const DIR = "../../.vitest/cap";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${TAG}-${name}.png`, save: true });
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const project = makeProject("p1", "DENSO", "Projeto Denso");

type Status = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
const STATUSES: readonly Status[] = ["done", "in_progress", "todo", "in_review", "done", "todo", "cancelled"];

/**
 * Seis tickets de topo, cada um com 3 a 14 filhos, alguns com netos e bisnetos, bem desigual. Fixo: as capturas de antes e
 * depois usam o mesmo dado.
 */
function tickets() {
  const list: ReturnType<typeof makeTicket>[] = [];
  let number = 0;
  const add = (title: string, parentId: string | null) => {
    number += 1;
    const id = `t${number}`;
    list.push(makeTicket(id, "p1", number, title, { key: `DENSO-${number}`, status: STATUSES[number % STATUSES.length]!, parentId }));
    return id;
  };
  // [título do topo, filhos; cada filho: quantidade de netos e, por neto, quantidade de bisnetos]
  const shape: readonly [string, readonly (readonly number[])[]][] = [
    ["Pagamentos", [[], [3, 0, 2], [], [], [0, 5], [], [], [], [], [], [], [], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], []]],
    ["Acesso e contas", [[], [], [2]]],
    ["Relatórios", [[0, 0, 4, 0], [], [], [], [], [0, 0], [], []]],
    ["Integrações", [[], [], [], [], [], [], [], [], [], [], [], []]],
    ["Aplicativo móvel", [[6, 0, 0, 3, 0, 0, 0, 0], [], [0, 0, 0], [], []]],
    ["Documentação", [[], [], [], [], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [], [], [], [], []]],
  ];
  for (const [title, children] of shape) {
    const root = add(title, null);
    children.forEach((grandchildren, childIndex) => {
      const child = add(`${title} · parte ${childIndex + 1}`, root);
      grandchildren.forEach((greatCount, grandIndex) => {
        const grand = add(`Item ${childIndex + 1}.${grandIndex + 1}`, child);
        for (let great = 0; great < greatCount; great += 1) add(`Detalhe ${childIndex + 1}.${grandIndex + 1}.${great + 1}`, grand);
      });
    });
  }
  return list;
}

const press = (name: RegExp) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => name.test(entry.getAttribute("aria-label") ?? entry.textContent ?? ""));
  if (!button) throw new Error(`botão ${name} não encontrado`);
  button.click();
};

function Host() {
  const [open, setOpen] = useState<string | null>(null);
  const [api] = useState(() => makeTreeClient({ projects: [project], tickets: { p1: tickets() }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

describe.skipIf(!ON)("capturas da árvore densa", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await page.viewport(1280, 720);
  });
  for (const [width, height] of [[1440, 900], [1920, 1080]] as const) {
    it(`projeto denso em ${width}x${height}, modo cores`, async () => {
      await page.viewport(width, height);
      const screen = await render(<Host />);
      await settle();
      press(/DENSO · Projeto Denso/);
      await settle(300);
      press(/^Explorar ramo$/);
      await settle();
      // Fecha o painel do projeto e o cartão do ramo para ver só o mapa.
      press(/^Fechar$/);
      await settle(400);
      await userEvent.keyboard("{Escape}");
      await settle(400);

      press(/^Cores$/);
      await settle(400);
      // O cartão da seleção às vezes já fechou com o Esc.
      if (document.querySelector("button[aria-label='Fechar seleção']")) press(/^Fechar seleção$/);
      await settle(400);
      await shot(`${width}x${height}-projeto`);
      // De perto: aproxima da região dos filhos do ramo mais cheio (Pagamentos), recalculando a âncora a cada passo.
      const zoomIntoBranch = async (steps: number) => {
        for (let step = 0; step < steps; step += 1) {
          const card = document.querySelector<HTMLElement>('.spatial-node[data-spatial-id="t1"] .spatial-card-visual')!.getBoundingClientRect();
          await wheel({ x: card.left + card.width / 2, y: card.bottom + card.height * 0.8 }, -300);
          await settle(300);
        }
      };
      await zoomIntoBranch(3);
      await shot(`${width}x${height}-ramo`);
      await zoomIntoBranch(2);
      await shot(`${width}x${height}-perto`);
      await screen.unmount();
    }, 120_000);
  }
});

import { useState } from "react";
import { afterEach, describe, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
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

// Capturas da conferência visual das cores por situação (ADR 0051): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em .vitest/cap (fora do Git) e quem roda os move para fora do repositório.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const DIR = "../../.vitest/cap";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}.png`, save: true });
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));
const project = makeProject("p1", "ALFA", "Projeto Alfa");

type Status = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
/** Cinco ramos, um por situação dominante, com folhas suficientes para o mapa de longe mostrar pontos e chips. */
function tickets() {
  const list: ReturnType<typeof makeTicket>[] = [];
  let number = 0;
  const add = (title: string, parentId: string | null, status: Status, extra: Parameters<typeof makeTicket>[4] = {}) => {
    number += 1;
    const id = `t${number}`;
    list.push(makeTicket(id, "p1", number, title, { key: `ALFA-${number}`, status, parentId, ...extra }));
    return id;
  };
  const branch = (name: string, leaves: readonly [string, Status, boolean?][]) => {
    const root = add(name, null, "in_progress", { progress: { done: leaves.filter(([, s]) => s === "done").length, total: leaves.length, excluded: 0 } });
    for (const [title, status, blocked] of leaves) add(title, root, status, blocked ? { blocked: true } : {});
    return root;
  };
  branch("Pagamentos (bloqueado)", [["Cobrança", "done"], ["Cartão travado", "todo", true], ["Boleto", "in_progress"], ["Estorno", "todo"], ["Conciliação", "done"], ["Antifraude", "in_review"]]);
  branch("Acesso (andando)", [["Login", "done"], ["Recuperar senha", "in_progress"], ["Convites", "todo"], ["Papéis", "done"], ["Sessões", "in_review"], ["Auditoria", "cancelled"]]);
  branch("Relatórios (em revisão)", [["Mensal", "done"], ["Exportar", "in_review"], ["Filtros", "done"], ["Gráficos", "in_review"], ["Agendar", "done"]]);
  branch("Integrações (parado)", [["Webhook", "done"], ["API pública", "todo"], ["SDK", "todo"], ["Zapier", "todo"], ["Docs da API", "cancelled"]]);
  branch("Documentação (concluído)", [["Guia", "done"], ["Exemplos", "done"], ["Glossário", "done"], ["Vídeos", "done"], ["FAQ", "done"], ["Legado", "cancelled"]]);
  return list;
}

/** Clica pelo DOM (como as capturas do play): no celular um botão pode estar sob a barra de pedidos e o localizador esperaria até o limite. */
const press = (name: RegExp) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => name.test(entry.getAttribute("aria-label") ?? entry.textContent ?? ""));
  if (!button) throw new Error(`botão ${name} não encontrado`);
  button.click();
};

function Host({ initial = null }: { initial?: string | null }) {
  const [open, setOpen] = useState<string | null>(initial);
  const [api] = useState(() => makeTreeClient({ projects: [project], tickets: { p1: tickets() }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

describe.skipIf(!ON)("capturas das cores por situação", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.viewport(1280, 720);
  });
  for (const [tag, width, height] of [["1440", 1440, 900], ["390", 390, 844]] as const) {
    it(`mapa de longe, de perto, página e legenda em ${tag}`, async () => {
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: width < 721, maxTouchPoints: 5 });
      await page.viewport(width, height);
      const screen = await render(<Host />);
      await shot(`${tag}-inicio`);
      await settle();
      press(/ALFA · Projeto Alfa/);
      await settle(300);
      press(/^Explorar ramo$/);
      await settle();
      // No celular o painel do projeto ocupa a tela: fecha para ver o mapa.
      if (width < 721) {
        press(/^Fechar$/);
        await settle(600);
      }
      await shot(`${tag}-longe-modo-borda`);
      press(/^Cores$/);
      await settle(400);
      await shot(`${tag}-longe-modo-cores`);
      // De perto: aproxima do ramo bloqueado.
      const near = document.querySelector<HTMLElement>('.spatial-node[data-spatial-id="t1"] .spatial-card-visual')!.getBoundingClientRect();
      for (let step = 0; step < 4; step += 1) {
        await wheel({ x: near.left + near.width / 2, y: near.top + near.height / 2 }, -300);
        await settle(300);
      }
      await shot(`${tag}-perto-modo-cores`);
      press(/^Cores$/);
      await settle(400);
      await shot(`${tag}-perto-modo-borda`);
      press(/^Situações$/);
      await settle(300);
      await shot(`${tag}-legenda`);
      await screen.unmount();
      const page2 = await render(<Host initial="t3" />);
      await settle(1500);
      await shot(`${tag}-pagina-bloqueado`);
      await page2.unmount();
    }, 120_000);
  }
});

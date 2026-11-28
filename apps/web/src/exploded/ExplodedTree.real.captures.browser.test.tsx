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
import type { TicketSummary } from "../api/client.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTreeClient } from "../test/fakes.js";
import { captureTree } from "../test/treeCaptures.js";

// Capturas da árvore explodida com uma lista real de projeto, para conferência local. Só rodam com `VITE_TREEPM_CAPTURES=1` e
// `VITE_REAL_LIST=<caminho absoluto do JSON>`: o arquivo fica fora do Git e nada dele entra aqui. Os PNGs saem em `screenshots/arvore-real/`.
const env = import.meta.env as Record<string, string | undefined>;
const LIST = env["VITE_REAL_LIST"];
const ON = env["VITE_TREEPM_CAPTURES"] === "1" && LIST !== undefined;
const DIR = "../../../../screenshots/arvore-real";
const STEP = env["VITE_REAL_STEP"] ?? "depois";
const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}.png`, save: true });
const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

async function load(): Promise<TicketSummary[]> {
  const response = await fetch(`/@fs${LIST}`);
  if (!response.ok) throw new Error(`lista não encontrada: ${response.status}`);
  return (await response.json()) as TicketSummary[];
}

function Host({ tickets }: { tickets: TicketSummary[] }) {
  const projectId = tickets[0]!.projectId;
  const key = tickets[0]!.key.split("-")[0]!;
  const [open, setOpen] = useState<string | null>(null);
  const [api] = useState(() => makeTreeClient({ projects: [makeProject(projectId, key, "Projeto")], tickets: { [projectId]: tickets }, people: [] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={api} me={makePanelMe("admin")} openTicketId={open} onOpenTicketChange={setOpen} />
    </main>
  );
}

describe.skipIf(!ON)("capturas da árvore explodida com a lista real", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it.runIf(STEP === "depois")("depois: primeira vista, de perto, inteira e um ticket selecionado", async () => {
    const tickets = await load();
    const projectId = tickets[0]!.projectId;
    await captureTree(makeProject(projectId, tickets[0]!.key.split("-")[0]!, "Projeto"), tickets, DIR);
  });

  it.runIf(STEP === "antes")("antes: a primeira vista", async () => {
    window.history.replaceState(null, "", "/?layout=tree");
    await page.viewport(1440, 900);
    await render(<Host tickets={await load()} />);
    await settle(1500);
    await shot("0-antes");
  });
});

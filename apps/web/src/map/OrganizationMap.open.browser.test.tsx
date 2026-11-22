import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Clicar num ticket abre a página direto (TREEPM-180); arrastar o mapa por cima de um card continua sendo pan, em navegador real.
const project = makeProject("p1", "ALFA", "Projeto Alfa");

function Harness() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [client] = useState(() => makeTreeClient({
    projects: [project],
    tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1", status: "in_progress" }), makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2" })] },
    people: [makePerson("person-1", "Ana")],
  }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={openId} onOpenTicketChange={setOpenId} />
    </main>
  );
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

async function exploreAlfa(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
  await screen.getByRole("button", { name: "Explorar ramo" }).click();
  await settle();
}

describe("abrir o ticket pelo mapa, em navegador real", () => {
  it("um clique abre a página; sem cartão de seleção", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    await exploreAlfa(screen);
    await screen.getByRole("button", { name: /ALFA-2 · Publicação/ }).click();
    await expect.element(screen.getByRole("heading", { level: 1, name: "Publicação" })).toBeVisible();
    expect(document.querySelector(".spatial-selection")).toBeNull();
  });

  it("arrastar o mapa começando sobre um card faz pan e não abre o ticket", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    await exploreAlfa(screen);
    const card = screen.getByRole("button", { name: /ALFA-2 · Publicação/ });
    const before = card.element().getBoundingClientRect();
    // Mouse de verdade: pressiona sobre o card, arrasta até o palco e solta; o clique que o navegador gera depois não pode abrir nada.
    await userEvent.dragAndDrop(card, screen.getByRole("region", { name: "Mapa da organização" }), { sourcePosition: { x: 10, y: 10 }, targetPosition: { x: 300, y: 300 } });
    await settle();
    const after = card.element().getBoundingClientRect();
    expect(Math.abs(after.left - before.left) + Math.abs(after.top - before.top)).toBeGreaterThan(50);
    expect(document.querySelector("[aria-label='Página do ticket']")).toBeNull();
  });
});

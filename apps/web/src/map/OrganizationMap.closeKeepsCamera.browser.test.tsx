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

// Fechar a página do ticket não mexe na câmera (TREEPM-181): ela fica onde está, mesmo depois de pan com a página aberta.
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

/** Posição do mundo no palco: a do cartão do projeto relativa ao canto do palco, que só muda quando a câmera muda. */
function projectSpot() {
  const stage = document.querySelector(".spatial-stage, [aria-label='Mapa da organização']")!.getBoundingClientRect();
  const card = [...document.querySelectorAll("button")].find((b) => /ALFA · Projeto Alfa/.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))!.getBoundingClientRect();
  return { x: Math.round(card.left - stage.left), y: Math.round(card.top - stage.top), w: Math.round(card.width) };
}

async function openAndPan(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
  await screen.getByRole("button", { name: "Explorar ramo" }).click();
  await settle();
  await screen.getByRole("button", { name: /ALFA-2 · Publicação/ }).click();
  await expect.element(screen.getByRole("heading", { level: 1, name: "Publicação" })).toBeVisible();
  await settle();
  // Pan com a página aberta: arrasta o palco numa área vazia.
  const stage = screen.getByRole("region", { name: "Mapa da organização" });
  await userEvent.dragAndDrop(stage, stage, { sourcePosition: { x: 40, y: 400 }, targetPosition: { x: 140, y: 330 } });
  await settle();
  return projectSpot();
}

describe("fechar a página do ticket, em navegador real", () => {
  it("o botão de fechar deixa a câmera onde está, inclusive depois de um pan", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    const before = await openAndPan(screen);
    await screen.getByRole("button", { name: "Fechar e voltar ao mapa" }).click();
    await settle();
    expect(document.querySelector("[aria-label='Página do ticket']")).toBeNull();
    expect(projectSpot()).toEqual(before);
  });

  it("Esc deixa a câmera onde está, inclusive depois de um pan", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    const before = await openAndPan(screen);
    await userEvent.keyboard("{Escape}");
    await settle();
    expect(document.querySelector("[aria-label='Página do ticket']")).toBeNull();
    expect(projectSpot()).toEqual(before);
  });
});

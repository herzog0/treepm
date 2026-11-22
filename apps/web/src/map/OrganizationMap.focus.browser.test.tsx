import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// "Ver no mapa" da tela "Ideias" (ADR 0042): a câmera vai até o ticket, sem abrir a página, e o pedido é tratado uma vez.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const settle = () => new Promise((resolve) => setTimeout(resolve, 900));

function client() {
  return makeTreeClient({
    projects: [project],
    tickets: {
      p1: [
        makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1", status: "in_progress" }),
        makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2", parentId: "t1", idea: { root: true, stage: "new" } }),
        makeTicket("t3", "p1", 3, "Relatórios", { key: "ALFA-3" }),
      ],
    },
    people: [makePerson("person-1", "Ana")],
  });
}

describe("câmera na ideia, em navegador real", () => {
  it("enquadra o ticket pedido, não abre a página e avisa que tratou o pedido", async () => {
    await page.viewport(1440, 900);
    const onFocusHandled = vi.fn();
    const screen = await render(
      <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
        <OrganizationMap client={client()} me={makePanelMe("admin")} openTicketId={null} onOpenTicketChange={() => undefined} focusTicketId="t2" onFocusHandled={onFocusHandled} />
      </main>,
    );
    await settle();
    const card = screen.getByRole("button", { name: /ALFA-2 · Publicação/ });
    await expect.element(card).toBeVisible();
    const rect = card.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(rect.width).toBeGreaterThan(120);
    expect(document.querySelector("[aria-label='Página do ticket']")).toBeNull();
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });
});

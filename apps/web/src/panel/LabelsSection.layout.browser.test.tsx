import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { Label } from "../api/client.js";
import { makeProject, makeTicket } from "../test/fakes.js";
import { SidePanel } from "./SidePanel.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

// Seção "Etiquetas" das configurações (ADR 0065) em Chromium real, revisão E1, item 6: o nome de 60 caracteres sem espaço quebra dentro
// da caixa na confirmação de apagar, em 1440 e 414 px.
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(async () => {
  await page.viewport(1440, 900);
});

const alpha = makeProject("p1", "ENG", "Engenharia");
const LONG = "W".repeat(60);
const labels: Label[] = [
  { id: "l1", name: "Bug", color: "rose" },
  { id: "l2", name: LONG, color: "indigo" },
];
const tickets = [makeTicket("t1", "p1", 1, "Um", { labels: [labels[0]!, labels[1]!] })];

describe("Etiquetas nas configurações: nome longo sem espaço", () => {
  for (const width of [1440, 414]) {
    it(`${width} px: a confirmação de apagar quebra o nome dentro do painel, sem rolagem horizontal`, async () => {
      await page.viewport(width, 900);
      const me = makePanelMe("admin");
      const client = makePanelClient({ projects: [alpha], people: [makePerson("person-1", "Ana")], me, tickets: { p1: tickets.map((t) => ({ ...t })) }, labels: { p1: labels } });
      const noop = () => undefined;
      const screen = await render(
        <div style={{ position: "relative", width: "100vw", height: "100vh", background: "var(--tp-bg)" }}>
          <SidePanel client={client} me={me} projects={[alpha]} tab="projects" selectedProjectId="p1" onTabChange={noop} onClose={noop} onChanged={noop} />
        </div>,
      );
      await expect.element(screen.getByRole("region", { name: "Etiquetas" }).getByText("Bug", { exact: true })).toBeVisible();
      await userEvent.click(document.querySelector<HTMLButtonElement>(`button[aria-label="Apagar etiqueta ${LONG}"]`)!);
      await settle(200);
      const panel = document.querySelector(".side-panel")!.getBoundingClientRect();
      const right = Math.min(panel.right, document.documentElement.clientWidth) + 0.5;
      const outside = [...document.querySelectorAll(".panel-labels button, .panel-labels .label-pill, .panel-labels .confirm-message")]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < panel.left - 0.5 || box.right > right;
        })
        .map((element) => element.getAttribute("aria-label") ?? element.textContent);
      expect({ outside, scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth }).toEqual({ outside: [], scrollX: 0 });
    });
  }
});

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "../map/OrganizationMap.js";

// ADR 0042, fatia 3: a folha da barra de pedidos com "Registrar ideia", desenhada de verdade, larga e estreita.
// As capturas de conferência visual só saem com VITE_TREEPM_CAPTURES definida (a pasta de destino).
const dir = import.meta.env["VITE_TREEPM_CAPTURES"] as string | undefined;
const shot = async (name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

describe.each([
  ["1440x900", 1440, 900],
  ["390x844", 390, 844],
] as const)("barra de pedidos em %s", (size, width, height) => {
  it("mostra 'Registrar ideia' entre 'Criar ticket' e 'Perguntar ao assistente', dentro da tela", async () => {
    await page.viewport(width, height);
    const client = makeTreeClient({
      projects: [makeProject("p1", "ALFA", "Projeto Alfa")],
      tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1" })] },
      people: [makePerson("person-1", "Ana")],
    });
    const me = { ...makePanelMe("admin"), assistant: { enabled: true } };
    const screen = await render(
      <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
        <OrganizationMap client={client} me={me} openTicketId={null} onOpenTicketChange={() => undefined} />
      </main>,
    );
    await screen.getByRole("combobox", { name: "Peça qualquer coisa" }).click();
    await userEvent.keyboard("exportar relatórios em csv");
    const line = screen.getByRole("option", { name: /Registrar ideia «exportar relatórios em csv»/ });
    await expect.element(line).toBeVisible();
    const rect = line.element().getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    const create = screen.getByRole("option", { name: /Criar ticket/ }).element().getBoundingClientRect();
    const ask = screen.getByRole("option", { name: /Perguntar ao assistente/ }).element().getBoundingClientRect();
    expect(create.top).toBeLessThan(rect.top);
    expect(rect.top).toBeLessThan(ask.top);
    await userEvent.keyboard("{ArrowDown}");
    await shot(`barra-registrar-ideia-${size}`);
  });
});

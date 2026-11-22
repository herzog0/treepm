import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { Me, TicketSummary } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { IdeasScreen } from "./IdeasScreen.js";
import { resetIdeasSession } from "./session.js";

// ADR 0042, fatia 3, em navegador real: a tela "Ideias" desenhada com o tema do app, larga e estreita.
// As capturas de conferência visual só saem com VITE_TREEPM_CAPTURES definida (a pasta de destino).
const dir = import.meta.env["VITE_TREEPM_CAPTURES"] as string | undefined;
const shot = async (name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const idea = (stage: "new" | "refining" | "ready" | "discarded") => ({ idea: { root: true as const, stage } });
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Login com Google", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("i1", "p1", 3, "Exportar relatórios em CSV com os filtros da tela e o período escolhido", { key: "ALFA-3", parentId: "t2", ...idea("ready") }),
  makeTicket("i2", "p1", 4, "Modo escuro", { key: "ALFA-4", ...idea("refining") }),
  makeTicket("i3", "p1", 5, "Notificações por e-mail", { key: "ALFA-5", parentId: "t1", ...idea("new") }),
  makeTicket("i4", "p1", 6, "Painel antigo de métricas", { key: "ALFA-6", ...idea("discarded") }),
  makeTicket("i5", "p1", 7, "Atalhos de teclado", { key: "ALFA-7", ...idea("new") }),
];
const ideaCreatedAt = { i1: hoursAgo(3), i2: hoursAgo(5), i3: hoursAgo(30), i4: hoursAgo(24 * 12), i5: hoursAgo(2) };
const manager = (): Me => makePanelMe("member", [{ projectId: "p1", role: "manager" }, { projectId: "p2", role: "manager" }]);
const reader = (): Me => makePanelMe("member", [{ projectId: "p1", role: "reader" }, { projectId: "p2", role: "reader" }]);

function Screen({ me }: { me: Me }) {
  resetIdeasSession();
  const client = makeTreeClient({ projects, tickets: { p1: tickets, p2: [] }, ideaCreatedAt });
  return (
    <div className="tenant-shell" style={{ minHeight: "100%", display: "block" }}>
      <IdeasScreen client={client} me={me} onOpenIdea={() => undefined} onShowOnMap={() => undefined} />
    </div>
  );
}
const noSideScroll = () => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);

describe.each([
  ["1440x900", 1440, 900],
  ["390x844", 390, 844],
] as const)("tela Ideias em %s", (size, width, height) => {
  it("mostra os grupos, as linhas e as ações do gestor sem rolagem lateral", async () => {
    await page.viewport(width, height);
    const screen = await render(<Screen me={manager()} />);
    await expect.element(screen.getByRole("heading", { name: /Pronta para triagem/ })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Aceitar ALFA-3" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Descartar ALFA-3" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Abrir ALFA-3" })).toBeVisible();
    noSideScroll();
    await screen.getByRole("button", { name: /Descartada/ }).click();
    await expect.element(screen.getByRole("button", { name: "Reabrir ALFA-6" })).toBeVisible();
    noSideScroll();
    await shot(`ideias-gestor-${size}`);
    await screen.getByRole("button", { name: "Aceitar ALFA-3" }).click();
    await expect.element(screen.getByRole("button", { name: "Confirmar: Aceitar ALFA-3" })).toBeVisible();
    noSideScroll();
    await shot(`ideias-aceitar-confirmacao-${size}`);
  });

  it("para quem só lê, mostra a lista sem os botões de triagem", async () => {
    await page.viewport(width, height);
    const screen = await render(<Screen me={reader()} />);
    await expect.element(screen.getByRole("button", { name: "Abrir ALFA-3" })).toBeVisible();
    expect(document.querySelector("button[aria-label^='Aceitar']")).toBeNull();
    expect(document.querySelector("button[aria-label^='Descartar']")).toBeNull();
    noSideScroll();
    await shot(`ideias-leitor-${size}`);
  });
});

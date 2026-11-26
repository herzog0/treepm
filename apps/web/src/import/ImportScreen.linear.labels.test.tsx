import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectLinear } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makeLinearConnection, makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLinear, FakeLinearRun } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ENG", "Engenharia");
const LINKED: ProjectLinear = {
  source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: "person-1" } },
  canLink: false,
  keyMatches: true,
};
const tickets = [makeTicket("t1", "p1", 1, "Fase um", { key: "ENG-1" })];

function setup(run: FakeLinearRun) {
  window.location.hash = "#linear";
  const me = makePanelMe("admin");
  const linear: FakeLinear = { connection: makeLinearConnection(), projects: { p1: LINKED }, run };
  const client = makeClient({ me, projects: [project], tickets: { p1: tickets }, linear });
  const onExit = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(<ImportScreen client={client} me={me} projectId="p1" onExit={onExit} onOpenSettings={onOpenSettings} />);
  return { client, onExit, onOpenSettings, ...view };
}
afterEach(async () => {
  window.location.hash = "";
  await setTestLanguage("pt-BR");
});

// Etiquetas do Linear (ADR 0065, seção 5): as contagens novas no resumo da rodada, só quando maiores que zero, nos três idiomas.
const done = (counts: Record<string, number | boolean>, mode: "first" | "reimport" = "reimport") => ({ existing: { phase: "done" as const, done: true, mode, counts } });
const ALL = { labelsCreated: 3, labelsAdopted: 2, labelsUpdated: 4, labelsRenameTaken: 1, labelsAdded: 12, labelsRemoved: 5, labelsOverTicketLimit: 6, labelsOverProjectLimit: 7, labelsNameInvalid: 8, labelsUnread: 9, labelsInvalid: 10 };
const PT: [string, string][] = [
  ["Etiquetas criadas no projeto", "3"],
  ["Etiquetas que já existiam aqui, ligadas às do Linear", "2"],
  ["Etiquetas renomeadas ou recoloridas como no Linear", "4"],
  ["Etiquetas não renomeadas (o nome já é de outra etiqueta)", "1"],
  ["Etiquetas postas em tickets", "12"],
  ["Etiquetas tiradas de tickets", "5"],
  ["Etiquetas não postas (limite de 20 por ticket)", "6"],
  ["Etiquetas não criadas (limite de 200 no projeto)", "7"],
  ["Etiquetas ignoradas (nome vazio)", "8"],
  ["Etiquetas não lidas nesta rodada", "9"],
  ["Etiquetas ignoradas por formato inválido", "10"],
];

describe("Importação do Linear › resumo, etiquetas", () => {
  it.each(["first", "reimport"] as const)("mostra cada contagem de etiquetas com o número (%s)", async (mode) => {
    setup(done({ issuesCreated: 1, ...ALL }, mode));
    const list = await screen.findByLabelText("Contagens da importação");
    for (const [text, value] of PT) expect(within(list).getByText(text).nextSibling, text).toHaveTextContent(value);
  });

  it("com zero, nenhuma linha de etiqueta aparece", async () => {
    setup(done({ issuesCreated: 1, ...Object.fromEntries(Object.keys(ALL).map((key) => [key, 0])) }));
    const list = await screen.findByLabelText("Contagens da importação");
    expect(within(list).queryByText(/^Etiquetas/)).not.toBeInTheDocument();
  });

  it.each([
    ["en", "Import counts", "Labels created in the project", "Labels not read in this run"],
    ["es-MX", "Conteos de la importación", "Etiquetas creadas en el proyecto", "Etiquetas no leídas en esta ronda"],
  ] as const)("em %s", async (language, label, created, unread) => {
    await setTestLanguage(language);
    setup(done({ issuesCreated: 1, labelsCreated: 2, labelsUnread: 1 }));
    const list = await screen.findByLabelText(label);
    expect(within(list).getByText(created).nextSibling).toHaveTextContent("2");
    expect(within(list).getByText(unread).nextSibling).toHaveTextContent("1");
  });
});

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ActivityPage, ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0065: pôr e tirar etiquetas aparece na linha do tempo do ticket com o nome da época; apagar a etiqueta (evento de projeto) não.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" })];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const NOW = new Date("2026-11-22T12:00:00Z");
const named = (...names: string[]) => names.map((name, index) => ({ id: `l${index}-${name}`, name }));
let counter = 0;
const labels = (added: string[], removed: string[], extra: Record<string, unknown> = {}): unknown => ({
  id: `e${++counter}`, occurredAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), actor: ana, type: "labels_changed", added: named(...added), removed: named(...removed), ...extra,
});

function setup(entries: unknown[]) {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  const page = { entries: entries as ActivityEntry[], before: null, canComment: false } satisfies ActivityPage;
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    ticketActivity: vi.fn(async () => ok(page)),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />);
}
const textOf = (row: HTMLElement) => row.querySelector(".ticket-activity-text")?.textContent?.replace(/\s+/g, " ").trim();
const texts = async (region = "Atividade") => (await within(await screen.findByRole("region", { name: region })).findAllByRole("listitem")).map(textOf);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  await setTestLanguage("pt-BR");
});

describe("linha do tempo: etiquetas", () => {
  it.each([
    [labels(["Bug"], []), /^Ana adicionou a etiqueta Bug/],
    [labels(["Bug", "Front"], []), /^Ana adicionou as etiquetas Bug e Front/],
    [labels(["Bug", "Front", "Urgente"], []), /^Ana adicionou as etiquetas Bug, Front e Urgente/],
    [labels([], ["Bug"]), /^Ana tirou a etiqueta Bug/],
    [labels([], ["Bug", "Front"]), /^Ana tirou as etiquetas Bug e Front/],
    [labels(["Bug"], ["Front"]), /^Ana adicionou a etiqueta Bug e tirou a etiqueta Front/],
    [labels(["Bug"], ["Front", "Back"]), /^Ana adicionou a etiqueta Bug e tirou as etiquetas Front e Back/],
    [labels(["Bug", "Front"], ["Back"]), /^Ana adicionou as etiquetas Bug e Front e tirou a etiqueta Back/],
    [labels(["Bug", "Front"], ["Back", "Velha"]), /^Ana adicionou as etiquetas Bug e Front e tirou as etiquetas Back e Velha/],
    [labels(["Bug"], [], { actor: null }), /^Etiqueta Bug adicionada/],
    [labels([], ["Bug", "Front"], { actor: null }), /^Etiquetas Bug e Front tiradas/],
    [labels(["Bug"], ["Front"], { actor: null }), /^Etiqueta Bug adicionada e etiqueta Front tirada/],
    [labels(["Bug"], [], { actor: null, automatic: true }), /^Etiqueta Bug adicionada automaticamente/],
    [labels(["Bug", "Front"], [], { actor: null, automatic: true }), /^Etiquetas Bug e Front adicionadas automaticamente/],
    [labels([], ["Bug"], { actor: null, automatic: true }), /^Etiqueta Bug tirada automaticamente/],
    [labels(["Bug"], ["Front", "Back"], { actor: null, automatic: true }), /^Etiqueta Bug adicionada e etiquetas Front e Back tiradas automaticamente/],
  ])("%j", async (item, expected) => {
    setup([item]);
    const [text] = await texts();
    expect(text).toMatch(expected);
  });

  it("o nome vem do evento (nome da época), em destaque", async () => {
    setup([labels(["Nome antigo"], [])]);
    await texts();
    expect(screen.getByText("Nome antigo").tagName).toBe("STRONG");
  });

  it.each([
    ["en", "Activity", labels(["Bug"], []), /^Ana added the label Bug/],
    ["en", "Activity", labels(["Bug", "Front"], ["Back"]), /^Ana added the labels Bug and Front and removed the label Back/],
    ["en", "Activity", labels([], ["Bug", "Front"], { actor: null, automatic: true }), /^Labels Bug and Front removed automatically/],
    ["es-MX", "Actividad", labels(["Bug"], []), /^Ana agregó la etiqueta Bug/],
    ["es-MX", "Actividad", labels(["Bug"], ["Front", "Back"]), /^Ana agregó la etiqueta Bug y quitó las etiquetas Front y Back/],
    ["es-MX", "Actividad", labels(["Bug", "Front"], [], { actor: null, automatic: true }), /^Etiquetas Bug y Front agregadas automáticamente/],
  ] as const)("em %s: %j", async (language, region, item, expected) => {
    await setTestLanguage(language);
    setup([item]);
    const [text] = await texts(region);
    expect(text).toMatch(expected);
  });
});

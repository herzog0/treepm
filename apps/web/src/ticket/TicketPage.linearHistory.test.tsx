import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ActivityPage, ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0061, fatia 4 (TREEPM-482): o histórico das issues trazido do Linear na seção "Atividade".
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Outro ticket", { key: "ALFA-2" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno", avatarUrl: "https://img.test/bruno.png" };
const NOW = new Date("2026-11-22T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
let counter = 0;
const page = (entries: ActivityEntry[], before: string | null = null): ActivityPage => ({ entries, before, canComment: false });
const ref = (n: number, title = `Título ${n}`) => ({ id: `r${n}`, key: `ALFA-${n}`, title });

function setup(pages: Record<string, ActivityPage> | ((before?: string) => Promise<unknown>), options: { archived?: boolean } = {}) {
  const proj = options.archived ? makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project;
  const client = makeClient({ projects: [proj], people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")], tickets: { p1: summaries } });
  const ticketActivity = vi.fn(async (_id: string, query: { before?: string } = {}) => {
    if (typeof pages === "function") return pages(query.before) as never;
    const found = pages[query.before ?? ""];
    return found ? ok(found) : failed("unavailable");
  });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    updateTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((s) => s.id === id)!))),
    ticketActivity,
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[proj]} ticketId="t1" creating={null} {...handlers} />);
  return { client, ticketActivity, ...handlers };
}
const section = () => screen.findByRole("region", { name: "Atividade" });
const rows = async () => within(await section()).findAllByRole("listitem");
const textOf = (row: HTMLElement) => row.querySelector(".ticket-activity-text")?.textContent?.replace(/\s+/g, " ").trim();
const texts = async () => (await rows()).map(textOf);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  await setTestLanguage("pt-BR");
});

type Change = Extract<ActivityEntry, { type: "linear_history" }>["changes"][number];
const history = (changes: Change[], who: { actor?: ActivityEntry["actor"]; externalActor?: { name: string | null } } = {}): ActivityEntry =>
  ({ id: `e${++counter}`, occurredAt: at(5), type: "linear_history", actor: who.actor === undefined ? ana : who.actor, ...(who.externalActor ? { externalActor: who.externalActor } : {}), changes }) as ActivityEntry;
const linearSide = (name: string | null) => ({ kind: "linear" as const, name });
const personSide = (person: { id: string; displayName: string; avatarUrl: string | null } | null) => ({ kind: "person" as const, person });
const unknownRef = { id: null, key: null, title: null };
const row = async () => (await rows())[0]!;
/** A frase sem o selo “do Linear” (que é uma etiqueta à parte); `badged` diz se o selo está lá. */
const sentence = (item: HTMLElement) => {
  const copy = item.querySelector(".ticket-activity-text")!.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".ticket-via").forEach((badge) => badge.remove());
  return copy.textContent?.replace(/\s+/g, " ").trim();
};
const badged = (item: HTMLElement) => item.querySelector(".ticket-activity-text .ticket-via")?.textContent ?? null;

describe("Atividade › histórico do Linear (ADR 0061, fatia 4)", () => {
  it.each<[Change, RegExp]>([
    [{ field: "status", from: { name: "Backlog", type: "backlog" }, to: { name: "In Review", type: "started" } }, /^Ana mudou a situação de Backlog para In Review/],
    [{ field: "status", from: null, to: { name: "Todo", type: "unstarted" } }, /^Ana mudou a situação para Todo/],
    // Coluna de tipo fora dos seis do Linear: o tipo vem nulo (a API manda assim) e a linha continua mostrando o nome.
    [{ field: "status", from: { name: "Esperando QA", type: null }, to: { name: "Done", type: "completed" } }, /^Ana mudou a situação de Esperando QA para Done/],
    [{ field: "assignee", from: null, to: personSide(bruno) }, /^Ana atribuiu a Bruno/],
    [{ field: "assignee", from: personSide(bruno), to: null }, /^Ana tirou Bruno dos responsáveis/],
    [{ field: "assignee", from: personSide(bruno), to: linearSide("Carla") }, /^Ana trocou o responsável de Bruno para Carla \(no Linear\)/],
    [{ field: "assignee", from: linearSide(null), to: personSide(null) }, /^Ana trocou o responsável de Pessoa do Linear para Pessoa removida/],
    [{ field: "priority", from: 100, to: 300 }, /^Ana mudou a prioridade de 100 para 300/],
    [{ field: "title", from: "Antes", to: "Depois" }, /^Ana renomeou de «Antes» para «Depois»/],
    [{ field: "parent", from: null, to: ref(12, "Pai") }, /^Ana moveu para dentro de ALFA-12 Pai/],
    [{ field: "parent", from: ref(12, "Pai"), to: null }, /^Ana tirou de dentro de ALFA-12 Pai/],
    [{ field: "parent", from: ref(12, "Pai"), to: ref(13, "Outro") }, /^Ana moveu de ALFA-12 Pai para dentro de ALFA-13 Outro/],
    [{ field: "parent", from: unknownRef, to: unknownRef }, /^Ana mudou de pai no Linear/],
    [{ field: "parent", from: null, to: unknownRef }, /^Ana mudou de pai no Linear/],
    [{ field: "project", from: null, to: ref(20, "Lançamento") }, /^Ana pôs no projeto ALFA-20 Lançamento/],
    [{ field: "project", from: ref(20, "Lançamento"), to: null }, /^Ana tirou do projeto ALFA-20 Lançamento/],
    [{ field: "project", from: ref(20, "Lançamento"), to: ref(21, "Beta") }, /^Ana mudou do projeto ALFA-20 Lançamento para ALFA-21 Beta/],
    [{ field: "project", from: unknownRef, to: null }, /^Ana mudou de projeto no Linear/],
    [{ field: "description" }, /^Ana alterou a descrição/],
  ])("%j", async (change, expected) => {
    setup({ "": page([history([change])]) });
    const [text] = await texts();
    expect(text).toMatch(expected);
  });

  it("a pessoa casada tem avatar, o selo “do Linear” e a data original", async () => {
    setup({ "": page([history([{ field: "description" }], { actor: bruno })]) });
    const item = await row();
    expect(item.querySelector(".ticket-avatar img")).not.toBeNull();
    expect(sentence(item)).toBe("Bruno alterou a descrição");
    expect(badged(item)).toBe("do Linear");
    expect(item.querySelector("time")?.getAttribute("dateTime")).toBe(at(5));
  });

  it("autor do Linear sem pessoa aqui: “<nome> (no Linear)” sem avatar de pessoa; nome nulo: “Pessoa do Linear”", async () => {
    setup({ "": page([history([{ field: "description" }], { actor: null, externalActor: { name: "Carla" } }), history([{ field: "description" }], { actor: null, externalActor: { name: null } })]) });
    // A API manda da mais nova para a mais antiga; a tela mostra ao contrário.
    const [second, first] = await rows();
    expect(textOf(first!)).toMatch(/^Carla \(no Linear\) alterou a descrição/);
    expect(first!.querySelector(".ticket-avatar.is-system")).not.toBeNull();
    expect(textOf(second!)).toMatch(/^Pessoa do Linear alterou a descrição/);
  });

  it("robô do Linear: o nome dele, como autor do Linear", async () => {
    setup({ "": page([history([{ field: "status", from: { name: "Todo", type: "unstarted" }, to: { name: "Done", type: "completed" } }], { actor: null, externalActor: { name: "GitHub" } })]) });
    expect(textOf(await row())).toMatch(/^GitHub \(no Linear\) mudou a situação de Todo para Done/);
  });

  it("autor sem pessoa nem nome do Linear: pessoa removida", async () => {
    setup({ "": page([history([{ field: "description" }], { actor: null })]) });
    expect(textOf(await row())).toMatch(/^Pessoa removida alterou a descrição/);
  });

  it("várias mudanças numa entrada: uma linha só, as frases juntas por “;”", async () => {
    setup({ "": page([history([{ field: "status", from: { name: "Todo", type: "unstarted" }, to: { name: "In Progress", type: "started" } }, { field: "assignee", from: null, to: personSide(bruno) }, { field: "priority", from: 0, to: 200 }])]) });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(sentence(all[0]!)).toBe("Ana mudou a situação de Todo para In Progress; atribuiu a Bruno; mudou a prioridade de 0 para 200");
  });

  it("o ticket citado é clicável", async () => {
    const { onOpenTicket } = setup({ "": page([history([{ field: "parent", from: null, to: ref(12, "Pai") }])]) });
    await userEvent.click(within(await row()).getByRole("button", { name: "ALFA-12 Pai" }));
    expect(onOpenTicket).toHaveBeenCalledWith("r12");
  });

  it("“criou a issue no Linear” com o autor e o selo", async () => {
    setup({ "": page([
      { id: "c1", occurredAt: at(9), actor: ana, type: "linear_created" } as ActivityEntry,
      { id: "c2", occurredAt: at(8), actor: null, type: "linear_created", externalActor: { name: "Carla" } } as ActivityEntry,
    ]) });
    const all = await rows();
    expect(all.map(sentence)).toEqual(["Carla (no Linear) criou a issue no Linear", "Ana criou a issue no Linear"]);
    expect(all.map(badged)).toEqual(["do Linear", "do Linear"]);
  });

  it("resumo da rodada: N registros do histórico trazidos do Linear, com plural", async () => {
    setup({ "": page([
      { id: "h1", occurredAt: at(9), actor: null, type: "history_imported", count: 1, automatic: true } as ActivityEntry,
      { id: "h2", occurredAt: at(8), actor: null, type: "history_imported", count: 14, automatic: true } as ActivityEntry,
    ]) });
    expect(await texts()).toEqual(["14 registros do histórico trazidos do Linear", "1 registro do histórico trazido do Linear"]);
  });

  it.each([
    ["en", "Ana changed the status from Todo to Done; assigned to Carla (on Linear); renamed from «A» to «B»", "Carla (on Linear) created the issue on Linear", "3 history records brought from Linear"],
    ["es-MX", "Ana cambió el estado de Todo a Done; asignó a Carla (en Linear); renombró de «A» a «B»", "Carla (en Linear) creó el issue en Linear", "3 registros del historial traídos de Linear"],
  ])("em %s", async (language, change, created, imported) => {
    await setTestLanguage(language as "en");
    setup({ "": page([
      { id: "h1", occurredAt: at(3), actor: null, type: "history_imported", count: 3, automatic: true } as ActivityEntry,
      { id: "c1", occurredAt: at(4), actor: null, type: "linear_created", externalActor: { name: "Carla" } } as ActivityEntry,
      history([{ field: "status", from: { name: "Todo", type: "unstarted" }, to: { name: "Done", type: "completed" } }, { field: "assignee", from: null, to: linearSide("Carla") }, { field: "title", from: "A", to: "B" }]),
    ]) });
    const items = await within(await screen.findByRole("region", { name: language === "en" ? "Activity" : "Actividad" })).findAllByRole("listitem");
    expect(items.map(sentence)).toEqual([change, created, imported]);
  });
});

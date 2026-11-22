import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ApiClient, TicketSummary } from "../api/client.js";
import { formatDateTime } from "../i18n/format.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";
import type { TicketPageProps } from "./TicketPage.js";

// ADR 0043, fatia 3: o marcador de trabalho pela IA na página do ticket, as entradas dele na atividade e a etiqueta "pelo MCP".
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const now = Date.now();
const since = new Date(now - 10 * 60_000).toISOString();
const until = new Date(now + 50 * 60_000).toISOString();
const working = { since, until, note: "escrevendo os testes" };
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const base = (extra: Partial<TicketSummary> = {}) => [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1", ...extra })];

function setup(options: { tickets?: TicketSummary[]; canEnd?: boolean; entries?: ActivityEntry[]; props?: Partial<TicketPageProps>; member?: boolean } = {}) {
  const client = makeTreeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: options.tickets ?? base({ agentWork: working }) }, ...(options.canEnd === undefined ? {} : { canEndAgentWork: options.canEnd }) });
  Object.assign(client, { ticketActivity: vi.fn(async () => ok({ entries: options.entries ?? [], before: null, canComment: false })) });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const element = (extra: Partial<TicketPageProps> = {}) => (
    <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} {...options.props} {...extra} />
  );
  const view = render(element());
  return { client, ...handlers, ...view, element };
}
const row = async () => (await screen.findByText("Em trabalho pela IA", { selector: "dt" })).closest(".ticket-row") as HTMLElement;

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("ticket page: the agent-work row", () => {
  it("shows who, until when (with the full date and time in the title) and the note", async () => {
    setup();
    const line = within(await row());
    expect(line.getByText("Ana")).toBeInTheDocument();
    const time = line.getByText(/^até \d{2}:\d{2}$/);
    expect(time).toHaveAttribute("title", formatDateTime("pt-BR", until));
    expect(line.getByText("escrevendo os testes")).toBeInTheDocument();
  });

  it("shows an agent's note as plain text, never as markup", async () => {
    const hostile = '<img src=x onerror="alert(1)"><b>negrito</b>';
    setup({ tickets: base({ agentWork: { since, until, note: hostile } }) });
    const line = within(await row());
    expect(line.getByText(hostile)).toBeInTheDocument();
    expect((await row()).querySelector("img, b")).toBeNull();
  });

  it("omits the note when there is none", async () => {
    setup({ tickets: base({ agentWork: { since, until, note: null } }) });
    expect(within(await row()).queryByText("escrevendo os testes")).not.toBeInTheDocument();
  });

  it.each([
    ["no marker", base()],
    ["an expired marker", base({ agentWork: { since, until: new Date(now - 1000).toISOString(), note: null } })],
  ])("has no row with %s", async (_name, tickets) => {
    setup({ tickets });
    await screen.findByRole("heading", { name: "Este ticket" });
    expect(screen.queryByText("Em trabalho pela IA")).not.toBeInTheDocument();
  });

  it("ends the marker after the standard confirmation, for whoever may", async () => {
    const { client, onChanged } = setup();
    await userEvent.click(within(await row()).getByRole("button", { name: "Encerrar" }));
    expect(client.endAgentWork).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    await waitFor(() => expect(client.endAgentWork).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(screen.queryByText("Em trabalho pela IA", { selector: "dt" })).not.toBeInTheDocument());
    expect(onChanged).toHaveBeenCalled();
  });

  it("offers no 'Encerrar' without permission", async () => {
    setup({ canEnd: false });
    expect(within(await row()).queryByRole("button", { name: "Encerrar" })).not.toBeInTheDocument();
  });

  it("speaks the other languages", async () => {
    await setTestLanguage("en");
    setup();
    const line = within((await screen.findByText("Being worked on by AI", { selector: "dt" })).closest(".ticket-row") as HTMLElement);
    expect(line.getByRole("button", { name: "End" })).toBeInTheDocument();
    expect(line.getByText(/^until \d{1,2}:\d{2}/)).toBeInTheDocument();
  });
});

describe("ticket page: activity", () => {
  const entry = (extra: object): ActivityEntry => ({ id: `e${Math.random()}`, occurredAt: new Date(now - 60_000).toISOString(), actor: ana, ...extra }) as ActivityEntry;
  const texts = async () => (await within(await screen.findByRole("region", { name: "Atividade" })).findAllByRole("listitem")).map((item) => item.querySelector(".ticket-activity-text")?.textContent?.replace(/\s+/g, " ").trim());

  it("tells that the agent work started and how it ended", async () => {
    setup({
      tickets: base(),
      entries: [
        entry({ type: "agent_work_ended", reason: "finished" }),
        entry({ type: "agent_work_ended", reason: "person" }),
        entry({ type: "agent_work_ended", reason: "agent" }),
        entry({ type: "agent_work_started", until }),
      ],
    });
    const found = await texts();
    expect(found.some((text) => text?.startsWith("Ana iniciou o trabalho pela IA"))).toBe(true);
    expect(found.some((text) => text?.startsWith("O trabalho pela IA foi encerrado pelo agente"))).toBe(true);
    expect(found.some((text) => text?.startsWith("O trabalho pela IA foi encerrado por Ana"))).toBe(true);
    expect(found.some((text) => text?.startsWith("O trabalho pela IA foi encerrado ao concluir o ticket"))).toBe(true);
  });

  it.each([
    ["pt-BR", "O trabalho pela IA foi encerrado porque o projeto foi arquivado"],
    ["en", "The AI work was ended because the project was archived"],
    ["es-MX", "El trabajo de la IA terminó porque el proyecto fue archivado"],
  ])("shows the work that ended because the project was archived (%s)", async (language, sentence) => {
    await setTestLanguage(language as "pt-BR" | "en" | "es-MX");
    setup({ tickets: base(), entries: [entry({ type: "agent_work_ended", reason: "archived", actor: null })] });
    await waitFor(() => expect([...document.querySelectorAll(".ticket-activity-text")].map((el) => el.textContent?.replace(/\s+/g, " ").trim())).toEqual([sentence]));
  });

  it("marks entries and comments that came through MCP, and only those", async () => {
    setup({
      tickets: base(),
      entries: [
        entry({ type: "comment", via: "mcp", body: "Andamento: testes escritos.", area: null, editedAt: null, removed: false, canEdit: false, canRemove: false }),
        entry({ type: "status_changed", via: "mcp", from: "todo", to: "in_progress", automatic: false, causedBy: null }),
        entry({ type: "status_changed", from: "in_progress", to: "in_review", automatic: false, causedBy: null }),
      ],
    });
    await texts();
    const list = within(await screen.findByRole("region", { name: "Atividade" }));
    expect(await list.findAllByText("pelo MCP")).toHaveLength(2);
  });
});

describe("ticket page: following the marker listed on the map", () => {
  it("fetches the detail again when the listed marker differs from the detail's", async () => {
    const { client, rerender, element } = setup({ tickets: base(), props: { listedAgentWork: null } });
    await screen.findByRole("heading", { name: "Este ticket" });
    expect(client.getTicket).toHaveBeenCalledTimes(1);
    rerender(element({ listedAgentWork: working }));
    await waitFor(() => expect(client.getTicket).toHaveBeenCalledTimes(2));
  });

  it("does not fetch when the listed marker is the one the page already has", async () => {
    const { client, rerender, element } = setup({ props: { listedAgentWork: working } });
    await row();
    rerender(element({ listedAgentWork: { ...working } }));
    expect(client.getTicket).toHaveBeenCalledTimes(1);
  });

  it("waits while a field is being edited, and does not wipe it", async () => {
    const { client, rerender, element } = setup({ tickets: base(), props: { listedAgentWork: null } });
    await screen.findByRole("heading", { name: "Este ticket" });
    await userEvent.click(screen.getByRole("button", { name: "Editar título" }));
    const field = await screen.findByRole("textbox", { name: /Título/ });
    await userEvent.type(field, " em edição");
    rerender(element({ listedAgentWork: working }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.getTicket).toHaveBeenCalledTimes(1);
    expect(field).toHaveValue("Este ticket em edição");
    await userEvent.tab();
    await waitFor(() => expect(client.getTicket).toHaveBeenCalledTimes(2));
  });
});

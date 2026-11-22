import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

/** ADR 0043: com a aba visível o mapa busca os tickets de novo a cada 30 s e ao voltar para a aba, sem mexer em mais nada. */
const projects = [makeProject("p1", "ALFA", "Projeto Alfa")];
const listed = (extra: Partial<TicketSummary> = {}): TicketSummary[] => [makeTicket("t1", "p1", 1, "Fechar a fase", { key: "ALFA-1", ...extra })];

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setup(overrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
  const client = makeClient({ projects, tickets: { p1: listed() }, people: [makePerson("person-1", "Ana")] });
  Object.assign(client, overrides);
  const view = render(<OrganizationMap client={client} me={makePanelMe("admin")} />);
  return { client, ...view };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  setVisibility("visible");
});
afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

describe("map auto-refresh", () => {
  it("fetches the tickets again every 30 seconds while the tab is visible", async () => {
    const { client } = setup();
    await tick(0);
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    await tick(29_000);
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(client.listTickets).toHaveBeenCalledTimes(2);
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(3);
  });

  it("does not fetch while the tab is hidden, and fetches at once when it comes back", async () => {
    const { client } = setup();
    await tick(0);
    act(() => setVisibility("hidden"));
    await tick(120_000);
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await tick(0);
    expect(client.listTickets).toHaveBeenCalledTimes(2);
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(3);
  });

  it("never starts a fetch while another one is still running", async () => {
    let release: (value: ReturnType<typeof ok<TicketSummary[]>>) => void = () => {};
    const { client } = setup();
    await tick(0);
    vi.mocked(client.listTickets).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(2);
    await tick(60_000);
    expect(client.listTickets).toHaveBeenCalledTimes(2);
    release(ok(listed()));
    await tick(0);
    vi.mocked(client.listTickets).mockResolvedValue(ok(listed()));
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(3);
  });

  it("fails silently and tries again on the next cycle", async () => {
    const { client } = setup();
    await tick(0);
    vi.mocked(client.listTickets).mockResolvedValueOnce(failed("unavailable"));
    await tick(30_000);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ALFA · Projeto Alfa/ })).toBeInTheDocument();
    vi.mocked(client.listTickets).mockResolvedValue(ok(listed({ title: "Fechar a fase (novo)" })));
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(3);
  });

  it("keeps the camera and the selection where they were when the data changes", async () => {
    const { client, container } = setup();
    await tick(0);
    fireEvent.click(screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await tick(1_000);
    const scene = () => container.querySelector<HTMLElement>(".spatial-scene")!.style.transform;
    const selection = () => screen.getByRole("complementary", { name: "Nó selecionado" }).querySelector("strong")!.textContent;
    const before = { scene: scene(), selection: selection() };
    vi.mocked(client.listTickets).mockResolvedValue(ok([...listed(), makeTicket("t2", "p1", 2, "Outro", { key: "ALFA-2" })]));
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(2);
    expect({ scene: scene(), selection: selection() }).toEqual(before);
  });

  it("does not wipe what the person is typing in the request bar", async () => {
    const me = makePanelMe("admin");
    const client = makeClient({ projects, tickets: { p1: listed() }, people: [makePerson("person-1", "Ana")] });
    render(<OrganizationMap client={client} me={{ ...me, assistant: { enabled: true, configured: true, consent: true } }} />);
    await tick(0);
    const bar = screen.getByRole("combobox", { name: "Peça qualquer coisa" });
    bar.focus();
    fireEvent.change(bar, { target: { value: "um pedido ainda não enviado" } });
    vi.mocked(client.listTickets).mockResolvedValue(ok([...listed(), makeTicket("t2", "p1", 2, "Outro", { key: "ALFA-2" })]));
    await tick(30_000);
    expect(client.listTickets).toHaveBeenCalledTimes(2);
    expect(bar).toHaveValue("um pedido ainda não enviado");
    expect(bar).toHaveFocus();
  });

  it("stops everything when the map is left", async () => {
    const { client, unmount } = setup();
    await tick(0);
    unmount();
    await tick(120_000);
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    expect(client.listTickets).toHaveBeenCalledTimes(1);
  });
});

describe("map auto-refresh and the open ticket page", () => {
  it("shows the marker on the open page when the refreshed list brings one, without closing the page", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const client = makeTreeClient({ projects, tickets: { p1: listed() }, people: [makePerson("person-1", "Ana")] });
    Object.assign(client, { ticketActivity: vi.fn(async () => ok({ entries: [], before: null, canComment: false })) });
    render(<OrganizationMap client={client} me={makePanelMe("admin")} openTicketId="t1" onOpenTicketChange={() => {}} />);
    await tick(0);
    await tick(0);
    expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
    expect(screen.queryByText("Em trabalho pela IA", { selector: "dt" })).not.toBeInTheDocument();
    vi.mocked(client.listTickets).mockResolvedValue(ok(listed({ agentWork: { since, until, note: "testando" } })));
    const detail = await client.getTicket("t1");
    if (!detail.ok) throw new Error("detalhe");
    vi.mocked(client.getTicket).mockClear();
    vi.mocked(client.getTicket).mockResolvedValue(ok({ ...detail.data, agentWork: { since, until, note: "testando", by: { id: "person-1", displayName: "Ana", avatarUrl: null } }, canEndAgentWork: true }));
    await tick(30_000);
    await tick(0);
    expect(client.getTicket).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Em trabalho pela IA", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, TicketSummary } from "../api/client.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";

const SLOW = 8000;
const projects = [makeProject("p1", "ALFA", "Projeto Alfa"), makeProject("p2", "BETA", "Projeto Beta")];
const tickets: Record<string, TicketSummary[]> = {
  p1: [
    makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" }),
    makeTicket("t2", "p1", 2, "Login com Google", { key: "ALFA-2", parentId: "t1" }),
  ],
  p2: [makeTicket("t4", "p2", 1, "Relatórios", { key: "BETA-1" })],
};
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const adminMe = () => withAssistant(makePanelMe("admin"));
const client = (): ApiClient => makeTreeClient({ projects, tickets, people: [makePerson("person-1", "Ana")] });

function Host({ client, me, initialOpen = null, onChange }: { client: ApiClient; me: Me; initialOpen?: string | null; onChange?: (id: string | null) => void }) {
  const [open, setOpen] = useState<string | null>(initialOpen);
  return <OrganizationMap client={client} me={me} openTicketId={open} onOpenTicketChange={(id) => { onChange?.(id); setOpen(id); }} />;
}
const bar = () => screen.findByRole("combobox", { name: "Peça qualquer coisa" });
async function typed(text: string) {
  const field = await bar();
  await userEvent.click(field);
  await userEvent.type(field, text);
  return field;
}
const optionNames = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
const IDEA = /Registrar ideia «exportar csv»/;

describe("the “Registrar ideia” line", () => {
  it("comes right after “Criar ticket” and before “Perguntar ao assistente”, with no shortcut of its own", async () => {
    render(<Host client={client()} me={adminMe()} />);
    await typed("exportar csv");
    const names = optionNames();
    const at = (pattern: RegExp) => names.findIndex((name) => pattern.test(name));
    expect(at(/Criar ticket/)).toBeGreaterThanOrEqual(0);
    expect(at(IDEA)).toBe(at(/Criar ticket/) + 1);
    expect(at(/Perguntar ao assistente/)).toBe(at(IDEA) + 1);
    const line = screen.getByRole("option", { name: IDEA });
    expect(line.querySelector(".command-hint")).toBeNull();
  }, SLOW);

  it("is offered with the assistant off too, and only with text typed", async () => {
    render(<Host client={client()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "contributor" }]), false)} />);
    const field = await bar();
    await userEvent.click(field);
    expect(screen.queryByRole("option", { name: /Registrar ideia/ })).not.toBeInTheDocument();
    await userEvent.type(field, "exportar csv");
    expect(screen.getByRole("option", { name: IDEA })).toBeInTheDocument();
  }, SLOW);

  it("is not offered to someone who can only read, even with the assistant on", async () => {
    render(<Host client={client()} me={withAssistant(makePanelMe("member", [{ projectId: "p1", role: "reader" }]))} />);
    await typed("exportar csv");
    expect(screen.getByRole("option", { name: /Perguntar ao assistente/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Registrar ideia/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Criar ticket/ })).not.toBeInTheDocument();
  }, SLOW);

  it("keeps the arrows and Enter working across the new line (Enter on the highlighted line only)", async () => {
    const api = client();
    render(<Host client={api} me={adminMe()} />);
    await typed("exportar csv");
    expect(screen.getByRole("option", { name: /Criar ticket/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: IDEA })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Perguntar ao assistente/ })).toHaveAttribute("aria-selected", "true");
    expect(api.createTicket).not.toHaveBeenCalled();
  }, SLOW);
});

describe("registering an idea from the bar", () => {
  it("Enter on the highlighted line creates a “Nova” idea at the project root, opens its page and clears the field", async () => {
    const api = client();
    const onChange = vi.fn();
    render(<Host client={api} me={adminMe()} onChange={onChange} />);
    const field = await typed("exportar csv");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p1", { title: "exportar csv", idea: true }));
    expect(api.createTicket).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("new-p1-3"));
    expect(await screen.findByRole("heading", { name: "exportar csv" })).toBeInTheDocument();
    expect(field).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  }, SLOW);

  it("clicking the line does the same", async () => {
    const api = client();
    const onChange = vi.fn();
    render(<Host client={api} me={adminMe()} onChange={onChange} />);
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p1", { title: "exportar csv", idea: true }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("new-p1-3"));
  }, SLOW);

  it("does not open the conversation with the assistant", async () => {
    const api = client();
    render(<Host client={api} me={adminMe()} />);
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalled());
    expect(api.openConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Novo ticket com o assistente" })).not.toBeInTheDocument();
  }, SLOW);

  it("goes inside the open ticket", async () => {
    const api = client();
    render(<Host client={api} me={adminMe()} initialOpen="t2" />);
    await screen.findByRole("heading", { name: "Login com Google" });
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p1", { title: "exportar csv", parentId: "t2", idea: true }));
  }, SLOW);

  it("goes inside the selected ticket when the page is closed, and into a project of its own", async () => {
    const api = client();
    render(<Host client={api} me={adminMe()} initialOpen="t4" />);
    await screen.findByRole("heading", { name: "Relatórios" });
    await userEvent.click(screen.getByRole("button", { name: "Fechar e voltar ao mapa" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Relatórios" })).not.toBeInTheDocument());
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p2", { title: "exportar csv", parentId: "t4", idea: true }));
  }, SLOW);

  it("goes to the root of the selected project when no ticket is selected", async () => {
    const api = client();
    render(<Host client={api} me={adminMe()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Projeto Beta/ }));
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p2", { title: "exportar csv", idea: true }));
  }, SLOW);

  it("falls back to the first project the person can create in, at the root, when the open ticket's project is read-only for them", async () => {
    const api = client();
    const me = withAssistant(makePanelMe("member", [{ projectId: "p1", role: "contributor" }, { projectId: "p2", role: "reader" }]));
    render(<Host client={api} me={me} initialOpen="t4" />);
    await screen.findByRole("heading", { name: "Relatórios" });
    await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p1", { title: "exportar csv", idea: true }));
  }, SLOW);

  it("puts what goes past the title limit in the description", async () => {
    const api = client();
    render(<Host client={api} me={adminMe()} />);
    const long = `${"a".repeat(200)}bcd`;
    const field = await bar();
    await userEvent.click(field);
    await userEvent.paste(long);
    await userEvent.click(await screen.findByRole("option", { name: /Registrar ideia/ }));
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledWith("p1", { title: "a".repeat(200), description: "bcd", idea: true }));
  }, SLOW);

  it("shows an error in the sheet and keeps the text, without opening a page", async () => {
    const api = client();
    Object.assign(api, { createTicket: vi.fn(async () => failed("conflict", "project_archived")) });
    const onChange = vi.fn();
    render(<Host client={api} me={adminMe()} onChange={onChange} />);
    const field = await typed("exportar csv");
    await userEvent.click(screen.getByRole("option", { name: IDEA }));
    const alert = await within(screen.getByRole("listbox").closest(".command-sheet") as HTMLElement).findByRole("alert");
    expect(alert).toHaveTextContent(/arquivado/i);
    expect(field).toHaveValue("exportar csv");
    expect(screen.getByRole("option", { name: IDEA })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  }, SLOW);

  it("sends once while the request is on its way", async () => {
    const api = client();
    let release: () => void = () => undefined;
    const real = api.createTicket;
    Object.assign(api, { createTicket: vi.fn(async (...args: Parameters<typeof real>) => { await new Promise<void>((resolve) => { release = resolve; }); return real(...args); }) });
    render(<Host client={api} me={adminMe()} />);
    await typed("exportar csv");
    const line = screen.getByRole("option", { name: IDEA });
    await userEvent.click(line);
    await userEvent.click(line);
    release();
    await waitFor(() => expect(api.createTicket).toHaveBeenCalledTimes(1));
  }, SLOW);
});

describe("other languages", () => {
  it.each([
    ["en", "Ask for anything", /Register idea «export csv»/],
    ["es-MX", "Pide lo que quieras", /Registrar idea «export csv»/],
  ] as const)("%s names the line", async (language, placeholder, line) => {
    await setTestLanguage(language);
    render(<Host client={client()} me={adminMe()} />);
    const field = await screen.findByRole("combobox", { name: placeholder });
    await userEvent.click(field);
    await userEvent.type(field, "export csv");
    expect(screen.getByRole("option", { name: line })).toBeInTheDocument();
  }, SLOW);
});

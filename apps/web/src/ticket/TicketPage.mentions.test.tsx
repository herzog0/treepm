import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0037: a seção "Mencionado em" da página do ticket.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Alvo da menção", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Quem cita", { key: "ALFA-2", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Outro que cita", { key: "ALFA-3", status: "done" }),
];
type Mention = TicketDetail["mentionedBy"][number];
const mention = (id: string, key: string, title: string, status: Mention["status"]): Mention => ({ id, key, title, status });

function setup(mentionedBy: Record<string, Mention[]>, ticketId = "t1") {
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => {
      const summary = summaries.find((entry) => entry.id === id)!;
      const detail: TicketDetail = {
        ...summary, description: "Texto", createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
        mentionedBy: mentionedBy[id] ?? [], dependsOn: [], blocks: [],
      };
      return ok(detail);
    }),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const props = { client: client as ApiClient, me: makePanelMe("admin"), projects: [project], creating: null, ...handlers };
  const view = render(<TicketPage {...props} ticketId={ticketId} />);
  return { client, view, props, ...handlers };
}
const section = (name: string) => screen.queryByRole("region", { name });

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("Mencionado em", () => {
  it("lista quem menciona, com o marcador de situação, a chave e o título, abaixo da descrição", async () => {
    setup({ t1: [mention("t2", "ALFA-2", "Quem cita", "in_progress"), mention("t3", "ALFA-3", "Outro que cita", "done")] });
    await screen.findByRole("heading", { level: 1 });
    const region = await screen.findByRole("region", { name: "Mencionado em" });
    const items = within(region).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("ALFA-2");
    expect(items[0]).toHaveTextContent("Quem cita");
    expect(items[0]).toHaveTextContent("Em andamento");
    expect(items[1]).toHaveTextContent("ALFA-3");
    expect(items[1]).toHaveTextContent("Concluído");
    const text = screen.getByRole("complementary").textContent ?? "";
    expect(text.indexOf("Descrição")).toBeLessThan(text.indexOf("Mencionado em"));
  });

  it("clicar abre aquele ticket", async () => {
    const { onOpenTicket } = setup({ t1: [mention("t2", "ALFA-2", "Quem cita", "todo")] });
    const region = await screen.findByRole("region", { name: "Mencionado em" });
    await userEvent.click(within(region).getByRole("button", { name: /ALFA-2/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t2");
  });

  it("não aparece quando ninguém menciona", async () => {
    setup({});
    await screen.findByRole("heading", { level: 1 });
    expect(section("Mencionado em")).toBeNull();
    expect(screen.queryByText("Mencionado em")).toBeNull();
  });

  it("ao navegar de um ticket para outro, o detalhe do segundo é carregado de novo e mostra a menção gravada no meio do caminho", async () => {
    const mentions: Record<string, Mention[]> = {};
    const { client, view, props } = setup(mentions, "t2");
    await screen.findByRole("heading", { level: 1 });
    mentions["t1"] = [mention("t2", "ALFA-2", "Quem cita", "in_progress")]; // a descrição de ALFA-2 foi salva citando ALFA-1
    view.rerender(<TicketPage {...props} ticketId="t1" />);
    expect(await screen.findByRole("region", { name: "Mencionado em" })).toBeInTheDocument();
    expect((client.getTicket as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual(["t2", "t1"]);
  });

  it("tem texto nos três idiomas", async () => {
    for (const [language, heading] of [["en", "Mentioned in"], ["es-MX", "Mencionado en"], ["pt-BR", "Mencionado em"]] as const) {
      await setTestLanguage(language);
      expect(i18n.t("ticket:mentionedBy.heading")).toBe(heading);
    }
  });
});

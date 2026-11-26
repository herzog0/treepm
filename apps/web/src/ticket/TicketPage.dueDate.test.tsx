import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ApiClient, TicketSummary } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { failed, makeProject, makeTicket, makeTreeClient, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ClockContext, localDay } from "./clock.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0064, fatia 1: a linha "Prazo" da página do ticket, o atraso pelo dia do navegador e as frases da linha do tempo.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Sem prazo", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Em dia", { key: "ALFA-2", dueDate: "2026-12-12" }),
  makeTicket("t3", "p1", 3, "Atrasado", { key: "ALFA-3", dueDate: "2026-11-20", status: "in_progress" }),
  makeTicket("t4", "p1", 4, "Atrasado um dia", { key: "ALFA-4", dueDate: "2026-11-25" }),
  makeTicket("t5", "p1", 5, "Concluído depois do prazo", { key: "ALFA-5", dueDate: "2026-11-20", status: "done" }),
  makeTicket("t6", "p1", 6, "Cancelado", { key: "ALFA-6", dueDate: "2026-11-20", status: "cancelled" }),
  makeTicket("t7", "p1", 7, "Ideia com prazo vencido", { key: "ALFA-7", dueDate: "2026-11-20", status: "in_progress", idea: { root: true, stage: "refining" } }),
  makeTicket("t8", "p1", 8, "Dentro da ideia", { key: "ALFA-8", parentId: "t7", dueDate: "2026-11-20", status: "todo" }),
];
/** "Hoje" do navegador: 26 de novembro de 2026, perto da meia-noite local (o dia em UTC pode ser outro). */
const today = () => new Date(2026, 10, 26, 23, 30);

function setup(options: { role?: "admin" | "reader"; ticketId?: string; entries?: ActivityEntry[] } = {}) {
  const client = makeTreeClient({ projects: [project], tickets: { p1: tickets.map((ticket) => ({ ...ticket })) } });
  if (options.entries) {
    Object.assign(client, { ticketActivity: vi.fn(async () => ok({ entries: options.entries!, before: null, canComment: false })) });
  }
  const me = options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin");
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(
    <ClockContext.Provider value={today}>
      <TicketPage client={client as ApiClient} me={me} projects={[project]} ticketId={options.ticketId ?? "t1"} creating={null} {...handlers} />
    </ClockContext.Provider>,
  );
  return { client, ...handlers };
}
const row = async (label = "Prazo") => (await screen.findByText(label, { selector: "dt" })).closest(".ticket-row") as HTMLElement;

describe("localDay: o dia do relógio local, nunca o de UTC", () => {
  it("usa ano, mês e dia locais", () => {
    expect(localDay(new Date(2026, 10, 26, 23, 30))).toBe("2026-11-26");
    expect(localDay(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
    expect(localDay(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });
});

describe("linha Prazo da página do ticket", () => {
  it("vem logo depois de Prioridade", async () => {
    setup();
    await row();
    const labels = [...document.querySelectorAll(".ticket-fields dt")].map((dt) => dt.textContent);
    expect(labels[labels.indexOf("Prioridade") + 1]).toBe("Prazo");
  });

  it("sem prazo: campo de data vazio com a faixa aceita, sem botão de tirar; escolher grava a data", async () => {
    const { client } = setup();
    const r = await row();
    const input = within(r).getByLabelText("Prazo");
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveAttribute("min", "2000-01-01");
    expect(input).toHaveAttribute("max", "2100-12-31");
    expect(input).toHaveValue("");
    expect(r).toHaveTextContent("Definir prazo");
    expect(within(r).queryByRole("button", { name: "Tirar o prazo" })).toBeNull();
    input.focus(); // a escolha no calendário: o `change` chega com o campo focado
    fireEvent.change(input, { target: { value: "2026-12-12" } });
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t1", { dueDate: "2026-12-12" }));
    await waitFor(() => expect(r).toHaveTextContent("12 de dezembro de 2026"));
  });

  it("em dia: mostra a data no idioma, sem destaque nem atraso; o botão de tirar grava nulo", async () => {
    const user = userEvent.setup();
    const { client } = setup({ ticketId: "t2" });
    const r = await row();
    await waitFor(() => expect(within(r).getByLabelText("Prazo")).toHaveValue("2026-12-12"));
    expect(r).toHaveTextContent("12 de dezembro de 2026");
    expect(r).not.toHaveTextContent("atrasado");
    expect(r.querySelector(".is-overdue")).toBeNull();
    await user.click(within(r).getByRole("button", { name: "Tirar o prazo" }));
    await waitFor(() => expect(client.updateTicket).toHaveBeenCalledWith("t2", { dueDate: null }));
    await waitFor(() => expect(within(r).getByLabelText("Prazo")).toHaveValue(""));
  });

  it("data inválida ou fora da faixa não chama a API", async () => {
    const { client } = setup();
    const r = await row();
    const input = within(r).getByLabelText("Prazo");
    fireEvent.change(input, { target: { value: "1999-12-31" } });
    expect(client.updateTicket).not.toHaveBeenCalled();
  });

  it("atrasado: data em destaque e 'atrasado há 6 dias' pelo dia do navegador", async () => {
    setup({ ticketId: "t3" });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("atrasado há 6 dias"));
    expect(r.querySelector(".is-overdue")).toHaveTextContent("20 de novembro de 2026");
  });

  it("um dia de atraso fica no singular", async () => {
    setup({ ticketId: "t4" });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("atrasado há 1 dia"));
    expect(r).not.toHaveTextContent("1 dias");
  });

  it.each(["t5", "t6"])("concluído ou cancelado nunca está atrasado (%s)", async (id) => {
    setup({ ticketId: id });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("20 de novembro de 2026"));
    expect(r).not.toHaveTextContent("atrasado");
    expect(r.querySelector(".is-overdue")).toBeNull();
  });

  it("erro da API aparece e a data volta ao que estava", async () => {
    const { client } = setup({ ticketId: "t2" });
    Object.assign(client, { updateTicket: vi.fn(async () => failed("unavailable")) });
    const r = await row();
    const input = within(r).getByLabelText("Prazo");
    await waitFor(() => expect(input).toHaveValue("2026-12-12"));
    input.focus(); // a escolha no calendário: o `change` chega com o campo focado
    fireEvent.change(input, { target: { value: "2027-01-05" } });
    expect(await within(r).findByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("2026-12-12");
  });

  it.each(["t7", "t8"])("ideia (a raiz ou um ticket dentro dela) nunca está atrasada: o prazo é uma data comum (%s)", async (id) => {
    setup({ ticketId: id });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("20 de novembro de 2026"));
    expect(r).not.toHaveTextContent("atrasado");
    expect(r.querySelector(".is-overdue")).toBeNull();
  });

  it("quem só lê vê a data e o atraso, sem controles", async () => {
    setup({ role: "reader", ticketId: "t3" });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("20 de novembro de 2026"));
    expect(r).toHaveTextContent("atrasado há 6 dias");
    expect(within(r).queryByRole("button")).toBeNull();
    expect(within(r).queryByLabelText("Prazo")).toBeNull();
  });

  it("quem só lê um ticket sem prazo vê 'Sem prazo'", async () => {
    setup({ role: "reader", ticketId: "t1" });
    const r = await row();
    await waitFor(() => expect(r).toHaveTextContent("Sem prazo"));
  });

  it("em inglês e em espanhol do México: data e atraso no idioma", async () => {
    await setTestLanguage("en");
    setup({ role: "reader", ticketId: "t3" });
    let r = await row("Due date");
    await waitFor(() => expect(r).toHaveTextContent("November 20, 2026"));
    expect(r).toHaveTextContent("overdue by 6 days");
    document.body.innerHTML = "";
    await setTestLanguage("es-MX");
    setup({ role: "reader", ticketId: "t4" });
    r = await row("Fecha límite");
    await waitFor(() => expect(r).toHaveTextContent("25 de noviembre de 2026"));
    expect(r).toHaveTextContent("vencido hace 1 día");
  });
});

describe("linha do tempo do prazo", () => {
  const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
  const entries: ActivityEntry[] = [
    { id: "d3", occurredAt: "2026-11-25T10:00:00.000Z", actor: ana, type: "due_date_changed", from: "2026-12-12", to: null },
    { id: "d2", occurredAt: "2026-11-24T10:00:00.000Z", actor: ana, type: "due_date_changed", from: "2026-12-01", to: "2026-12-12" },
    { id: "d1", occurredAt: "2026-11-23T10:00:00.000Z", actor: ana, type: "due_date_changed", from: null, to: "2026-12-01" },
  ];

  it("as três frases em português, com a data no idioma", async () => {
    setup({ entries });
    expect(await screen.findByText(/definiu o prazo para/)).toHaveTextContent("Ana definiu o prazo para 1 de dezembro de 2026");
    expect(screen.getByText(/mudou o prazo de/)).toHaveTextContent("Ana mudou o prazo de 1 de dezembro de 2026 para 12 de dezembro de 2026");
    expect(screen.getByText(/tirou o prazo/)).toHaveTextContent("Ana tirou o prazo");
  });

  it("em inglês", async () => {
    await setTestLanguage("en");
    setup({ entries });
    expect(await screen.findByText(/set the due date to/)).toHaveTextContent("Ana set the due date to December 1, 2026");
    expect(screen.getByText(/changed the due date from/)).toHaveTextContent("Ana changed the due date from December 1, 2026 to December 12, 2026");
    expect(screen.getByText(/removed the due date/)).toHaveTextContent("Ana removed the due date");
  });

  it("em espanhol do México", async () => {
    await setTestLanguage("es-MX");
    setup({ entries });
    expect(await screen.findByText(/fijó la fecha límite para el/)).toHaveTextContent("Ana fijó la fecha límite para el 1 de diciembre de 2026");
    expect(screen.getByText(/cambió la fecha límite del/)).toHaveTextContent("Ana cambió la fecha límite del 1 de diciembre de 2026 al 12 de diciembre de 2026");
    expect(screen.getByText(/quitó la fecha límite/)).toHaveTextContent("Ana quitó la fecha límite");
  });
});

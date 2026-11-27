import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0068, seção 5: "Bloqueado" é um impedimento marcado, com o motivo. A página mostra, marca e limpa.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
type Impediment = TicketDetail["impediment"];
const REASON = "Falta a chave do fornecedor";
const marked: Impediment = { reason: REASON, by: { id: "person-1", displayName: "Ana", avatarUrl: null }, at: "2026-11-27T10:00:00.000Z" };

function setup(options: { impediment?: Impediment; status?: TicketSummary["status"]; role?: "admin" | "reader" } = {}) {
  const state = { impediment: options.impediment ?? null };
  const summary = makeTicket("t1", "p1", 1, "Integração", { key: "ALFA-1", status: options.status ?? "in_progress" });
  const detailOf = (): TicketDetail => ({
    ...summary, blocked: state.impediment !== null, impediment: state.impediment,
    description: "", createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    mentionedBy: [], dependsOn: [], blocks: [], related: [],
  });
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: [summary] } });
  Object.assign(client, {
    getTicket: vi.fn(async () => ok(detailOf())),
    markTicketImpediment: vi.fn(async (_id: string, reason: string) => {
      state.impediment = { ...marked!, reason };
      return ok(detailOf());
    }),
    clearTicketImpediment: vi.fn(async () => {
      state.impediment = null;
      return ok(detailOf());
    }),
  });
  const me = options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin");
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={me} projects={[project]} creating={null} ticketId="t1" {...handlers} />);
  return { client };
}
const row = async () => (await screen.findByText("Impedimento", { selector: "dt" })).closest(".ticket-row") as HTMLElement;
/** "Marcar impedimento" fica no menu "Mais ações" do cabeçalho: a página sem impedimento não ganha linha nova. */
const startMarking = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "Mais ações" }));
  await userEvent.click(await screen.findByRole("button", { name: "Marcar impedimento" }));
};

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("linha Impedimento", () => {
  it("mostra o motivo, quem marcou e o Bloqueado na situação", async () => {
    setup({ impediment: marked });
    const line = within(await row());
    expect(line.getByText(REASON)).toBeInTheDocument();
    expect(line.getByText(/Ana/)).toBeInTheDocument();
    const status = (await screen.findByText("Situação", { selector: "dt" })).closest(".ticket-row") as HTMLElement;
    expect(within(status).getByText("Bloqueado")).toBeInTheDocument();
  });

  it("limpar chama a API e a linha some", async () => {
    const { client } = setup({ impediment: marked });
    await userEvent.click(within(await row()).getByRole("button", { name: "Limpar impedimento" }));
    expect(client.clearTicketImpediment).toHaveBeenCalledWith("t1");
    await waitFor(() => expect(screen.queryByText("Impedimento", { selector: "dt" })).toBeNull());
    expect(screen.queryByText(REASON)).toBeNull();
  });

  it("sem impedimento a página não tem a linha; marcar começa no menu “Mais ações”, pede o motivo e grava pela API", async () => {
    const { client } = setup();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Impedimento", { selector: "dt" })).toBeNull();
    await startMarking();
    const box = within(await row()).getByRole("textbox", { name: "Motivo do impedimento" });
    await userEvent.type(box, "Esperando o jurídico");
    await userEvent.click(within(await row()).getByRole("button", { name: "Marcar" }));
    expect(client.markTicketImpediment).toHaveBeenCalledWith("t1", "Esperando o jurídico");
    expect(await within(await row()).findByText("Esperando o jurídico")).toBeInTheDocument();
  });

  it("sem motivo o botão Marcar fica desligado; Cancelar fecha a linha sem gravar", async () => {
    const { client } = setup();
    await startMarking();
    expect(within(await row()).getByRole("button", { name: "Marcar" })).toBeDisabled();
    await userEvent.click(within(await row()).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText("Impedimento", { selector: "dt" })).toBeNull();
    expect(client.markTicketImpediment).not.toHaveBeenCalled();
  });

  it("quem só lê vê o motivo, sem limpar; sem impedimento, a linha não aparece", async () => {
    setup({ impediment: marked, role: "reader" });
    const line = within(await row());
    expect(line.getByText(REASON)).toBeInTheDocument();
    expect(line.queryByRole("button")).toBeNull();
  });

  it("leitor sem impedimento e ticket concluído sem impedimento: sem a linha", async () => {
    setup({ role: "reader" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Impedimento", { selector: "dt" })).toBeNull();
  });

  it("ticket concluído: o menu não oferece marcar", async () => {
    setup({ status: "done" });
    await userEvent.click(await screen.findByRole("button", { name: "Mais ações" }));
    expect(screen.queryByRole("button", { name: "Marcar impedimento" })).toBeNull();
  });
});

describe("idiomas", () => {
  it("o texto novo existe nos três idiomas", async () => {
    const keys = ["fields.impediment", "impediment.mark", "impediment.reasonLabel", "impediment.save", "impediment.cancel", "impediment.clear", "impediment.by"];
    for (const language of ["pt-BR", "en", "es-MX"] as const) {
      await setTestLanguage(language);
      for (const key of keys) expect(i18n.exists(`ticket:${key}`), `${language} ${key}`).toBe(true);
    }
    await setTestLanguage("en");
    expect(i18n.t("ticket:fields.impediment")).toBe("Impediment");
    await setTestLanguage("es-MX");
    expect(i18n.t("ticket:fields.impediment")).toBe("Impedimento");
  });
});

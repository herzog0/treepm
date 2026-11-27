import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0061, fatia 3 (TREEPM-478): "Relacionado a" e o selo «do Linear» nas ligações trazidas do Linear.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Banco de dados", { key: "ALFA-2", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Autenticação", { key: "ALFA-3", status: "done" }),
  makeTicket("t4", "p1", 4, "Relatórios", { key: "ALFA-4" }),
];
type Link = TicketDetail["related"][number];
const link = (id: string, key: string, title: string, fromLinear?: boolean): Link => ({ id, key, title, status: "todo", ...(fromLinear === undefined ? {} : { fromLinear }) });

type Lists = { dependsOn?: Link[]; blocks?: Link[]; related?: Link[] };
function setup(lists: Lists = {}, options: { role?: "admin" | "reader"; remove?: ApiClient["removeTicketRelated"] } = {}) {
  const state = { dependsOn: lists.dependsOn ?? [], blocks: lists.blocks ?? [], related: lists.related ?? [] };
  const detailOf = (id: string): TicketDetail => ({
    ...summaries.find((entry) => entry.id === id)!, description: "Texto", createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    mentionedBy: [], dependsOn: id === "t1" ? state.dependsOn : [], blocks: id === "t1" ? state.blocks : [], related: id === "t1" ? state.related : [],
  });
  const client = makeClient({ projects: [project], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(id))),
    removeTicketRelated: options.remove ?? vi.fn(async (_id: string, ticketId: string) => {
      state.related = state.related.filter((entry) => entry.id !== ticketId);
      return ok(undefined);
    }),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin")} projects={[project]} creating={null} ticketId="t1" {...handlers} />);
  return { client, ...handlers };
}
const relatedRow = async () => (await screen.findByText("Relacionado a")).closest(".ticket-row") as HTMLElement;

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("linha “Relacionado a”", () => {
  it("mostra os tickets relacionados com chave e título, depois de “Depende de”; clicar abre o ticket", async () => {
    const { onOpenTicket } = setup({ related: [link("t2", "ALFA-2", "Banco de dados"), link("t3", "ALFA-3", "Autenticação")] });
    const line = within(await relatedRow());
    expect(line.getByRole("button", { name: /ALFA-3.*Autenticação/ })).toBeInTheDocument();
    const text = screen.getByRole("complementary").textContent ?? "";
    expect(text.indexOf("Depende de")).toBeLessThan(text.indexOf("Relacionado a"));
    expect(text.indexOf("Relacionado a")).toBeLessThan(text.indexOf("Descrição"));
    await userEvent.click(line.getByRole("button", { name: /ALFA-2.*Banco de dados/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t2");
  });

  it("some quando não há relações, mesmo para quem pode editar (não há como criar pela tela)", async () => {
    setup({});
    await screen.findByText("Depende de");
    expect(screen.queryByText("Relacionado a")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Adicionar relação/ })).not.toBeInTheDocument();
  });

  it("quem pode editar remove uma relação pelo ×; a linha some quando a última sai", async () => {
    const { client } = setup({ related: [link("t2", "ALFA-2", "Banco de dados", true)] });
    const line = within(await relatedRow());
    await userEvent.click(line.getByRole("button", { name: "Remover relação ALFA-2" }));
    expect(client.removeTicketRelated).toHaveBeenCalledWith("t1", "t2");
    await waitFor(() => expect(screen.queryByText("Relacionado a")).not.toBeInTheDocument());
  });

  it("quem só lê vê a lista sem o botão de remover", async () => {
    setup({ related: [link("t2", "ALFA-2", "Banco de dados")] }, { role: "reader" });
    const line = within(await relatedRow());
    expect(line.getByRole("button", { name: /ALFA-2.*Banco de dados/ })).toBeInTheDocument();
    expect(line.queryByRole("button", { name: /Remover relação/ })).not.toBeInTheDocument();
  });

  it.each([
    ["en", "Related to", "Remove relation ALFA-2"],
    ["es-MX", "Relacionado con", "Quitar relación ALFA-2"],
  ] as const)("em %s", async (language, heading, remove) => {
    await setTestLanguage(language);
    setup({ related: [link("t2", "ALFA-2", "Banco de dados")] });
    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: remove })).toBeInTheDocument();
  });
});

describe("selo «do Linear» nas ligações", () => {
  it("aparece em “Depende de”, “Dependem deste” e “Relacionado a” só nas ligações trazidas do Linear", async () => {
    setup({
      dependsOn: [link("t2", "ALFA-2", "Banco de dados", true), link("t3", "ALFA-3", "Autenticação", false)],
      blocks: [link("t4", "ALFA-4", "Relatórios", true)],
      related: [link("t3", "ALFA-3", "Autenticação", true), link("t4", "ALFA-4", "Relatórios")],
    });
    const depends = (await screen.findByText("Depende de")).closest(".ticket-row") as HTMLElement;
    expect(within(depends).getAllByText("do Linear")).toHaveLength(1);
    expect(within(depends).getByText("do Linear").closest(".ticket-dep")).toHaveTextContent("ALFA-2");
    const blocking = screen.getByRole("heading", { name: "Dependem deste" }).closest("section") as HTMLElement;
    expect(within(blocking).getAllByText("do Linear")).toHaveLength(1);
    const related = await relatedRow();
    expect(within(related).getAllByText("do Linear")).toHaveLength(1);
    expect(within(related).getByText("do Linear").closest(".ticket-dep")).toHaveTextContent("ALFA-3");
    expect(within(related).getByText("do Linear")).toHaveAttribute("title", "Trazido do Linear por uma sincronização");
  });
});

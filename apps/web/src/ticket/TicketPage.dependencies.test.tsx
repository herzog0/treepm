import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0037, fatia 3: a linha "Depende de" e a lista "Bloqueia" da página do ticket.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const other = makeProject("p2", "BETA", "Projeto Beta");
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Banco de dados", { key: "ALFA-2", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Autenticação", { key: "ALFA-3", status: "done" }),
  makeTicket("t4", "p1", 4, "Relatórios", { key: "ALFA-4" }),
  makeTicket("t5", "p1", 5, "Painel", { key: "ALFA-5" }),
];
type Link = TicketDetail["dependsOn"][number];
const link = (id: string, key: string, title: string, status: Link["status"] = "todo"): Link => ({ id, key, title, status });
const T2 = link("t2", "ALFA-2", "Banco de dados", "in_progress");
const T3 = link("t3", "ALFA-3", "Autenticação", "done");

type Lists = { dependsOn?: Link[]; blocks?: Link[] };
function setup(lists: Lists = {}, options: { role?: "admin" | "reader"; archived?: boolean; add?: ApiClient["addTicketDependency"]; remove?: ApiClient["removeTicketDependency"] } = {}) {
  const state = { dependsOn: lists.dependsOn ?? [], blocks: lists.blocks ?? [] };
  const detailOf = (id: string): TicketDetail => ({
    ...summaries.find((entry) => entry.id === id)!, description: "Texto", createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    mentionedBy: [], dependsOn: id === "t1" ? state.dependsOn : [], blocks: id === "t1" ? state.blocks : [],
  });
  const shown = options.archived ? makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project;
  const client = makeClient({ projects: [shown, other], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(id))),
    addTicketDependency: options.add ?? vi.fn(async (_id: string, ticketId: string) => {
      const found = summaries.find((entry) => entry.id === ticketId)!;
      state.dependsOn = [...state.dependsOn, link(found.id, found.key, found.title, found.status)].sort((a, b) => a.key.localeCompare(b.key));
      return ok(detailOf("t1"));
    }),
    removeTicketDependency: options.remove ?? vi.fn(async (_id: string, ticketId: string) => {
      state.dependsOn = state.dependsOn.filter((entry) => entry.id !== ticketId);
      return ok(undefined);
    }),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={options.role === "reader" ? makePanelMe("member", [{ projectId: "p1", role: "reader" }]) : makePanelMe("admin")} projects={[shown, other]} creating={null} ticketId="t1" {...handlers} />);
  return { client, ...handlers };
}
const row = async () => (await screen.findByText("Depende de")).closest(".ticket-row") as HTMLElement;

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("linha “Depende de”", () => {
  it("mostra os tickets de que este depende, com marcador de situação, chave e título; clicar abre o ticket", async () => {
    const { onOpenTicket } = setup({ dependsOn: [T2, T3] });
    const line = within(await row());
    expect(line.getByRole("button", { name: /ALFA-2.*Banco de dados/ })).toBeInTheDocument();
    expect(line.getByRole("button", { name: /ALFA-3.*Autenticação/ })).toBeInTheDocument();
    expect((await row()).querySelectorAll(".status-mark")).toHaveLength(2);
    await userEvent.click(line.getByRole("button", { name: /ALFA-2.*Banco de dados/ }));
    expect(onOpenTicket).toHaveBeenCalledWith("t2");
  });

  it("fica junto das outras propriedades, antes da descrição", async () => {
    setup({ dependsOn: [T2] });
    await row();
    const text = screen.getByRole("complementary").textContent ?? "";
    expect(text.indexOf("Ticket pai")).toBeLessThan(text.indexOf("Depende de"));
    expect(text.indexOf("Depende de")).toBeLessThan(text.indexOf("Descrição"));
  });

  it("quem pode alterar vê “Adicionar” e um botão de remover em cada ticket; sem dependências a linha aparece com “Adicionar”", async () => {
    setup({});
    const line = within(await row());
    expect(line.getByRole("button", { name: "Adicionar dependência" })).toBeInTheDocument();
  });

  it("quem só lê vê a lista sem “Adicionar” nem remover; sem dependências a linha não aparece", async () => {
    setup({ dependsOn: [T2] }, { role: "reader" });
    const line = within(await row());
    expect(line.getByText(/ALFA-2/)).toBeInTheDocument();
    expect(line.queryByRole("button", { name: /Adicionar/ })).toBeNull();
    expect(line.queryByRole("button", { name: /Remover/ })).toBeNull();
  });

  it("projeto arquivado: a lista fica, sem “Adicionar” nem remover", async () => {
    setup({ dependsOn: [T2] }, { archived: true });
    const line = within(await row());
    expect(line.getByText(/ALFA-2/)).toBeInTheDocument();
    expect(line.queryByRole("button", { name: /Adicionar|Remover/ })).toBeNull();
  });

  it("leitor sem dependências: a linha não aparece", async () => {
    setup({}, { role: "reader" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Depende de")).toBeNull();
  });

  it("remover chama a API e recarrega a página", async () => {
    const { client } = setup({ dependsOn: [T2, T3] });
    const line = within(await row());
    await userEvent.click(line.getByRole("button", { name: "Remover dependência ALFA-2" }));
    expect(client.removeTicketDependency).toHaveBeenCalledWith("t1", "t2");
    await waitFor(() => expect(within(screen.getByText("Depende de").closest(".ticket-row") as HTMLElement).queryByText(/ALFA-2/)).toBeNull());
    expect(within(screen.getByText("Depende de").closest(".ticket-row") as HTMLElement).getByText(/ALFA-3/)).toBeInTheDocument();
  });
});

describe("seletor de ticket", () => {
  const openPicker = async () => {
    const line = within(await row());
    await userEvent.click(line.getByRole("button", { name: "Adicionar dependência" }));
    return screen.findByRole("group", { name: "Escolha o ticket de que este depende" });
  };

  it("lista só tickets do mesmo projeto, sem o próprio ticket e sem os que já estão na lista", async () => {
    setup({ dependsOn: [T2] });
    const picker = within(await openPicker());
    const names = picker.getAllByRole("button").map((button) => button.textContent);
    expect(names.join("|")).toContain("ALFA-3");
    expect(names.join("|")).toContain("ALFA-4");
    expect(names.join("|")).not.toContain("ALFA-1");
    expect(names.join("|")).not.toContain("ALFA-2");
  });

  it("a busca filtra por chave ou título", async () => {
    setup({});
    const picker = within(await openPicker());
    await userEvent.type(picker.getByRole("textbox", { name: "Buscar ticket" }), "relat");
    expect(picker.getAllByRole("button")).toHaveLength(1);
    expect(picker.getByRole("button", { name: /ALFA-4/ })).toBeInTheDocument();
  });

  it("escolher registra a dependência, fecha o seletor e mostra o ticket na linha", async () => {
    const { client, onChanged } = setup({});
    const picker = within(await openPicker());
    await userEvent.click(picker.getByRole("button", { name: /ALFA-4/ }));
    expect(client.addTicketDependency).toHaveBeenCalledWith("t1", "t4");
    await waitFor(() => expect(screen.queryByRole("group", { name: "Escolha o ticket de que este depende" })).toBeNull());
    expect(within(await row()).getByText(/ALFA-4/)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("Esc fecha só o seletor e devolve o foco a “Adicionar”, sem fechar a página", async () => {
    const { onClose } = setup({});
    await openPicker();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Escolha o ticket de que este depende" })).toBeNull();
    expect(screen.getByRole("button", { name: "Adicionar dependência" })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("seta para baixo vai da busca ao primeiro ticket, e as setas percorrem a lista; Enter escolhe", async () => {
    const { client } = setup({});
    await openPicker();
    await userEvent.keyboard("{ArrowDown}");
    const items = within(screen.getByRole("group", { name: "Escolha o ticket de que este depende" })).getAllByRole("button");
    expect(items[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("textbox", { name: "Buscar ticket" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(client.addTicketDependency).toHaveBeenCalledWith("t1", "t2");
  });

  it("erro de ciclo: mensagem na própria linha, sem fechar o seletor", async () => {
    setup({}, { add: vi.fn(async () => failed("conflict", "dependency_cycle")) });
    const picker = within(await openPicker());
    await userEvent.click(picker.getByRole("button", { name: /ALFA-4/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Isso fecharia um ciclo: “ALFA-4” já depende deste ticket");
    expect(within(await row()).getByRole("alert")).toBe(alert);
    expect(screen.getByRole("group", { name: "Escolha o ticket de que este depende" })).toBeInTheDocument();
  });

  it("outro erro usa a frase de erro comum", async () => {
    setup({}, { add: vi.fn(async () => failed("conflict", "project_archived")) });
    const picker = within(await openPicker());
    await userEvent.click(picker.getByRole("button", { name: /ALFA-4/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("arquivado");
  });
});

describe("lista “Bloqueia”", () => {
  it("lista quem depende deste, abaixo da descrição; clicar abre o ticket", async () => {
    const { onOpenTicket } = setup({ blocks: [T2, T3] });
    const region = await screen.findByRole("region", { name: "Bloqueia" });
    const items = within(region).getAllByRole("button");
    expect(items[0]).toHaveTextContent("ALFA-2");
    expect(items[0]).toHaveTextContent("Banco de dados");
    expect(items[0]).toHaveTextContent("Em andamento");
    expect(items[1]).toHaveTextContent("Concluído");
    const text = screen.getByRole("complementary").textContent ?? "";
    expect(text.indexOf("Descrição")).toBeLessThan(text.indexOf("Bloqueia"));
    await userEvent.click(items[0]!);
    expect(onOpenTicket).toHaveBeenCalledWith("t2");
  });

  it("some quando vazia", async () => {
    setup({});
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "Bloqueia" })).toBeNull();
  });
});

describe("idiomas", () => {
  it("o texto novo existe nos três idiomas", async () => {
    const keys = ["fields.dependsOn", "dependsOn.add", "dependsOn.addLabel", "dependsOn.remove", "dependsOn.pickerLabel", "dependsOn.filter", "dependsOn.cycle", "blocking.heading"];
    const seen: Record<string, string[]> = {};
    for (const language of ["pt-BR", "en", "es-MX"] as const) {
      await setTestLanguage(language);
      for (const key of keys) {
        const text = (i18n.t as unknown as (k: string, o: object) => string)(`ticket:${key}`, { key: "X-1" });
        expect(text, `${language} ${key}`).not.toBe(`ticket:${key}`);
        (seen[key] ??= []).push(text);
      }
    }
    expect(seen["blocking.heading"]).toEqual(["Bloqueia", "Blocks", "Bloquea"]);
    expect(seen["fields.dependsOn"]).toEqual(["Depende de", "Depends on", "Depende de"]);
    expect(i18n.t("ticket:dependsOn.cycle", { key: "X-1" } as never)).toContain("X-1");
  });
});

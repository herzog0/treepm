import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEntry, ApiClient, Contribution, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0041, fatia 1: a seção "Áreas". O que depende de digitar no editor de verdade fica na suíte de navegador.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" })];
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno", avatarUrl: null };
const design: Contribution = { id: "k1", area: { id: "a1", name: "Design" }, text: "Entregar a tela", status: "todo", people: [], commentCount: 0 };
const dados: Contribution = { id: "k2", area: { id: "a2", name: "Dados" }, text: "", status: "in_progress", people: [bruno], commentCount: 0 };
const areas = [{ id: "a1", name: "Design" }, { id: "a2", name: "Dados" }, { id: "a3", name: "Jurídico" }];

type Options = { contributions?: Contribution[]; canEdit?: boolean; reader?: boolean; archived?: boolean; areas?: { id: string; name: string }[]; activity?: ActivityEntry[] };
function setup(options: Options = {}) {
  const proj = options.archived ? makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project;
  let current = options.contributions ?? [];
  const canEdit = options.canEdit ?? (!options.reader && !options.archived);
  const detail = (): TicketDetail => ({
    ...summaries[0]!, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    contributions: current, canEditContributions: canEdit,
  });
  const client = makeClient({ projects: [proj], people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")], tickets: { p1: summaries }, areas: options.areas ?? areas });
  const spies = {
    createContribution: vi.fn(async (_id: string, body: { areaId: string }) => {
      const created: Contribution = { id: `new-${body.areaId}`, area: areas.find((a) => a.id === body.areaId)!, text: "", status: "todo", people: [], commentCount: 0 };
      current = [...current, created];
      return ok(created);
    }),
    updateContribution: vi.fn(async (id: string, body: { text?: string; status?: Contribution["status"] }) => {
      current = current.map((c) => (c.id === id ? { ...c, ...body } : c));
      return ok(current.find((c) => c.id === id)!);
    }),
    removeContribution: vi.fn(async (id: string) => {
      current = current.filter((c) => c.id !== id);
      return ok(null);
    }),
    putContributionPerson: vi.fn(async (id: string, personId: string) => {
      current = current.map((c) => (c.id === id ? { ...c, people: [...c.people, personId === "person-1" ? ana : bruno] } : c));
      return ok(current.find((c) => c.id === id)!);
    }),
    removeContributionPerson: vi.fn(async (id: string, personId: string) => {
      current = current.map((c) => (c.id === id ? { ...c, people: c.people.filter((p) => p.id !== personId) } : c));
      return ok(null);
    }),
  };
  Object.assign(client, spies, {
    getTicket: vi.fn(async () => ok(detail())),
    updateTicket: vi.fn(async () => ok(detail())),
    ticketActivity: vi.fn(async () => ok({ entries: options.activity ?? [], before: null, canComment: false })),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe(options.reader ? "member" : "admin")} projects={[proj]} ticketId="t1" creating={null} {...handlers} />);
  return { client: client as ApiClient & typeof spies & { ticketActivity: ReturnType<typeof vi.fn> }, ...spies };
}
const region = () => screen.findByRole("region", { name: "Áreas" });
const block = async (name: string) => within(await region()).getByRole("group", { name });

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("a seção Áreas", () => {
  it("fica entre a Descrição e os Itens, com um bloco por contribuição na ordem recebida", async () => {
    setup({ contributions: [design, dados] });
    const section = await region();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Áreas")).toBe(headings.indexOf("Descrição") + 1);
    expect(headings.indexOf("Áreas")).toBeLessThan(headings.indexOf("Itens"));
    const groups = Array.from(section.querySelectorAll(".ticket-contribution")).map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Design", "Dados"]);
  });

  it("cada bloco mostra a situação, as pessoas e o texto (ou o apoio quando vazio)", async () => {
    setup({ contributions: [design, dados] });
    const dBlock = await block("Dados");
    expect(within(dBlock).getByRole("button", { name: /Em andamento/ })).toBeInTheDocument();
    expect(within(dBlock).getByText("Bruno")).toBeInTheDocument();
    expect(within(dBlock).getByText("Descreva o que esta área precisa entregar")).toBeInTheDocument();
    const gBlock = await block("Design");
    expect(within(gBlock).getByRole("button", { name: /A fazer/ })).toBeInTheDocument();
    expect(await within(gBlock).findByText("Entregar a tela")).toBeInTheDocument();
  });

  it("sem contribuição e sem poder editar, a seção não aparece; leitor e arquivado leem sem menus", async () => {
    setup({ reader: true });
    await screen.findByRole("heading", { name: "Descrição" });
    expect(screen.queryByRole("region", { name: "Áreas" })).toBeNull();
  });

  it("leitor vê os blocos, sem menus, sem Adicionar e sem remover", async () => {
    setup({ contributions: [design, dados], reader: true });
    const section = await region();
    expect(section.querySelectorAll(".ticket-contribution")).toHaveLength(2);
    expect(within(section).queryByRole("button", { name: /Adicionar/ })).toBeNull();
    expect(within(section).queryByRole("button", { name: /A fazer|Em andamento/ })).toBeNull();
    expect(within(section).queryByRole("button", { name: /Remover|Mais ações/ })).toBeNull();
    expect(within(section).queryByRole("button", { name: /×|Tirar/ })).toBeNull();
    expect(within(section).getByText("Em andamento")).toBeInTheDocument();
  });

  it("projeto arquivado: os blocos aparecem só para ler", async () => {
    setup({ contributions: [design], archived: true });
    const section = await region();
    expect(within(section).queryByRole("button", { name: /Adicionar/ })).toBeNull();
  });
});

describe("adicionar área", () => {
  it("o menu oferece só as áreas que o ticket ainda não tem e cria a escolhida", async () => {
    const user = userEvent.setup();
    const { createContribution, client } = setup({ contributions: [design] });
    const section = await region();
    await user.click(await within(section).findByRole("button", { name: "Adicionar área" }));
    const menu = await screen.findByRole("menu", { name: "Áreas" });
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["Dados", "Jurídico"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Jurídico" }));
    await waitFor(() => expect(createContribution).toHaveBeenCalledWith("t1", { areaId: "a3" }));
    expect(await within(await region()).findByRole("group", { name: "Jurídico" })).toBeInTheDocument();
    await waitFor(() => expect(client.ticketActivity.mock.calls.length).toBeGreaterThan(1));
  });

  it("o teclado percorre o menu como os outros e Esc o fecha sem fechar a página", async () => {
    const user = userEvent.setup();
    const { createContribution } = setup({ contributions: [] });
    const section = await region();
    await user.click(await within(section).findByRole("button", { name: "Adicionar área" }));
    // O foco chega ao menu depois da abertura: as teclas só valem a partir daí.
    await waitFor(() => expect(within(screen.getByRole("menu", { name: "Áreas" })).getAllByRole("menuitemradio")[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(createContribution).toHaveBeenCalledWith("t1", { areaId: "a2" }));
  });

  it("todas as áreas já usadas: o botão some", async () => {
    setup({ contributions: [design, dados, { ...design, id: "k3", area: areas[2]! }] });
    const section = await region();
    expect(within(section).queryByRole("button", { name: "Adicionar área" })).toBeNull();
  });

  it("organização sem áreas: diz isso, e o administrador tem o caminho para cadastrá-las", async () => {
    setup({ areas: [] });
    const section = await region();
    await waitFor(() => expect(section).toHaveTextContent("Nenhuma área cadastrada nesta organização"));
    expect(within(section).getByRole("link", { name: /cadastr/i })).toHaveAttribute("href", expect.stringContaining("view=settings#github"));
  });

  it("organização sem áreas, quem não administra só lê o aviso", async () => {
    setup({ areas: [], contributions: [] });
    await region();
  });

  it("área já usada por corrida: o 409 aparece junto do botão, sem derrubar a página", async () => {
    const user = userEvent.setup();
    const { client } = setup({ contributions: [] });
    client.createContribution.mockResolvedValueOnce(failed("conflict", "contribution_area_taken"));
    const section = await region();
    await user.click(await within(section).findByRole("button", { name: "Adicionar área" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Design" }));
    expect(await within(await region()).findByRole("alert")).toHaveTextContent(/já tem/i);
    expect(screen.getByRole("heading", { name: "Este ticket" })).toBeInTheDocument();
  });
});

describe("situação, pessoas e remoção", () => {
  it("muda a situação pelo menu com as três", async () => {
    const user = userEvent.setup();
    const { updateContribution } = setup({ contributions: [design] });
    const gBlock = await block("Design");
    await user.click(within(gBlock).getByRole("button", { name: /A fazer/ }));
    const menu = screen.getByRole("menu", { name: "Situação" });
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual(["A fazer", "Em andamento", "Pronta"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Pronta" }));
    await waitFor(() => expect(updateContribution).toHaveBeenCalledWith("k1", { status: "done" }));
    expect(await within(await block("Design")).findByRole("button", { name: /Pronta/ })).toBeInTheDocument();
  });

  it("acrescenta e tira pessoas, como na linha Pessoas", async () => {
    const user = userEvent.setup();
    const { putContributionPerson, removeContributionPerson } = setup({ contributions: [dados] });
    const dBlock = await block("Dados");
    await user.click(within(dBlock).getByRole("button", { name: "Adicionar pessoa à área Dados" }));
    await user.selectOptions(within(dBlock).getByRole("combobox"), "person-1");
    await waitFor(() => expect(putContributionPerson).toHaveBeenCalledWith("k2", "person-1"));
    expect(await within(await block("Dados")).findByText("Ana")).toBeInTheDocument();
    await user.click(within(await block("Dados")).getByRole("button", { name: /Bruno/ }));
    await waitFor(() => expect(removeContributionPerson).toHaveBeenCalledWith("k2", "person-2"));
  });

  it("remover área pede confirmação e avisa que o texto será apagado", async () => {
    const user = userEvent.setup();
    const { removeContribution } = setup({ contributions: [design] });
    const gBlock = await block("Design");
    await user.click(within(gBlock).getByRole("button", { name: "Mais ações da área Design" }));
    await user.click(screen.getByRole("button", { name: "Remover área" }));
    expect(screen.getByText(/texto desta área/i)).toBeInTheDocument();
    expect(removeContribution).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(removeContribution).toHaveBeenCalledWith("k1"));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Design" })).toBeNull());
  });

  it("erro ao mexer numa contribuição aparece no bloco e a página continua", async () => {
    const user = userEvent.setup();
    const { client } = setup({ contributions: [design, dados] });
    client.updateContribution.mockResolvedValueOnce(failed("unavailable"));
    const gBlock = await block("Design");
    await user.click(within(gBlock).getByRole("button", { name: /A fazer/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Pronta" }));
    expect(await within(await block("Design")).findByRole("alert")).toBeInTheDocument();
    expect(within(await block("Dados")).queryByRole("alert")).toBeNull();
  });
});

describe("as frases novas da atividade", () => {
  const base = { occurredAt: "2026-11-22T11:00:00.000Z", actor: ana };
  const area = { id: "a1", name: "Design" };
  it("cada entrada de contribuição tem a sua frase", async () => {
    setup({
      contributions: [design],
      activity: [
        { ...base, id: "e7", type: "contribution_person_removed", area, person: bruno },
        { ...base, id: "e6", type: "contribution_person_added", area, person: bruno },
        { ...base, id: "e5", type: "contribution_status_changed", area, from: "todo", to: "in_progress" },
        { ...base, id: "e4", type: "contribution_text_changed", area },
        { ...base, id: "e3", type: "contribution_removed", area },
        { ...base, id: "e2", type: "contribution_added", area },
        { ...base, id: "e1", type: "contribution_added", area: null },
      ] as ActivityEntry[],
    });
    const activity = await screen.findByRole("region", { name: "Atividade" });
    const text = await waitFor(() => {
      const items = within(activity).getAllByRole("listitem").map((li) => li.textContent ?? "");
      expect(items).toHaveLength(7);
      return items;
    });
    // a lista mostra do mais antigo para o mais novo
    expect(text[0]).toContain("Ana adicionou a área (área apagada)");
    expect(text[1]).toContain("Ana adicionou a área Design");
    expect(text[2]).toContain("Ana removeu a área Design");
    expect(text[3]).toContain("Ana editou o texto de Design");
    expect(text[4]).toContain("Ana mudou Design de A fazer para Em andamento");
    expect(text[5]).toContain("Ana adicionou Bruno em Design");
    expect(text[6]).toContain("Ana tirou Bruno de Design");
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";
import type { TicketPageProps } from "./TicketPage.js";

// ADR 0042, fatia 2: a página do ticket com ideias.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const archivedProject = makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const people = [makePerson("person-1", "Ana")];

const tree = (): TicketSummary[] => [
  makeTicket("c1", "p1", 1, "Ticket comum", { key: "ALFA-1" }),
  makeTicket("c2", "p1", 2, "Filho comum", { key: "ALFA-2", parentId: "c1" }),
  makeTicket("i1", "p1", 3, "Ideia de busca", { key: "ALFA-3", idea: { root: true, stage: "refining" } }),
  makeTicket("i2", "p1", 4, "Parte da busca", { key: "ALFA-4", parentId: "i1" }),
  makeTicket("i3", "p1", 5, "Ideia descartada", { key: "ALFA-5", idea: { root: true, stage: "discarded" } }),
  makeTicket("i4", "p1", 6, "Ideia nova", { key: "ALFA-6", idea: { root: true, stage: "new" } }),
  makeTicket("w1", "p1", 7, "Em andamento", { key: "ALFA-7", status: "in_progress" }),
];

function setup(options: { me?: Me; project?: Project; ticketId: string; canTriageIdea?: boolean; client?: ApiClient; tickets?: TicketSummary[] }) {
  const theProject = options.project ?? project;
  const client =
    options.client ??
    makeTreeClient({ projects: [theProject], people, tickets: { p1: options.tickets ?? tree() }, ...(options.canTriageIdea === undefined ? {} : { canTriageIdea: options.canTriageIdea }) });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onShowOnMap: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const props: TicketPageProps = { client, me: options.me ?? makePanelMe("admin"), projects: [theProject], ticketId: options.ticketId, creating: null, ...handlers };
  render(<TicketPage {...props} />);
  return { client, ...handlers };
}
const loaded = () => screen.findByRole("heading", { level: 1 });
const row = (name: string) => {
  const term = screen.getByText(name, { selector: "dt" });
  return within(term.parentElement as HTMLElement);
};
const reader = () => makePanelMe("member", [{ projectId: "p1", role: "reader" }]);
const contributor = () => makePanelMe("member", [{ projectId: "p1", role: "contributor" }]);

describe("idea root: the 'Ideia' row", () => {
  it("replaces the 'Situação' row with 'Ideia' and shows the stage in a menu", async () => {
    setup({ ticketId: "i1" });
    await loaded();
    expect(screen.queryByText("Situação", { selector: "dt" })).not.toBeInTheDocument();
    expect(row("Ideia").getByRole("button", { name: /Em refinamento/ })).toBeInTheDocument();
  });

  it("offers Nova, Em refinamento and Pronta para triagem, and no 'Descartada'", async () => {
    const user = userEvent.setup();
    setup({ ticketId: "i1" });
    await loaded();
    await user.click(row("Ideia").getByRole("button", { name: /Em refinamento/ }));
    const menu = screen.getByRole("menu", { name: "Estágio da ideia" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Nova", "Em refinamento", "Pronta para triagem"]);
  });

  it("changes the stage through the API and shows the new one", async () => {
    const user = userEvent.setup();
    const { client, onChanged } = setup({ ticketId: "i1" });
    await loaded();
    await user.click(row("Ideia").getByRole("button", { name: /Em refinamento/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Pronta para triagem" }));
    expect(client.putIdeaStage).toHaveBeenCalledWith("i1", { stage: "ready" });
    expect(await row("Ideia").findByRole("button", { name: /Pronta para triagem/ })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("a contributor edits the stage but sees no 'Aceitar' or 'Descartar' without canTriageIdea", async () => {
    setup({ ticketId: "i1", me: contributor(), canTriageIdea: false });
    await loaded();
    expect(row("Ideia").getByRole("button", { name: /Em refinamento/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aceitar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Descartar/ })).not.toBeInTheDocument();
  });

  it("with canTriageIdea, shows 'Aceitar' and 'Descartar'", async () => {
    setup({ ticketId: "i1" });
    await loaded();
    expect(row("Ideia").getByRole("button", { name: "Aceitar" })).toBeInTheDocument();
    expect(row("Ideia").getByRole("button", { name: "Descartar" })).toBeInTheDocument();
  });

  it("'Aceitar' asks for confirmation that says what happens to the subtree, then accepts", async () => {
    const user = userEvent.setup();
    const { client, onChanged } = setup({ ticketId: "i1" });
    await loaded();
    await user.click(row("Ideia").getByRole("button", { name: "Aceitar" }));
    expect(client.acceptIdea).not.toHaveBeenCalled();
    expect(screen.getByText(/passam a ser tickets comuns/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(client.acceptIdea).toHaveBeenCalledWith("i1");
    // Aceita, a ideia vira ticket comum: volta a linha "Situação", em "A fazer".
    expect(await screen.findByText("Situação", { selector: "dt" })).toBeInTheDocument();
    expect(row("Situação").getByText("A fazer")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("'Descartar' asks for confirmation that says the subtree stays out of the process, then discards", async () => {
    const user = userEvent.setup();
    const { client } = setup({ ticketId: "i1" });
    await loaded();
    await user.click(row("Ideia").getByRole("button", { name: "Descartar" }));
    expect(client.discardIdea).not.toHaveBeenCalled();
    expect(screen.getByText(/continua fora do processo/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(client.discardIdea).toHaveBeenCalledWith("i1");
    expect(await row("Ideia").findByText("Descartada")).toBeInTheDocument();
    expect(row("Ideia").getByRole("button", { name: "Reabrir" })).toBeInTheDocument();
  });

  it("a discarded idea shows 'Descartada' and 'Reabrir', which puts it back in 'Em refinamento'", async () => {
    const user = userEvent.setup();
    const { client } = setup({ ticketId: "i3" });
    await loaded();
    expect(row("Ideia").getByText("Descartada")).toBeInTheDocument();
    expect(row("Ideia").queryByRole("button", { name: "Aceitar" })).not.toBeInTheDocument();
    await user.click(row("Ideia").getByRole("button", { name: "Reabrir" }));
    expect(client.putIdeaStage).toHaveBeenCalledWith("i3", { stage: "refining" });
    expect(await row("Ideia").findByRole("button", { name: /Em refinamento/ })).toBeInTheDocument();
  });

  it("'Reabrir' needs edit rights: a reader sees 'Descartada' and no button", async () => {
    setup({ ticketId: "i3", me: reader(), canTriageIdea: false });
    await loaded();
    expect(row("Ideia").getByText("Descartada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reabrir" })).not.toBeInTheDocument();
  });

  it("a reader sees the stage without menu and without buttons", async () => {
    setup({ ticketId: "i1", me: reader(), canTriageIdea: false });
    await loaded();
    expect(row("Ideia").getByText("Em refinamento")).toBeInTheDocument();
    expect(row("Ideia").queryByRole("button")).not.toBeInTheDocument();
  });

  it("an archived project shows the stage without menu and buttons, even for a manager", async () => {
    setup({ ticketId: "i1", project: archivedProject });
    await loaded();
    expect(row("Ideia").getByText("Em refinamento")).toBeInTheDocument();
    expect(row("Ideia").queryByRole("button")).not.toBeInTheDocument();
  });

  it("a stage change refused by the server shows the error in the row", async () => {
    const user = userEvent.setup();
    const { client } = setup({ ticketId: "i1" });
    (client.putIdeaStage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failed("conflict", "ticket_not_idea"));
    await loaded();
    await user.click(row("Ideia").getByRole("button", { name: /Em refinamento/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Nova" }));
    expect(await row("Ideia").findByRole("alert")).toBeInTheDocument();
  });
});

describe("ticket inside an idea", () => {
  it("shows 'Parte da ideia ALFA-3' with a link that opens the root, and no status menu", async () => {
    const user = userEvent.setup();
    const { onOpenTicket } = setup({ ticketId: "i2" });
    await loaded();
    const link = row("Situação").getByRole("button", { name: "ALFA-3" });
    expect(screen.getByText("Parte da ideia", { exact: false, selector: "span" }).closest("dd")).toHaveTextContent("Parte da ideia ALFA-3");
    expect(row("Situação").queryByRole("button", { name: /A fazer/ })).not.toBeInTheDocument();
    await user.click(link);
    expect(onOpenTicket).toHaveBeenCalledWith("i1");
  });

  it("offers only 'Novo ticket aqui dentro', not 'Nova ideia aqui dentro'", async () => {
    setup({ ticketId: "i2" });
    await loaded();
    expect(screen.getByRole("button", { name: "Novo ticket aqui dentro" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nova ideia aqui dentro" })).not.toBeInTheDocument();
  });

  it("the root offers only 'Novo ticket aqui dentro' too", async () => {
    setup({ ticketId: "i1" });
    await loaded();
    expect(screen.queryByRole("button", { name: "Nova ideia aqui dentro" })).not.toBeInTheDocument();
  });

  it("has no 'Transformar em ideia' in the more-actions menu", async () => {
    const user = userEvent.setup();
    setup({ ticketId: "i2" });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    expect(screen.queryByRole("button", { name: "Transformar em ideia" })).not.toBeInTheDocument();
  });

  it("a status refused with 409 ticket_in_idea shows a message in the row, not the generic error", async () => {
    const user = userEvent.setup();
    // A raiz mudou de lugar em outra aba: a página ainda mostra um ticket comum e o servidor recusa a situação.
    const client = makeTreeClient({ projects: [project], people, tickets: { p1: tree() } });
    (client.updateTicket as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failed("conflict", "ticket_in_idea"));
    setup({ ticketId: "w1", client });
    await loaded();
    await user.click(row("Situação").getByRole("button", { name: /Em andamento/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Concluído" }));
    const alert = await row("Situação").findByRole("alert");
    expect(alert).toHaveTextContent("Este ticket faz parte de uma ideia");
    expect(alert).not.toHaveTextContent("Algo deu errado");
  });
});

describe("creating ideas", () => {
  it("'Nova ideia aqui dentro' sits next to 'Novo ticket aqui dentro' and starts a creation marked as idea", async () => {
    const user = userEvent.setup();
    const { onStartCreate } = setup({ ticketId: "c1" });
    await loaded();
    expect(screen.getByRole("button", { name: "Novo ticket aqui dentro" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nova ideia aqui dentro" }));
    expect(onStartCreate).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", parentId: "c1", idea: true }));
  });

  it("'Novo ticket aqui dentro' still starts a plain creation", async () => {
    const user = userEvent.setup();
    const { onStartCreate } = setup({ ticketId: "c1" });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Novo ticket aqui dentro" }));
    expect(onStartCreate.mock.calls[0]?.[0]).not.toHaveProperty("idea");
  });

  it("a reader sees neither", async () => {
    setup({ ticketId: "c1", me: reader() });
    await loaded();
    expect(screen.queryByRole("button", { name: "Nova ideia aqui dentro" })).not.toBeInTheDocument();
  });
});

describe("'Transformar em ideia'", () => {
  it("is in the more-actions menu of a plain ticket and makes it an idea", async () => {
    const user = userEvent.setup();
    const { client, onChanged } = setup({ ticketId: "c2" });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.click(screen.getByRole("button", { name: "Transformar em ideia" }));
    expect(client.makeIdea).toHaveBeenCalledWith("c2");
    await screen.findByText("Ideia", { selector: "dt" });
    expect(row("Ideia").getByRole("button", { name: /Nova/ })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("is not offered on an idea root or to a reader", async () => {
    const user = userEvent.setup();
    setup({ ticketId: "i1" });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    expect(screen.queryByRole("button", { name: "Transformar em ideia" })).not.toBeInTheDocument();
  });

  it("shows the API's 409 as a message next to the menu", async () => {
    const user = userEvent.setup();
    setup({ ticketId: "w1" });
    await loaded();
    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    await user.click(screen.getByRole("button", { name: "Transformar em ideia" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("em andamento");
    expect(row("Situação").getByText("Em andamento")).toBeInTheDocument();
  });
});

describe("progress and items with ideas", () => {
  const withIdeas = () => [
    makeTicket("t1", "p1", 1, "Pai", { key: "ALFA-1", status: "in_progress" }),
    makeTicket("t2", "p1", 2, "Trabalho feito", { key: "ALFA-2", parentId: "t1", status: "done" }),
    makeTicket("t3", "p1", 3, "Trabalho aberto", { key: "ALFA-3", parentId: "t1" }),
    makeTicket("i1", "p1", 4, "Uma ideia", { key: "ALFA-4", parentId: "t1", idea: { root: true, stage: "new" } }),
  ];

  it("shows the ideas apart in the progress: 'n de m concluídos · 1 ideia'", async () => {
    setup({ ticketId: "t1", tickets: withIdeas() });
    await loaded();
    expect(row("Progresso").getByText("1 de 2 concluídos · 1 ideia")).toBeInTheDocument();
  });

  it("lists the idea in the items with its stage, and not as work", async () => {
    setup({ ticketId: "t1", tickets: withIdeas() });
    await loaded();
    const items = within(screen.getByRole("region", { name: "Itens" }));
    expect(items.getByText("Ideia · Nova")).toBeInTheDocument();
  });

  it("a parent with only ideas shows the idea count and no progress bar", async () => {
    setup({ ticketId: "t1", tickets: [withIdeas()[0]!, withIdeas()[3]!] });
    await loaded();
    expect(row("Progresso").getByText("1 ideia")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("without ideas the progress reads as before", async () => {
    setup({ ticketId: "t1", tickets: withIdeas().slice(0, 3) });
    await loaded();
    expect(row("Progresso").getByText("1 de 2 concluídos")).toBeInTheDocument();
  });
});

describe("wording", () => {
  it("says 'estágio', never 'tipo', on an idea page", async () => {
    const user = userEvent.setup();
    setup({ ticketId: "i1" });
    await loaded();
    await user.click(row("Ideia").getByRole("button", { name: /Em refinamento/ }));
    const texts = [document.body.textContent ?? "", ...[...document.body.querySelectorAll("[aria-label],[title]")].map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`)];
    expect(texts.filter((text) => /\btipos?\b/i.test(text))).toEqual([]);
    expect(screen.getByRole("menu", { name: "Estágio da ideia" })).toBeInTheDocument();
  });
});

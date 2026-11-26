import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me, Project, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import type { FakeSummaries } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const archivedProject = makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const summaries: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Entrega de dezembro", { key: "ALFA-1", progress: { done: 0, total: 2, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Escrever o texto", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", parentId: "t1" }),
  makeTicket("t4", "p1", 4, "Fase vazia", { key: "ALFA-4" }),
];
const detailOf = (summary: TicketSummary): TicketDetail => ({
  ...summary, description: "Descrição", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
});
const byAi = { text: "Reúne o trabalho da entrega de dezembro.", source: "assistant" as const, updatedAt: "2026-11-21T12:00:00.000Z" };
const byPerson = { text: "Tudo que sai em dezembro.", source: "person" as const, updatedAt: "2026-11-20T12:00:00.000Z" };

const aiMe = (me: Me = makePanelMe("admin")): Me => ({ ...me, assistant: { enabled: true } });
const reader = () => aiMe(makePanelMe("member", [{ projectId: "p1", role: "reader" }]));
const contributor = () => aiMe(makePanelMe("member", [{ projectId: "p1", role: "contributor" }]));

function setup(options: { me?: Me; project?: Project; ticketId?: string; summaries?: FakeSummaries; override?: Partial<Record<keyof ApiClient, unknown>> } = {}) {
  const me = options.me ?? aiMe();
  const theProject = options.project ?? project;
  const client = makeClient({ me, projects: [theProject], people: [makePerson("person-1", "Ana")], tickets: { p1: summaries }, summaries: { texts: { t1: byAi }, ...options.summaries } });
  Object.assign(client, {
    getTicket: vi.fn(async (id: string) => ok(detailOf(summaries.find((entry) => entry.id === id)!))),
    ...options.override,
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client} me={me} projects={[theProject]} ticketId={options.ticketId ?? "t1"} creating={null} {...handlers} />);
  return { client: client as ApiClient };
}
// A primeira renderização da página (módulos, catálogo de traduções, três requisições falsas encadeadas) é o trabalho pesado
// do arquivo: com a máquina carregada passa de 1 s, o prazo padrão do `findBy`. Prazo próprio para esperar a página, só aqui.
const LOAD = { timeout: 8000 };
const section = async () => within(await screen.findByRole("region", { name: "O que entra aqui" }, LOAD));
const pageLoaded = async () => {
  await screen.findByRole("heading", { level: 1 }, LOAD);
  await screen.findByText("Ticket pai", undefined, LOAD);
};
const noSection = async () => {
  await pageLoaded();
  expect(screen.queryByRole("region", { name: "O que entra aqui" })).not.toBeInTheDocument();
};

describe("Página do ticket com itens › O que entra aqui", { timeout: 15000 }, () => {
  it("shows the title, the help line, the text and who wrote it (the AI)", async () => {
    setup();
    const entra = await section();
    expect(entra.getByRole("heading", { level: 2, name: "O que entra aqui" })).toBeInTheDocument();
    expect(entra.getByText("A IA usa este texto para decidir se um ticket novo pertence a este ticket.")).toBeInTheDocument();
    expect(entra.getByText("Reúne o trabalho da entrega de dezembro.")).toBeInTheDocument();
    expect(entra.getByText("Escrito pela IA em 21 de novembro de 2026")).toBeInTheDocument();
  });

  it("says when a person edited the text", async () => {
    setup({ summaries: { texts: { t1: byPerson } } });
    const entra = await section();
    expect(entra.getByText("Tudo que sai em dezembro.")).toBeInTheDocument();
    expect(entra.getByText("Editado por uma pessoa em 20 de novembro de 2026")).toBeInTheDocument();
  });

  it("says the text was assembled from the items, with no date and no refresh button, when it is not a person's note", async () => {
    setup({ summaries: { texts: { t1: { text: "Contém: Escrever o texto; Revisar o texto", source: "built" } } } });
    const entra = await section();
    expect(entra.getByText("Contém: Escrever o texto; Revisar o texto")).toBeInTheDocument();
    expect(entra.getByText("Montado a partir dos itens deste ticket")).toBeInTheDocument();
    expect(entra.queryByText(/Escrito pela IA/)).not.toBeInTheDocument();
    expect(entra.queryByRole("button", { name: "Atualizar pela IA" })).not.toBeInTheDocument();
    expect(entra.getByRole("button", { name: "Editar" })).toBeInTheDocument();
  });

  it("without text, explains and offers Escrever instead of Editar", async () => {
    setup({ summaries: { texts: {} } });
    const entra = await section();
    expect(entra.getByText("Ainda sem texto. A IA escreve um na primeira procura que passar por aqui, ou você pode escrever agora.")).toBeInTheDocument();
    expect(entra.getByRole("button", { name: "Escrever" })).toBeInTheDocument();
    expect(entra.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(entra.queryByText(/Escrito pela IA|Editado por uma pessoa/)).not.toBeInTheDocument();
  });

  it("sits after the description and before the list of items", async () => {
    setup();
    const entra = await screen.findByRole("region", { name: "O que entra aqui" }, LOAD);
    const description = screen.getByRole("region", { name: "Descrição" });
    const items = screen.getByRole("region", { name: "Itens" });
    expect(description.compareDocumentPosition(entra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(entra.compareDocumentPosition(items) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe("editing", () => {
    it("Editar swaps the text for a text area with the current text and a counter up to 1.000", async () => {
      setup();
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      const area = entra.getByRole("textbox", { name: "O que entra aqui" });
      expect(area).toHaveValue(byAi.text);
      expect(entra.getByText(`${byAi.text.length} de 1.000 caracteres`)).toBeInTheDocument();
      expect(entra.getByRole("button", { name: "Salvar" })).toBeEnabled();
      expect(entra.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
      expect(entra.queryByText("Escrito pela IA em 21 de novembro de 2026")).not.toBeInTheDocument();
    });

    it("Salvar calls PUT with the text and shows the new text as written by a person", async () => {
      const { client } = setup();
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      const area = entra.getByRole("textbox", { name: "O que entra aqui" });
      await userEvent.clear(area);
      await userEvent.type(area, "Só o que sai em dezembro.");
      await userEvent.click(entra.getByRole("button", { name: "Salvar" }));
      await waitFor(() => expect(client.putTicketSummary).toHaveBeenCalledWith("t1", { text: "Só o que sai em dezembro." }));
      expect(await entra.findByText("Só o que sai em dezembro.")).toBeInTheDocument();
      expect(entra.getByText("Editado por uma pessoa em 21 de novembro de 2026")).toBeInTheDocument();
      expect(entra.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("Cancelar leaves the old text and calls nothing", async () => {
      const { client } = setup();
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      await userEvent.type(entra.getByRole("textbox", { name: "O que entra aqui" }), " mais");
      await userEvent.click(entra.getByRole("button", { name: "Cancelar" }));
      expect(entra.getByText(byAi.text)).toBeInTheDocument();
      expect(entra.getByText("Escrito pela IA em 21 de novembro de 2026")).toBeInTheDocument();
      expect(client.putTicketSummary).not.toHaveBeenCalled();
    });

    it("Esc cancels only the edit and does not close the page", async () => {
      setup();
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      await userEvent.type(entra.getByRole("textbox", { name: "O que entra aqui" }), "{Escape}");
      expect(entra.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByRole("complementary", { name: "Página do ticket" })).toBeInTheDocument();
    });

    it("an empty text does not save", async () => {
      const { client } = setup();
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      await userEvent.clear(entra.getByRole("textbox", { name: "O que entra aqui" }));
      expect(entra.getByRole("button", { name: "Salvar" })).toBeDisabled();
      await userEvent.type(entra.getByRole("textbox", { name: "O que entra aqui" }), "   ");
      expect(entra.getByRole("button", { name: "Salvar" })).toBeDisabled();
      expect(client.putTicketSummary).not.toHaveBeenCalled();
    });

    it("a text over 1.000 characters does not save and the counter says so", async () => {
      const { client } = setup({ summaries: { texts: {} } });
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Escrever" }));
      const area = entra.getByRole("textbox", { name: "O que entra aqui" });
      await userEvent.click(area);
      await userEvent.paste("a".repeat(1001));
      expect(entra.getByText("1001 de 1.000 caracteres")).toBeInTheDocument();
      expect(entra.getByRole("button", { name: "Salvar" })).toBeDisabled();
      expect(client.putTicketSummary).not.toHaveBeenCalled();
    });

    it("Escrever on a ticket without text saves the first text", async () => {
      const { client } = setup({ summaries: { texts: {} }, ticketId: "t1" });
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Escrever" }));
      await userEvent.type(entra.getByRole("textbox", { name: "O que entra aqui" }), "Fases do plano");
      await userEvent.click(entra.getByRole("button", { name: "Salvar" }));
      await waitFor(() => expect(client.putTicketSummary).toHaveBeenCalledWith("t1", { text: "Fases do plano" }));
      expect(await entra.findByText("Fases do plano")).toBeInTheDocument();
      expect(entra.getByRole("button", { name: "Editar" })).toBeInTheDocument();
    });
  });

  describe("Atualizar pela IA", () => {
    it("asks for confirmation with the effect, and cancelling calls nothing", async () => {
      const { client } = setup();
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Atualizar pela IA" }));
      expect(entra.getByText("O texto atual será substituído por um novo, escrito a partir dos itens de agora.")).toBeInTheDocument();
      await userEvent.click(entra.getByRole("button", { name: "Cancelar" }));
      expect(client.regenerateTicketSummary).not.toHaveBeenCalled();
      expect(entra.getByText(byAi.text)).toBeInTheDocument();
    });

    it("on confirm calls the regenerate route and shows the new text as written by the AI", async () => {
      const { client } = setup({ summaries: { texts: { t1: byPerson }, regenerated: "Texto novo escrito pela IA." } });
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Atualizar pela IA" }));
      await userEvent.click(entra.getByRole("button", { name: /Confirmar/ }));
      await waitFor(() => expect(client.regenerateTicketSummary).toHaveBeenCalledWith("t1"));
      expect(await entra.findByText("Texto novo escrito pela IA.")).toBeInTheDocument();
      expect(entra.getByText("Escrito pela IA em 21 de novembro de 2026")).toBeInTheDocument();
      expect(entra.queryByText("Tudo que sai em dezembro.")).not.toBeInTheDocument();
    });

    it("while writing, shows Escrevendo… and disables the buttons", async () => {
      let finish: (value: unknown) => void = () => undefined;
      const regenerateTicketSummary = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
      setup({ override: { regenerateTicketSummary } });
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Atualizar pela IA" }));
      await userEvent.click(entra.getByRole("button", { name: /Confirmar/ }));
      expect(await entra.findByText("Escrevendo…")).toBeInTheDocument();
      expect(entra.getByRole("button", { name: "Editar" })).toBeDisabled();
      expect(entra.getByRole("button", { name: "Atualizar pela IA" })).toBeDisabled();
      finish(ok({ summary: { ...byAi, text: "Pronto." } }));
      expect(await entra.findByText("Pronto.")).toBeInTheDocument();
      expect(entra.queryByText("Escrevendo…")).not.toBeInTheDocument();
      expect(entra.getByRole("button", { name: "Editar" })).toBeEnabled();
    });

  });

  describe("errors, next to the control", () => {
    const regenerateFlow = async () => {
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Atualizar pela IA" }));
      await userEvent.click(entra.getByRole("button", { name: /Confirmar/ }));
      return entra;
    };

    it("ticket_has_no_items", async () => {
      setup({ override: { regenerateTicketSummary: vi.fn(async () => failed("conflict", "ticket_has_no_items")) } });
      const entra = await regenerateFlow();
      expect(await entra.findByRole("alert")).toHaveTextContent("Este ticket ainda não tem itens.");
      expect(entra.getByText(byAi.text)).toBeInTheDocument();
    });

    it("provider unavailable, with the message the AI panel already uses", async () => {
      setup({ summaries: { providerUp: false } });
      const entra = await regenerateFlow();
      expect(await entra.findByRole("alert")).toHaveTextContent("O assistente não respondeu. Tente de novo; se continuar, crie o ticket manualmente.");
      expect(entra.getByRole("button", { name: "Atualizar pela IA" })).toBeEnabled();
    });

    it("project_archived while regenerating", async () => {
      setup({ override: { regenerateTicketSummary: vi.fn(async () => failed("conflict", "project_archived")) } });
      const entra = await regenerateFlow();
      expect(await entra.findByRole("alert")).toHaveTextContent("O projeto está arquivado e só aceita leitura.");
    });

    it("validation_error on save keeps the edit open", async () => {
      setup({ override: { putTicketSummary: vi.fn(async () => failed("invalid", "validation_error")) } });
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      await userEvent.type(entra.getByRole("textbox", { name: "O que entra aqui" }), " mais");
      await userEvent.click(entra.getByRole("button", { name: "Salvar" }));
      expect(await entra.findByRole("alert")).toHaveTextContent("O texto precisa ter entre 1 e 1.000 caracteres.");
      expect(entra.getByRole("textbox", { name: "O que entra aqui" })).toHaveValue(`${byAi.text} mais`);
    });

    it("project_archived while saving", async () => {
      setup({ override: { putTicketSummary: vi.fn(async () => failed("conflict", "project_archived")) } });
      const entra = await section();
      await userEvent.click(entra.getByRole("button", { name: "Editar" }));
      await userEvent.type(entra.getByRole("textbox", { name: "O que entra aqui" }), " mais");
      await userEvent.click(entra.getByRole("button", { name: "Salvar" }));
      expect(await entra.findByRole("alert")).toHaveTextContent("O projeto está arquivado e só aceita leitura.");
    });

    it("an old error goes away on the next try", async () => {
      const regenerateTicketSummary = vi.fn().mockResolvedValueOnce(failed("conflict", "ticket_has_no_items")).mockResolvedValue(ok({ summary: { ...byAi, text: "Agora foi." } }));
      setup({ override: { regenerateTicketSummary } });
      const entra = await regenerateFlow();
      await entra.findByRole("alert");
      await userEvent.click(entra.getByRole("button", { name: "Atualizar pela IA" }));
      await userEvent.click(entra.getByRole("button", { name: /Confirmar/ }));
      expect(await entra.findByText("Agora foi.")).toBeInTheDocument();
      expect(entra.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("who sees what", () => {
    it("a contributor can edit and update", async () => {
      setup({ me: contributor() });
      const entra = await section();
      expect(entra.getByRole("button", { name: "Editar" })).toBeInTheDocument();
      expect(entra.getByRole("button", { name: "Atualizar pela IA" })).toBeInTheDocument();
    });

    it("a reader sees the text and its author, with no actions", async () => {
      setup({ me: reader() });
      const entra = await section();
      expect(entra.getByText(byAi.text)).toBeInTheDocument();
      expect(entra.getByText("Escrito pela IA em 21 de novembro de 2026")).toBeInTheDocument();
      expect(entra.queryByRole("button")).not.toBeInTheDocument();
    });

    it("a reader sees the empty explanation with no Escrever", async () => {
      setup({ me: reader(), summaries: { texts: {} } });
      const entra = await section();
      expect(entra.getByText(/Ainda sem texto/)).toBeInTheDocument();
      expect(entra.queryByRole("button")).not.toBeInTheDocument();
    });

    it("in an archived project nobody has actions, not even an admin", async () => {
      setup({ project: archivedProject });
      const entra = await section();
      expect(entra.getByText(byAi.text)).toBeInTheDocument();
      expect(entra.queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("when it does not appear", () => {
    it("a ticket without children has no section and the route is not called, whatever the AI", async () => {
      const { client } = setup({ ticketId: "t4" });
      await noSection();
      expect(client.getTicketSummary).not.toHaveBeenCalled();
    });

    it("a leaf inside a ticket has no section either", async () => {
      const { client } = setup({ ticketId: "t2" });
      await noSection();
      expect(client.getTicketSummary).not.toHaveBeenCalled();
    });

    it("a ticket that gets its first child shows the section", async () => {
      const { client } = setup({ ticketId: "t1", summaries: { texts: {} } });
      const entra = await section();
      expect(entra.getByRole("button", { name: "Escrever" })).toBeInTheDocument();
      expect(client.getTicketSummary).toHaveBeenCalledWith("t1");
    });

    it("with the AI off there is no section and no summary route is called", async () => {
      const off = makePanelMe("admin");
      const { client } = setup({ me: { ...off, assistant: { enabled: false } } });
      await noSection();
      expect(client.getTicketSummary).not.toHaveBeenCalled();
      expect(client.putTicketSummary).not.toHaveBeenCalled();
      expect(client.regenerateTicketSummary).not.toHaveBeenCalled();
    });

    it("with an API that does not send the AI flag it counts as off", async () => {
      const { client } = setup({ me: makePanelMe("admin") });
      await noSection();
      expect(client.getTicketSummary).not.toHaveBeenCalled();
    });

    it("a failed GET hides the section, as the Código section does", async () => {
      const { client } = setup({ override: { getTicketSummary: vi.fn(async () => failed("unavailable")) } });
      await waitFor(() => expect(client.getTicketSummary).toHaveBeenCalledWith("t1"));
      await noSection();
      expect(screen.queryByRole("heading", { name: "O que entra aqui" })).not.toBeInTheDocument();
    });
  });
});

describe("sem o aceite da organização (ADR 0039)", () => {
  it("servidor configurado mas sem aceite: a página não mostra o texto do agrupador, como com a IA desligada", async () => {
    setup({ me: { ...makePanelMe("admin"), assistant: { enabled: false, configured: true, consent: false } } });
    await noSection();
  });
});

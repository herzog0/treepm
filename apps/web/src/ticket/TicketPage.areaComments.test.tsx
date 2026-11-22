import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityComment, ActivityEntry, ApiClient, Contribution, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0041, fatia 2: a conversa de cada área e a etiqueta de área na Atividade. Digitar no editor fica na suíte de navegador.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Este ticket", { key: "ALFA-1" })];
const ana = { id: "person-1", displayName: "Ana", avatarUrl: null };
const base = { text: "", status: "todo" as const, people: [] };
const design: Contribution = { id: "k1", area: { id: "a1", name: "Design" }, commentCount: 0, ...base };
const dados: Contribution = { id: "k2", area: { id: "a2", name: "Dados" }, commentCount: 0, ...base };
const NOW = Date.parse("2026-11-22T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

type Stored = ActivityComment & { contributionId: string | null };
let counter = 0;
const stored = (data: Partial<Stored> & { contributionId?: string | null }): Stored => ({
  id: `c${++counter}`, type: "comment", occurredAt: at(5), actor: ana, body: `Texto ${counter}`, editedAt: null, removed: false, canEdit: false, canRemove: false, area: null, contributionId: null, ...data,
});

type Options = { contributions?: Contribution[]; comments?: Stored[]; reader?: boolean; archived?: boolean; canComment?: boolean };
function setup(options: Options = {}) {
  const proj = options.archived ? makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" }) : project;
  const contributions = options.contributions ?? [design, dados];
  const comments = [...(options.comments ?? [])];
  const canComment = options.canComment ?? (!options.reader && !options.archived);
  const live = (id: string) => comments.filter((c) => c.contributionId === id && !c.removed).length;
  const detail = (): TicketDetail => ({
    ...summaries[0]!, description: "Texto", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    contributions: contributions.map((c) => ({ ...c, commentCount: live(c.id) })), canEditContributions: canComment,
  });
  const strip = (entry: Stored): ActivityComment => {
    const { contributionId, ...rest } = entry;
    void contributionId;
    return rest;
  };
  const client = makeClient({ projects: [proj], people: [makePerson("person-1", "Ana"), makePerson("person-2", "Bruno")], tickets: { p1: summaries }, areas: [{ id: "a1", name: "Design" }, { id: "a2", name: "Dados" }] });
  const spies = {
    ticketActivity: vi.fn(async (_id: string, query: { contribution?: string } = {}) => {
      const list = (query.contribution ? comments.filter((c) => c.contributionId === query.contribution) : comments).slice().reverse();
      return ok({ entries: list.map(strip) as ActivityEntry[], before: null, canComment });
    }),
    createTicketComment: vi.fn(async (_id: string, body: { body: string; contributionId?: string }) => {
      const created = stored({ body: body.body, contributionId: body.contributionId ?? null, canEdit: true, canRemove: true, area: body.contributionId ? { id: body.contributionId, name: contributions.find((c) => c.id === body.contributionId)!.area.name } : null });
      comments.push(created);
      return ok(strip(created));
    }),
    updateComment: vi.fn(async (id: string, body: { body: string }) => {
      const found = comments.find((c) => c.id === id)!;
      Object.assign(found, { body: body.body, editedAt: at(0) });
      return ok(strip(found));
    }),
    removeComment: vi.fn(async (id: string) => {
      Object.assign(comments.find((c) => c.id === id)!, { body: null, removed: true, canEdit: false, canRemove: false });
      return ok(undefined);
    }),
    removeContribution: vi.fn(async (id: string) => {
      for (const c of comments) if (c.contributionId === id) Object.assign(c, { area: { id: null, name: contributions.find((x) => x.id === id)!.area.name }, contributionId: null });
      contributions.splice(contributions.findIndex((c) => c.id === id), 1);
      return ok(null);
    }),
  };
  Object.assign(client, spies, { getTicket: vi.fn(async () => ok(detail())), updateTicket: vi.fn(async () => ok(detail())) });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  render(<TicketPage client={client as ApiClient} me={makePanelMe(options.reader ? "member" : "admin")} projects={[proj]} ticketId="t1" creating={null} {...handlers} />);
  return { client: client as ApiClient & typeof spies, comments, ...spies };
}
const areaBlock = async (name: string) => within(await screen.findByRole("region", { name: "Áreas" })).findByRole("group", { name });
const toggle = async (name: string) => {
  const found = (await areaBlock(name)).querySelector<HTMLElement>(".ticket-conversation-row button");
  if (!found) throw new Error(`sem linha de conversa em ${name}`);
  return found;
};
const activity = () => screen.findByRole("region", { name: "Atividade" });
const activityComments = async (expected: number) => {
  const region = await activity();
  await waitFor(() => expect(region.querySelectorAll(".ticket-activity-comment")).toHaveLength(expected));
  return Array.from(region.querySelectorAll<HTMLElement>(".ticket-activity-comment"));
};
const conversationOf = async (name: string) => within(await areaBlock(name)).findByRole("region", { name: `Conversa da área ${name}` });

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("a linha «Conversa» no bloco da área", () => {
  it("mostra «Comentar» sem comentários e a contagem quando há", async () => {
    setup({ comments: [stored({ contributionId: "k2", body: "a" }), stored({ contributionId: "k2", body: "b" }), stored({ contributionId: "k2", body: "c" }), stored({ contributionId: null })] });
    expect(await toggle("Design")).toHaveTextContent("Comentar");
    const dadosToggle = await toggle("Dados");
    expect(dadosToggle).toHaveTextContent("3 comentários");
    expect(dadosToggle).toHaveAttribute("aria-expanded", "false");
  });

  it("singular com um comentário; só os comentários vivos contam", async () => {
    setup({ comments: [stored({ contributionId: "k1" }), stored({ contributionId: "k1", body: null, removed: true })] });
    expect(await toggle("Design")).toHaveTextContent("1 comentário");
  });

  it("não busca nada da conversa até ela ser aberta", async () => {
    const view = setup({ comments: [stored({ contributionId: "k1" })] });
    await toggle("Design");
    await activityComments(1);
    expect(view.ticketActivity.mock.calls.filter(([, query]) => (query as { contribution?: string } | undefined)?.contribution)).toHaveLength(0);
  });
});

describe("abrir e recolher a conversa", () => {
  it("abre dentro do bloco só com os comentários daquela área, do mais antigo para o mais novo, e busca só os comentários", async () => {
    const user = userEvent.setup();
    const view = setup({ comments: [stored({ contributionId: "k1", body: "Primeiro", occurredAt: at(9) }), stored({ contributionId: "k2", body: "De outra área" }), stored({ contributionId: "k1", body: "Segundo", occurredAt: at(3) }), stored({ body: "Do ticket" })] });
    await user.click(await toggle("Design"));
    const conversation = await conversationOf("Design");
    const items = await waitFor(() => {
      const found = Array.from(conversation.querySelectorAll(".ticket-activity-comment"));
      expect(found).toHaveLength(2);
      return found;
    });
    expect(items[0]).toHaveTextContent("Primeiro");
    expect(items[1]).toHaveTextContent("Segundo");
    expect(conversation).not.toHaveTextContent("De outra área");
    expect(conversation).not.toHaveTextContent("Do ticket");
    expect(view.ticketActivity).toHaveBeenCalledWith("t1", expect.objectContaining({ contribution: "k1" }), expect.anything());
    expect(await toggle("Design")).toHaveAttribute("aria-expanded", "true");
    // dentro do bloco, não numa seção à parte
    expect(within(await areaBlock("Design")).getByRole("region", { name: "Conversa da área Design" })).toBe(conversation);
  });

  it("clicar de novo recolhe, e o campo de escrever aparece só para quem pode comentar", async () => {
    const user = userEvent.setup();
    setup({ comments: [stored({ contributionId: "k1" })] });
    await user.click(await toggle("Design"));
    const conversation = await conversationOf("Design");
    expect(await within(conversation).findByRole("textbox", { name: "Novo comentário na área Design" })).toBeInTheDocument();
    expect(within(conversation).getByRole("button", { name: "Comentar" })).toBeDisabled();
    await user.click(await toggle("Design"));
    expect(within(await areaBlock("Design")).queryByRole("region", { name: "Conversa da área Design" })).toBeNull();
  });

  it("a conversa vazia convida a comentar", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await toggle("Dados"));
    const conversation = await conversationOf("Dados");
    expect(await within(conversation).findByRole("textbox", { name: "Novo comentário na área Dados" })).toBeInTheDocument();
    expect(conversation.querySelector(".ticket-activity-comment")).toBeNull();
  });
});

describe("leitor e projeto arquivado", () => {
  it.each([["leitor", { reader: true }], ["projeto arquivado", { archived: true }]])("%s abre a conversa e lê, sem campo e sem ações", async (_name, options) => {
    const user = userEvent.setup();
    setup({ ...options, comments: [stored({ contributionId: "k1", body: "Só leitura" })] });
    await user.click(await toggle("Design"));
    const conversation = await conversationOf("Design");
    expect(await within(conversation).findByText("Só leitura")).toBeInTheDocument();
    expect(within(conversation).queryByRole("textbox")).toBeNull();
    expect(within(conversation).queryByRole("button")).toBeNull();
  });
});

describe("remover na conversa e na Atividade (editar de verdade fica na suíte de navegador)", () => {
  it("remover pede confirmação, atualiza a contagem e a seção Atividade", async () => {
    const user = userEvent.setup();
    const view = setup({ comments: [stored({ contributionId: "k1", body: "Vai sumir", canRemove: true, area: { id: "k1", name: "Design" } }), stored({ contributionId: "k1", body: "Fica", canRemove: true, area: { id: "k1", name: "Design" } })] });
    expect(await toggle("Design")).toHaveTextContent("2 comentários");
    await activityComments(2);
    await user.click(await toggle("Design"));
    const conversation = await conversationOf("Design");
    const target = await within(conversation).findByText("Vai sumir");
    const item = target.closest<HTMLElement>(".ticket-activity-comment")!;
    await user.click(within(item).getByRole("button", { name: "Remover" }));
    await user.click(within(item).getByRole("button", { name: /Confirmar/ }));
    expect(view.removeComment).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(item).getByText("Comentário removido")).toBeInTheDocument());
    await waitFor(async () => expect(await toggle("Design")).toHaveTextContent("1 comentário"));
    const region = await activity();
    await waitFor(() => expect(within(region).getAllByText("Comentário removido")).toHaveLength(1));
    expect(within(region).queryByText("Vai sumir")).toBeNull();
  });

  it("remover na seção Atividade atualiza a conversa aberta e a contagem", async () => {
    const user = userEvent.setup();
    setup({ comments: [stored({ contributionId: "k1", body: "Da área", canRemove: true, area: { id: "k1", name: "Design" } })] });
    await user.click(await toggle("Design"));
    const conversation = await conversationOf("Design");
    await within(conversation).findByText("Da área");
    const [inActivity] = await activityComments(1);
    await user.click(within(inActivity!).getByRole("button", { name: "Remover" }));
    await user.click(within(inActivity!).getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(within(conversation).queryByText("Da área")).toBeNull());
    await waitFor(async () => expect(await toggle("Design")).toHaveTextContent("Comentar"));
  });
});

describe("a etiqueta de área na Atividade", () => {
  it("o comentário de área traz o nome da área; o do ticket não traz etiqueta", async () => {
    setup({ comments: [stored({ contributionId: "k1", body: "Na área", area: { id: "k1", name: "Design" } }), stored({ body: "No ticket" })] });
    const items = await activityComments(2);
    const inArea = items.find((item) => item.textContent?.includes("Na área"))!;
    const inTicket = items.find((item) => item.textContent?.includes("No ticket"))!;
    expect(within(inArea).getByRole("button", { name: "Abrir a conversa da área Design" })).toHaveTextContent("Design");
    expect(inTicket.querySelector(".ticket-comment-area")).toBeNull();
  });

  it("clicar na etiqueta abre a conversa daquela área, no bloco", async () => {
    const user = userEvent.setup();
    const view = setup({ comments: [stored({ contributionId: "k2", body: "Sobre dados", area: { id: "k2", name: "Dados" } })] });
    const [item] = await activityComments(1);
    expect(within(await areaBlock("Dados")).queryByRole("region", { name: "Conversa da área Dados" })).toBeNull();
    await user.click(within(item!).getByRole("button", { name: "Abrir a conversa da área Dados" }));
    const conversation = await conversationOf("Dados");
    expect(await within(conversation).findByText("Sobre dados")).toBeInTheDocument();
    expect(view.ticketActivity).toHaveBeenCalledWith("t1", expect.objectContaining({ contribution: "k2" }), expect.anything());
    expect(await toggle("Dados")).toHaveAttribute("aria-expanded", "true");
  });

  it("área removida: mostra o nome guardado e não é clicável", async () => {
    setup({ comments: [stored({ body: "Sobrou", area: { id: null, name: "Jurídico" } })] });
    const [item] = await activityComments(1);
    const tag = item!.querySelector(".ticket-comment-area")!;
    expect(tag).toHaveTextContent("Jurídico");
    expect(tag.tagName).not.toBe("BUTTON");
    expect(within(item!).queryByRole("button", { name: /Abrir a conversa/ })).toBeNull();
  });

  it("a etiqueta não aparece dentro da conversa da própria área", async () => {
    const user = userEvent.setup();
    setup({ comments: [stored({ contributionId: "k1", body: "Aqui", area: { id: "k1", name: "Design" } })] });
    await user.click(await toggle("Design"));
    const conversation = await conversationOf("Design");
    await within(conversation).findByText("Aqui");
    expect(conversation.querySelector(".ticket-comment-area")).toBeNull();
  });
});

describe("remover uma área com comentários", () => {
  it("a confirmação diz que os comentários continuam no ticket", async () => {
    const user = userEvent.setup();
    setup({ comments: [stored({ contributionId: "k1" })] });
    await user.click(within(await areaBlock("Design")).getByRole("button", { name: "Mais ações da área Design" }));
    await user.click(screen.getByRole("button", { name: "Remover área" }));
    expect(screen.getByText(/Os comentários dela continuam no ticket/)).toBeInTheDocument();
  });

  it("sem comentários, a confirmação é a de antes", async () => {
    const user = userEvent.setup();
    setup({ comments: [stored({ contributionId: "k1", body: null, removed: true })] });
    await user.click(within(await areaBlock("Design")).getByRole("button", { name: "Mais ações da área Design" }));
    await user.click(screen.getByRole("button", { name: "Remover área" }));
    expect(screen.getByText(/texto desta área/i)).toBeInTheDocument();
    expect(screen.queryByText(/continuam no ticket/)).toBeNull();
  });

  it("depois de remover, o comentário continua na Atividade com a etiqueta de área removida", async () => {
    const user = userEvent.setup();
    setup({ comments: [stored({ contributionId: "k1", body: "Continua", area: { id: "k1", name: "Design" } })] });
    await activityComments(1);
    await user.click(within(await areaBlock("Design")).getByRole("button", { name: "Mais ações da área Design" }));
    await user.click(screen.getByRole("button", { name: "Remover área" }));
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Design" })).toBeNull());
    await waitFor(() => {
      const tag = document.querySelector(".ticket-activity-comment .ticket-comment-area");
      expect(tag).toHaveTextContent("Design");
      expect(tag?.tagName).not.toBe("BUTTON");
    });
  });
});

describe("os três idiomas", () => {
  it.each([
    ["pt-BR", "Comentar", "2 comentários"],
    ["en", "Comment", "2 comments"],
    ["es-MX", "Comentar", "2 comentarios"],
  ])("%s", async (language, none, two) => {
    await setTestLanguage(language as "pt-BR");
    setup({ comments: [stored({ contributionId: "k2" }), stored({ contributionId: "k2" })] });
    const region = await screen.findByRole("region", { name: language === "pt-BR" ? "Áreas" : language === "en" ? "Areas" : "Áreas" });
    await waitFor(() => expect(region).toHaveTextContent(two));
    expect(region).toHaveTextContent(none);
  });
});

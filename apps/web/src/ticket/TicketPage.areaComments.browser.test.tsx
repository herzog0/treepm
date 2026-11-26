import "../theme.css";
import "../styles.css";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { ActivityComment, ActivityEntry, ApiClient, Contribution, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";

// ADR 0041, fatia 2, em navegador real: escrever, editar e remover nas duas pontas, e (com VITE_TREEPM_CAPTURES) as capturas da conferência visual.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Tela de acesso por token", { key: "ALFA-1" })];
const ana = { id: "person-1", displayName: "Ana Souza", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno Lima", avatarUrl: null };
const base = { text: "", status: "todo" as const, people: [] };
const design: Contribution = { id: "k1", area: { id: "a1", name: "Design" }, commentCount: 0, ...base, text: "Telas de **login** e de erro", status: "in_progress", people: [ana] };
const dados: Contribution = { id: "k2", area: { id: "a2", name: "Dados" }, commentCount: 0, ...base };
const dir = import.meta.env["VITE_TREEPM_CAPTURES"] as string | undefined;
const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Stored = ActivityComment & { contributionId: string | null };
let counter = 0;
const stored = (data: Partial<Stored>): Stored => ({ id: `c${++counter}`, type: "comment", occurredAt: at(5), actor: ana, body: "Texto", editedAt: null, removed: false, canEdit: true, canRemove: true, area: null, contributionId: null, ...data });
const inArea = (contribution: Contribution, data: Partial<Stored>): Stored => stored({ contributionId: contribution.id, area: { id: contribution.id, name: contribution.area.name }, ...data });

async function open(initial: Stored[] = [], options: { contributions?: Contribution[] } = {}) {
  await page.viewport(1100, 1700);
  const comments = [...initial];
  const contributions = options.contributions ?? [design, dados];
  const client = makeClient({ projects: [project], people: [ana, bruno].map((p) => makePerson(p.id, p.displayName)), tickets: { p1: summaries }, areas: [{ id: "a1", name: "Design" }, { id: "a2", name: "Dados" }] });
  const strip = (entry: Stored): ActivityComment => {
    const { contributionId, ...rest } = entry;
    void contributionId;
    return rest;
  };
  const spies = {
    createTicketComment: vi.fn(async (_id: string, body: { body: string; contributionId?: string }) => {
      const owner = contributions.find((c) => c.id === body.contributionId);
      const created = owner ? inArea(owner, { body: body.body }) : stored({ body: body.body });
      comments.push(created);
      return ok(strip(created));
    }),
    updateComment: vi.fn(async (id: string, body: { body: string }) => {
      const found = comments.find((c) => c.id === id)!;
      Object.assign(found, { body: body.body, editedAt: new Date().toISOString() });
      return ok(strip(found));
    }),
    removeComment: vi.fn(async (id: string) => {
      Object.assign(comments.find((c) => c.id === id)!, { body: null, removed: true, canEdit: false, canRemove: false });
      return ok(undefined);
    }),
    removeContribution: vi.fn(async () => ok(null)),
  };
  Object.assign(client, spies, {
    getTicket: vi.fn(async () =>
      ok<TicketDetail>({
        ...summaries[0]!, description: "Fluxo de acesso com token por projeto.", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
        contributions: contributions.map((c) => ({ ...c, commentCount: comments.filter((x) => x.contributionId === c.id && !x.removed).length })), canEditContributions: true,
      }),
    ),
    ticketActivity: vi.fn(async (_id: string, query: { contribution?: string } = {}) => {
      const list = (query.contribution ? comments.filter((c) => c.contributionId === query.contribution) : comments).slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      return ok({ entries: list.map(strip) as ActivityEntry[], before: null, canComment: true });
    }),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(
    <div style={{ position: "relative", height: "1700px" }}>
      <TicketPage client={client as ApiClient} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />
    </div>,
  );
  await expect.element(screen.getByRole("region", { name: "Áreas" })).toBeVisible();
  return { screen, comments, ...spies };
}
const rowOf = (area: string) => document.querySelector<HTMLElement>(`[aria-label="${area}"] .ticket-conversation-row button`)!;
const countOf = (area: string) => rowOf(area).textContent;

describe("escrever na conversa de uma área", () => {
  it("o botão envia com o contributionId, o campo esvazia, a contagem sobe e o comentário aparece na Atividade com a etiqueta", async () => {
    const view = await open();
    expect(countOf("Dados")).toBe("Comentar");
    rowOf("Dados").click();
    const field = view.screen.getByRole("textbox", { name: "Novo comentário na área Dados" });
    await field.click();
    await userEvent.keyboard("Falta o **dicionário** de dados");
    await view.screen.getByRole("region", { name: "Conversa da área Dados" }).getByRole("button", { name: "Comentar" }).click();
    await expect.poll(() => view.createTicketComment.mock.calls.length).toBe(1);
    expect(view.createTicketComment.mock.calls[0]).toEqual(["t1", { body: "Falta o **dicionário** de dados", contributionId: "k2" }]);
    await expect.poll(() => countOf("Dados")).toBe("1 comentário");
    expect(document.querySelector('[aria-label="Dados"] .ticket-composer .tiptap, [aria-label="Dados"] .ticket-comment-composer .tiptap')?.textContent).toBe("");
    await expect.poll(() => document.querySelectorAll(".ticket-activity .ticket-activity-comment").length).toBe(1);
    expect(document.querySelector(".ticket-activity .ticket-comment-area")?.textContent).toBe("Dados");
  });

  it("Ctrl+Enter envia; Enter sozinho quebra a linha", async () => {
    const view = await open();
    rowOf("Dados").click();
    await view.screen.getByRole("textbox", { name: "Novo comentário na área Dados" }).click();
    await userEvent.keyboard("linha um{Enter}linha dois");
    expect(view.createTicketComment).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => view.createTicketComment.mock.calls.length).toBe(1);
    expect((view.createTicketComment.mock.calls[0] as [string, { body: string }])[1].body).toContain("linha um");
  });

  it("o campo de escrever do fim da Atividade continua criando comentário do ticket, sem contributionId", async () => {
    const view = await open();
    await view.screen.getByRole("textbox", { name: "Novo comentário", exact: true }).click();
    await userEvent.keyboard("Do ticket todo");
    await view.screen.getByRole("region", { name: "Atividade" }).getByRole("button", { name: "Comentar" }).click();
    await expect.poll(() => view.createTicketComment.mock.calls.length).toBe(1);
    expect(view.createTicketComment.mock.calls[0]).toEqual(["t1", { body: "Do ticket todo" }]);
  });
});

describe("editar e remover valem nos dois lugares", () => {
  it("editar na conversa muda o texto na seção Atividade", async () => {
    const view = await open([inArea(design, { body: "Antes da edição" })]);
    rowOf("Design").click();
    const conversation = view.screen.getByRole("region", { name: "Conversa da área Design" });
    await conversation.getByRole("button", { name: "Editar" }).click();
    await userEvent.keyboard("{Control>}a{/Control}Depois da edição");
    await conversation.getByRole("button", { name: "Salvar" }).click();
    await expect.poll(() => view.updateComment.mock.calls.length).toBe(1);
    await expect.poll(() => document.querySelector(".ticket-activity .ticket-activity-comment")?.textContent ?? "").toContain("Depois da edição");
    expect(document.querySelector(".ticket-activity .ticket-activity-comment")?.textContent).toContain("editado");
  });

  it("editar na Atividade muda o texto na conversa aberta", async () => {
    const view = await open([inArea(design, { body: "Antes da edição" })]);
    rowOf("Design").click();
    await expect.poll(() => document.querySelectorAll(".ticket-conversation .ticket-activity-comment").length).toBe(1);
    const inActivity = view.screen.getByRole("region", { name: "Atividade" });
    await inActivity.getByRole("button", { name: "Editar" }).click();
    await userEvent.keyboard("{Control>}a{/Control}Texto novo");
    await inActivity.getByRole("button", { name: "Salvar" }).click();
    await expect.poll(() => document.querySelector(".ticket-conversation .ticket-activity-comment")?.textContent ?? "").toContain("Texto novo");
  });

  it("remover na Atividade desconta da contagem e some da conversa", async () => {
    const view = await open([inArea(design, { body: "Primeiro" }), inArea(design, { body: "Segundo", occurredAt: at(1) })]);
    await expect.poll(() => countOf("Design")).toBe("2 comentários");
    rowOf("Design").click();
    const inActivity = view.screen.getByRole("region", { name: "Atividade" });
    await inActivity.getByRole("button", { name: "Remover" }).first().click();
    await inActivity.getByRole("button", { name: /Confirmar/ }).click();
    await expect.poll(() => view.removeComment.mock.calls.length).toBe(1);
    await expect.poll(() => countOf("Design")).toBe("1 comentário");
    await expect.poll(() => document.querySelectorAll(".ticket-conversation .is-removed").length).toBe(1);
  });
});

describe("a etiqueta de área na Atividade", () => {
  it("clicar leva ao bloco da área, abre a conversa e mostra o comentário", async () => {
    await open([inArea(dados, { body: "Sobre os dados" })]);
    await expect.poll(() => document.querySelectorAll(".ticket-activity .ticket-comment-area").length).toBe(1);
    expect(document.querySelector('[aria-label="Dados"] .ticket-conversation')).toBeNull();
    document.querySelector<HTMLElement>(".ticket-activity .ticket-comment-area")!.click();
    await expect.poll(() => document.querySelector('[aria-label="Dados"] .ticket-conversation .ticket-activity-comment')?.textContent ?? "").toContain("Sobre os dados");
    expect(rowOf("Dados").getAttribute("aria-expanded")).toBe("true");
  });
});

describe.skipIf(!dir)("capturas da conferência visual (VITE_TREEPM_CAPTURES)", () => {
  it("bloco com a conversa recolhida e aberta, Atividade com duas áreas, área removida e confirmação com comentários", async () => {
    const seeded = [
      stored({ body: "Vamos alinhar a entrega na sexta.", actor: bruno, occurredAt: at(50) }),
      inArea(design, { body: "A tela de erro precisa de **contraste** maior.", actor: ana, occurredAt: at(40) }),
      inArea(dados, { body: "Falta o dicionário de dados da tabela de acessos.", actor: bruno, occurredAt: at(30) }),
      inArea(design, { body: "Ajustei o contraste; pode revisar?", actor: ana, occurredAt: at(20) }),
      stored({ body: "Conversa que era da área Jurídico.", actor: bruno, area: { id: null, name: "Jurídico" }, occurredAt: at(10) }),
    ];
    const first = await open(seeded);
    await expect.poll(() => document.querySelectorAll(".ticket-activity .ticket-activity-comment").length).toBe(5);
    const designBlock = document.querySelector<HTMLElement>('[aria-label="Design"]')!;
    await page.elementLocator(designBlock).screenshot({ path: `${dir}/1-bloco-conversa-recolhida.png` });
    rowOf("Design").click();
    await expect.poll(() => document.querySelectorAll('[aria-label="Design"] .ticket-conversation .ticket-activity-comment').length).toBe(2);
    await page.elementLocator(designBlock).screenshot({ path: `${dir}/2-bloco-conversa-aberta.png` });
    const activity = document.querySelector<HTMLElement>(".ticket-activity")!;
    activity.scrollIntoView();
    await page.elementLocator(activity).screenshot({ path: `${dir}/3-atividade-com-duas-areas.png` });
    const gone = document.querySelector<HTMLElement>(".ticket-comment-area.is-gone")!.closest<HTMLElement>(".ticket-activity-comment")!;
    await page.elementLocator(gone).screenshot({ path: `${dir}/4-etiqueta-de-area-removida.png` });
    await first.screen.getByRole("button", { name: "Mais ações da área Design" }).click();
    await first.screen.getByRole("button", { name: "Remover área" }).click();
    await page.elementLocator(designBlock).screenshot({ path: `${dir}/5-confirmar-remocao-com-comentarios.png` });
    await page.screenshot({ path: `${dir}/6-pagina-inteira.png` });
  });
});

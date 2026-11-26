import "../theme.css";
import "../styles.css";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import type { ActivityEntry, ApiClient, Contribution, TicketDetail, TicketSummary } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { failed, makeClient, makeProject, makeTicket, ok } from "../test/fakes.js";
import { TicketPage } from "./TicketPage.js";
import { editableFocused } from "../test/stable.js";

// ADR 0041, fatia 1, em navegador real: o texto da área no editor de verdade, e (com TREEPM_CAPTURES) as capturas da conferência visual.
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const summaries: TicketSummary[] = [makeTicket("t1", "p1", 1, "Tela de acesso por token", { key: "ALFA-1" }), makeTicket("t2", "p1", 2, "Cadastro de áreas", { key: "ALFA-2" })];
const ana = { id: "person-1", displayName: "Ana Souza", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno Lima", avatarUrl: null };
const design: Contribution = { id: "k1", area: { id: "a1", name: "Design" }, text: "## Entrega\n\n- Telas de **login** e de erro\n- Ver ALFA-2 para o cadastro\n\n- [ ] Revisar contraste", status: "in_progress", people: [ana, bruno], commentCount: 0 };
const dados: Contribution = { id: "k2", area: { id: "a2", name: "Dados" }, text: "", status: "todo", people: [], commentCount: 0 };
const areas = [{ id: "a1", name: "Design" }, { id: "a2", name: "Dados" }, { id: "a3", name: "Jurídico" }, { id: "a4", name: "Segurança" }];
const dir = (import.meta.env["VITE_TREEPM_CAPTURES"] as string | undefined);
const shot = async (name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

async function open(options: { contributions?: Contribution[]; reader?: boolean; areas?: typeof areas; activity?: ActivityEntry[]; updateFails?: boolean } = {}) {
  await page.viewport(1100, 1500);
  const client = makeClient({ projects: [project], people: [ana, bruno].map((p) => makePerson(p.id, p.displayName)), tickets: { p1: summaries }, areas: options.areas ?? areas });
  const current = { list: options.contributions ?? [design, dados] };
  const detail = (): TicketDetail => ({
    ...summaries[0]!, description: "Fluxo de acesso com token por projeto.", mentionedBy: [], dependsOn: [], blocks: [], related: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    contributions: current.list, canEditContributions: !options.reader,
  });
  const update = vi.fn(async (id: string, body: { text?: string; status?: Contribution["status"] }) => {
    if (options.updateFails) return failed("unavailable");
    current.list = current.list.map((c) => (c.id === id ? { ...c, ...body } : c));
    return ok(current.list.find((c) => c.id === id)!);
  });
  Object.assign(client, {
    getTicket: vi.fn(async () => ok(detail())),
    ticketActivity: vi.fn(async () => ok({ entries: options.activity ?? [], before: null, canComment: false })),
    updateContribution: update,
    createContribution: vi.fn(async () => failed("unavailable")),
    removeContribution: vi.fn(async () => ok(null)),
    putContributionPerson: vi.fn(async () => failed("unavailable")),
    removeContributionPerson: vi.fn(async () => ok(null)),
  });
  const handlers = { onOpenTicket: vi.fn(), onClose: vi.fn(), onChanged: vi.fn(), onRemoved: vi.fn(), onStartCreate: vi.fn(), onCancelCreate: vi.fn(), onCreated: vi.fn() };
  const screen = await render(
    <div style={{ position: "relative", height: "1500px" }}>
      <TicketPage client={client as ApiClient} me={makePanelMe(options.reader ? "member" : "admin")} projects={[project]} ticketId="t1" creating={null} {...handlers} />
    </div>,
  );
  await expect.element(screen.getByRole("region", { name: "Áreas" })).toBeVisible();
  return { screen, update };
}

describe("o texto da área no editor de verdade", () => {
  it("clicar no convite, digitar e sair do campo salva o markdown escrito", async () => {
    const { screen, update } = await open();
    await screen.getByRole("button", { name: "Descreva o que esta área precisa entregar" }).click();
    await editableFocused();
    await userEvent.keyboard("Entregar **tudo** até ALFA-2");
    await screen.getByRole("heading", { name: "Áreas" }).click();
    await expect.poll(() => update.mock.calls.length).toBe(1);
    expect(update.mock.calls[0]).toEqual(["k2", { text: "Entregar **tudo** até ALFA-2" }]);
  });

  it("uma falha de salvar mostra o erro no bloco e o texto digitado continua no campo", async () => {
    const { screen, update } = await open({ updateFails: true });
    await screen.getByRole("button", { name: "Descreva o que esta área precisa entregar" }).click();
    await editableFocused();
    await userEvent.keyboard("texto que não pode se perder");
    await screen.getByRole("heading", { name: "Áreas" }).click();
    await expect.poll(() => update.mock.calls.length).toBe(1);
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(document.querySelector('[aria-label="Dados"] .tiptap')?.textContent ?? "").toContain("texto que não pode se perder");
  });

  it("o texto de quem só lê não é editável e a tarefa não se marca", async () => {
    const { screen } = await open({ reader: true });
    await expect.element(screen.getByRole("group", { name: "Design" })).toBeVisible();
    expect(document.querySelector(".ticket-contribution .tiptap[contenteditable='true']")).toBeNull();
  });
});

describe.skipIf(!dir)("capturas da conferência visual (VITE_TREEPM_CAPTURES)", () => {
  it("página inteira com duas áreas, bloco completo, menus, confirmação, leitor, sem áreas e atividade", async () => {
    const area = { id: "a1", name: "Design" };
    const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const activity: ActivityEntry[] = [
      { id: "e6", type: "contribution_person_removed", occurredAt: at(2), actor: ana, area, person: bruno },
      { id: "e5", type: "contribution_person_added", occurredAt: at(4), actor: ana, area, person: bruno },
      { id: "e4", type: "contribution_status_changed", occurredAt: at(6), actor: ana, area, from: "todo", to: "in_progress" },
      { id: "e3", type: "contribution_text_changed", occurredAt: at(8), actor: ana, area },
      { id: "e2", type: "contribution_removed", occurredAt: at(10), actor: ana, area: { id: "a9", name: "Jurídico" } },
      { id: "e1", type: "contribution_added", occurredAt: at(12), actor: ana, area },
    ];
    const first = await open({ activity });
    await expect.element(first.screen.getByRole("group", { name: "Design" })).toBeVisible();
    await shot("1-pagina-com-duas-areas");
    const block = document.querySelector<HTMLElement>(".ticket-contribution")!;
    await page.elementLocator(block).screenshot({ path: `${dir}/2-bloco-completo.png` });
    document.querySelector(".ticket-activity")!.scrollIntoView();
    await page.elementLocator(document.querySelector<HTMLElement>(".ticket-activity")!).screenshot({ path: `${dir}/7-atividade.png` });
    await first.screen.getByRole("button", { name: "Adicionar área" }).click();
    await shot("3-menu-adicionar-area");
    await userEvent.keyboard("{Escape}");
    await first.screen.getByRole("group", { name: "Dados" }).getByRole("button", { name: /A fazer/ }).click();
    await shot("4-menu-situacao");
    await userEvent.keyboard("{Escape}");
    await first.screen.getByRole("button", { name: "Mais ações da área Design" }).click();
    await first.screen.getByRole("button", { name: "Remover área" }).click();
    await shot("5-confirmar-remocao");
  });

  it("leitor e organização sem áreas", async () => {
    const reader = await open({ reader: true });
    await expect.element(reader.screen.getByRole("group", { name: "Design" })).toBeVisible();
    await shot("6-visao-do-leitor");
    reader.screen.unmount();
    const none = await open({ contributions: [], areas: [] });
    await expect.element(none.screen.getByText(/Nenhuma área cadastrada/)).toBeVisible();
    await shot("8-organizacao-sem-areas");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../command/command.css";
import type { ApiClient, PlacementOutcome } from "../api/client.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";
import { RecentPlacesProvider } from "./RecentPlacesContext.js";
import { createRecentPlaces } from "./recentPlaces.js";

// A pergunta sobre o lugar (ADR 0054, adendo) em navegador real: teclado, alvos de toque e largura de celular.
// As capturas de conferência visual só saem com VITE_TREEPM_CAPTURES=1: os PNGs ficam em .vitest/cap (fora do Git) e quem roda os move.
const ON = import.meta.env["VITE_TREEPM_CAPTURES"] === "1";
const shot = async (name: string, size: string) => {
  if (ON) await page.screenshot({ path: `../../.vitest/cap/${name}-${size}.png`, save: true });
};
const SIZES = [{ size: "1440x900", width: 1440, height: 900 }, { size: "390x844", width: 390, height: 844 }];

const project = makeProject("p1", "TREEPM", "TreePM");
const list = [
  makeTicket("t1", "p1", 1, "Armazenamento de arquivos", { key: "TREEPM-1", progress: { done: 0, total: 2, excluded: 0 } }),
  makeTicket("t2", "p1", 2, "Remover o bucket do S3", { key: "TREEPM-2", parentId: "t1", progress: { done: 0, total: 1, excluded: 0 } }),
  makeTicket("t3", "p1", 3, "Modificar o storage do campo de nome", { key: "TREEPM-3", parentId: "t2" }),
  makeTicket("t4", "p1", 4, "Cobrança e planos", { key: "TREEPM-4", progress: { done: 0, total: 1, excluded: 0 } }),
  makeTicket("t5", "p1", 5, "Emitir nota fiscal", { key: "TREEPM-5", parentId: "t4" }),
  makeTicket("t6", "p1", 6, "Acesso e identidade", { key: "TREEPM-6", progress: { done: 0, total: 1, excluded: 0 } }),
  makeTicket("t7", "p1", 7, "Login com SSO", { key: "TREEPM-7", parentId: "t6" }),
];
const byId = (id: string) => list.find((entry) => entry.id === id)!;
const pathOf = (id: string): { id: string; title: string }[] => {
  const chain: { id: string; title: string }[] = [];
  for (let at: (typeof list)[number] | undefined = byId(id); at; at = at.parentId === null ? undefined : byId(at.parentId)) chain.unshift({ id: at.id, title: at.title });
  return chain;
};
const option = (id: string) => ({ id, title: byId(id).title, path: pathOf(id) });
const question = (at: string | null, options: string[]): PlacementOutcome =>
  makePlacement({
    question: { level: at === null ? 1 : pathOf(at).length + 1, kind: "which", at: { id: at, title: at === null ? "TreePM" : byId(at).title, path: at === null ? [] : pathOf(at) }, options: options.map(option) },
    destinationConfirmed: false,
    uncertain: true,
    destination: { parentId: options[0] ?? null, path: options[0] ? pathOf(options[0]) : [] },
  });

function clientWith(placements: PlacementOutcome[]): ApiClient {
  const client = makeClient({ projects: [project] });
  const findPlacement = vi.fn();
  for (const placement of placements) findPlacement.mockResolvedValueOnce(ok(placement));
  findPlacement.mockResolvedValue(ok(placements.at(-1)!));
  const conversation = makeConversation("c1", "p1", { draft: { title: "Migrar o armazenamento do campo de nome", description: "Tirar o campo do S3 e guardar no banco." } });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    getConversationPreview: vi.fn(async () => ok({ title: conversation.draft!.title, description: conversation.draft!.description, quote: "", children: [], idea: false, unknownKeys: [], descriptionTooLong: false })),
    findPlacement,
  });
  return client;
}

const ORG = "org-question";
const PERSON = "person-question";

async function mount(client: ApiClient) {
  const recents = createRecentPlaces(ORG, PERSON);
  for (const id of ["t7", "t5"]) recents.record("p1", id);
  return render(
    <RecentPlacesProvider value={recents}>
      <main className="tenant-map" style={{ position: "fixed", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12px 0" }}>
        <div className="command-bar is-open">
          <AssistantPanel client={client} projects={[project]} initialProjectId="p1" tickets={{ p1: list }} expanded resume
            onCollapse={() => undefined} onProgress={() => undefined} onCreated={() => undefined} onManualCreate={() => undefined} onDraftChange={() => undefined} onChanged={() => undefined} registerPicker={() => undefined} />
        </div>
      </main>
    </RecentPlacesProvider>,
  );
}
const noHorizontalOverflow = () => {
  const scroll = document.querySelector<HTMLElement>(".assistant-scroll")!;
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
};
const card = () => document.querySelector<HTMLElement>(".assistant-card.is-path")!;
/** Leva o foco ao botão de procurar e aperta Enter: o caminho da pessoa que só usa o teclado. */
const searchByKeyboard = async (screen: Awaited<ReturnType<typeof mount>>) => {
  const button = screen.getByRole("button", { name: "Procurar o lugar" });
  await expect.element(button).toBeVisible();
  (button.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
};

/**
 * Os lugares recentes ficam no `localStorage`, que todos os arquivos desta suíte compartilham (mesma origem, e o Chromium vive entre as
 * rodadas). Os testes do mapa registram recentes com a organização e a pessoa padrão e não limpam; por isso este arquivo usa uma
 * organização e uma pessoa só dele e limpa só a própria chave, em vez de contar com o que sobrou lá ou apagar o que é dos outros.
 */
const clearOwnRecents = () => window.localStorage.removeItem(`treepm.recent.${ORG}.p1.${PERSON}`);
beforeEach(clearOwnRecents);
afterEach(clearOwnRecents);

describe("a pergunta sobre o lugar em navegador real", () => {
  for (const { size, width, height } of SIZES) {
    it(`pergunta na raiz, com lugares recentes (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(clientWith([question(null, ["t1", "t4", "t6"])]));
      await searchByKeyboard(screen);
      await expect.element(screen.getByRole("heading", { name: "Onde isto entra?" })).toBeVisible();
      await expect.element(screen.getByRole("list", { name: "Lugares recentes" })).toBeVisible();
      // Medidas de layout só valem depois de o cartão assentar (a barra de rolagem aparece quando o cartão cresce): esperam, não adivinham.
      const choices = () => [...card().querySelectorAll<HTMLButtonElement>("button.assistant-choice")];
      await expect.poll(() => choices().length).toBe(7);
      await expect.poll(() => new Set(choices().map((button) => Math.round(button.getBoundingClientRect().width))).size).toBe(1);
      if (width < 720) await expect.poll(() => Math.min(...choices().map((button) => button.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);
      await expect.poll(() => { const scroll = document.querySelector<HTMLElement>(".assistant-scroll")!; return scroll.scrollWidth - scroll.clientWidth; }).toBeLessThanOrEqual(1);
      await shot("pergunta-na-raiz-com-recentes", size);
    });

    it(`pergunta mais funda depois de uma resposta (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(clientWith([question(null, ["t1", "t4", "t6"]), question("t1", ["t2"])]));
      await searchByKeyboard(screen);
      await expect.element(screen.getByRole("heading", { name: "Onde isto entra?" })).toBeVisible();
      await screen.getByRole("button", { name: /^Armazenamento de arquivos/ }).click();
      await expect.element(screen.getByText("Dúvida em: Armazenamento de arquivos")).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Fica aqui, em «Armazenamento de arquivos»" })).toBeVisible();
      noHorizontalOverflow();
      await shot("pergunta-mais-funda", size);
    });

    it(`teto de três respostas (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(clientWith([question(null, ["t1", "t4"]), question("t1", ["t2"]), question("t2", ["t3"]), question("t3", ["t3"])]));
      await searchByKeyboard(screen);
      await screen.getByRole("button", { name: /^Armazenamento de arquivos/ }).click();
      await screen.getByRole("button", { name: /^Remover o bucket do S3/ }).click();
      await screen.getByRole("button", { name: /^Modificar o storage do campo de nome/ }).click();
      await expect.element(screen.getByText(/Já perguntei três vezes/)).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Criar aqui" })).toBeEnabled();
      noHorizontalOverflow();
      await shot("teto-de-tres", size);
    });
  }

  it("só com o teclado: o foco vai à pergunta, Tab percorre as opções na ordem e Enter responde", async () => {
    await page.viewport(1440, 900);
    const screen = await mount(clientWith([question(null, ["t1", "t4"]), question("t1", ["t2"])]));
    await searchByKeyboard(screen);
    await expect.element(screen.getByRole("heading", { name: "Onde isto entra?" })).toHaveFocus();
    const order = ["Armazenamento de arquivos", "Cobrança e planos", "Deixar solto no projeto", "Emitir nota fiscal", "Login com SSO", "Nenhum destes: escolher no mapa"];
    for (const name of order) {
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement?.textContent ?? "").toContain(name);
    }
    // O foco é visível: contorno do navegador ou do tema, nunca `outline: none` sem substituto.
    const outline = getComputedStyle(document.activeElement as HTMLElement);
    expect(outline.outlineStyle !== "none" || outline.boxShadow !== "none").toBe(true);
    await userEvent.keyboard("{Shift>}{Tab}{Tab}{Tab}{Tab}{Tab}{/Shift}");
    expect(document.activeElement?.textContent ?? "").toContain("Armazenamento de arquivos");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("Dúvida em: Armazenamento de arquivos")).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "Onde isto entra?" })).toHaveFocus();
    // Enquanto há pergunta, "Criar aqui" nem aparece (revisão 1).
    expect(document.querySelector("[data-assistant-create]")).toBeNull();
  });
});

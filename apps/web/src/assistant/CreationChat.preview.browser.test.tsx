import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../command/command.css";
import type { ApiClient, DraftPreview } from "../api/client.js";
import { makeClient, makeConversation, makeProject, makeTicket, ok } from "../test/fakes.js";
import { ChatHarness } from "../test/mountChat.js";

// ADR 0044, fatia 2, em navegador real: a folha da conversa com a citação, o pai e os filhos, o esqueleto e o aviso.
// As capturas de conferência visual só saem com VITE_TREEPM_CAPTURES definida (a pasta de destino).
const dir = import.meta.env["VITE_TREEPM_CAPTURES"] as string | undefined;
const shot = async (name: string, size: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}-${size}.png` });
};
const SIZES = [{ size: "1440x900", width: 1440, height: 900 }, { size: "390x844", width: 390, height: 844 }];

const project = makeProject("p1", "TREEPM", "TreePM");
const QUOTE = "Pedido original:\n\n> quero que a gente tenha uma interface tipo chat do slack no painel lateral esquerdo. quando uma pessoa tem um ticket um chat fica disponível pra ela trabalhar nele.\n>\n> quebre a tarefa que eu vou pedir o design dela.";
const TITLES = [
  "Painel lateral esquerdo com chat no estilo do Slack, disponível para quem tem o ticket",
  "Um chat por pessoa em cada ticket, cada um com o próprio contexto",
  "Conversa ligada ao repositório do ticket, criando uma branch quando a tarefa envolve código",
  "O chat age como harness: executa o trabalho a partir da conversa",
  "Modelos de divisão de trabalho, prontos ou personalizados",
  "Conectar outros provedores de IA",
  "Consumo de tokens em fluxo (stream-json), por CLI ou por API",
  "Mencionar uma pessoa abre para ela um chat do ticket só com aquela mensagem, em thread",
  "Menção a quem já trabalha no ticket: aparece no fluxo dela, com a origem explícita, e numa aba dedicada",
];
const children = TITLES.map((title) => ({ title, description: `O que a pessoa disse sobre esta parte, com as palavras dela.\n\n## A definir\n\n- Como isso convive com a página do ticket?` }));

function makeClientWith(options: { children?: typeof children; unknownKeys?: string[]; slow?: boolean }): ApiClient {
  const kids = options.children ?? [];
  const preview: DraftPreview = { title: "Chat de trabalho por ticket", description: `${QUOTE}\n\nO pedido descreve uma funcionalidade com várias partes.`, quote: QUOTE, children: kids, idea: false, unknownKeys: options.unknownKeys ?? [], descriptionTooLong: false };
  const client = makeClient({ projects: [project] });
  const conversation = makeConversation("c1", "p1", { draft: { title: "Chat de trabalho por ticket no painel lateral", description: "O pedido descreve uma funcionalidade com várias partes.", children: kids } });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok(options.slow ? [] : [{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    openConversation: vi.fn(() => new Promise(() => undefined)),
    getConversationPreview: vi.fn(async () => ok(preview)),
  });
  return client;
}

async function mount(client: ApiClient, resume: boolean) {
  return render(
    <main className="tenant-map" style={{ position: "fixed", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12px 0" }}>
      <div className="command-bar is-open">
        <ChatHarness client={client} projects={[project]} initialProjectId="p1" tickets={{ p1: [makeTicket("t1", "p1", 1, "Design da plataforma", { key: "TREEPM-12" })] }} resume={resume}
          onCreated={() => undefined} onManualCreate={() => undefined} onDraftChange={() => undefined} onChanged={() => undefined} registerPicker={() => undefined} />
      </div>
    </main>,
  );
}
const noHorizontalOverflow = (scroll: HTMLElement) => expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);

describe("a prévia da quebra em navegador real", () => {
  for (const { size, width, height } of SIZES) {
    it(`um ticket só, com a citação (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(makeClientWith({}), true);
      const quote = screen.getByRole("region", { name: "Pedido original" });
      await expect.element(quote).toBeVisible();
      await expect.element(screen.getByText(/quero que a gente tenha uma interface/)).toBeVisible();
      noHorizontalOverflow(document.querySelector<HTMLElement>(".assistant-scroll")!);
      await shot("um-ticket-com-citacao", size);
    });

    it(`um pai e nove filhos (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(makeClientWith({ children }), true);
      await expect.element(screen.getByText("9 partes")).toBeVisible();
      const list = screen.getByRole("list", { name: "Partes do ticket" });
      await expect.element(list).toBeVisible();
      noHorizontalOverflow(document.querySelector<HTMLElement>(".assistant-scroll")!);
      const first = screen.getByRole("textbox", { name: "Título da parte 1" });
      expect(first.element().getBoundingClientRect().width).toBeGreaterThan(120);
      // Os controles de subir, descer e tirar são alcançáveis pelo teclado e, na tela estreita, têm alvo de 44 px.
      const down = screen.getByRole("button", { name: `Descer «${TITLES[0]}»` });
      const box = down.element().getBoundingClientRect();
      if (width < 720) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
      await userEvent.keyboard("{Tab}");
      await down.click();
      await expect.element(screen.getByRole("textbox", { name: "Título da parte 2" })).toHaveValue(TITLES[0]!);
      await shot("pai-e-nove-filhos", size);
    });

    it(`o aviso de chave que não existe (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(makeClientWith({ children: children.slice(0, 2), unknownKeys: ["TREEPM-777"] }), true);
      await expect.element(screen.getByText(/não existem: TREEPM-777/)).toBeVisible();
      await shot("aviso-chave-inexistente", size);
    });

    it(`o esqueleto de carregamento brilha, e para com movimento reduzido (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount(makeClientWith({ slow: true }), false);
      const field = screen.getByRole("textbox", { name: "Mensagem para o assistente" });
      await field.click();
      await userEvent.keyboard("quero um chat no painel{Enter}");
      await expect.element(screen.getByText("quero um chat no painel")).toBeVisible();
      const bar = document.querySelector<HTMLElement>(".assistant-skeleton span")!;
      expect(getComputedStyle(bar).animationName).toBe("assistant-shimmer");
      expect(bar.getBoundingClientRect().height).toBeGreaterThan(4);
      await shot("esqueleto", size);
    });
  }
});

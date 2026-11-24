import { afterEach, describe, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { settle } from "../layout/layoutMeasure.js";
import { mountConversations, rowOf, rows, seedDeep } from "./conversationHarness.js";

// Capturas da conferência visual da árvore de conversas (ADR 0055, fatia 2): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em .vitest/cap
// (fora do Git) e quem roda os move para fora do repositório. O app só tem tema escuro; não há captura em tema claro.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const open = async (row: HTMLElement) => { row.click(); await settle(900); };
const seedTree = (chat: Parameters<NonNullable<Parameters<typeof mountConversations>[0]>["seed"] & {}>[0]) => {
  chat.seedGeneral([{ person: "O que tenho para hoje?", assistant: "Você é responsável pelo ALFA-1." }]);
  seedDeep(chat, 6);
};

describe.skipIf(!ON)("capturas da árvore de conversas", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await page.viewport(1440, 900);
  });

  it("dono: árvore profunda, conversa com o cartão da thread, thread aberta e aviso no compositor", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: seedTree });
    await settle(1200);
    await shot("dono-01-arvore-na-barra");
    await open(rowOf("ALFA-1"));
    await shot("dono-02-conversa-com-cartao-da-thread");
    q<HTMLButtonElement>(".chat-panel .chat-thread-footer")!.click();
    await settle(900);
    await shot("dono-03-thread-aberta-com-trilha");
    await userEvent.type(page.getByRole("combobox", { name: "Responder na thread" }), "@");
    await settle(300);
    await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: "Duda" }).click();
    await userEvent.fill(page.getByRole("combobox", { name: "Responder na thread" }), "Caio, consegue olhar?");
    await settle(400);
    await shot("dono-04-compositor-com-aviso-de-thread");
    await open(rows().at(-1)!);
    await shot("dono-05-ultimo-nivel");
  });

  it("chat geral", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: seedTree });
    await settle(1200);
    await open(rows()[0]!);
    await shot("geral-01-chat-geral");
  });

  it("participante da thread", async () => {
    await page.viewport(1440, 900);
    await mountConversations({ as: "person-2", seed: seedTree });
    await settle(1200);
    await shot("participante-01-arvore-na-barra");
    await open(rows().find((row) => row.classList.contains("is-thread"))!);
    await shot("participante-02-thread-aberta");
  });

  it("convidado: só a thread dele sob o ticket", async () => {
    await page.viewport(1440, 900);
    await mountConversations({
      as: "person-3",
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "segredo do dono", assistant: "resposta secreta" }]);
        const first = chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        chat.openThreadIn(first, { from: "person-2", body: "Caio, e você?", to: ["person-3"], replies: [{ from: "person-2", body: "Já viu o relatório?" }] });
      },
    });
    await settle(1200);
    await shot("convidado-01-arvore-na-barra");
    await open(rows().find((row) => row.classList.contains("is-thread"))!);
    await shot("convidado-02-thread-aberta");
  });
});

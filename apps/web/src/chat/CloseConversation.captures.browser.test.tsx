import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { settle } from "../layout/layoutMeasure.js";
import { mountConversations, rowOf, rows, seedDeep } from "./conversationHarness.js";

// Capturas da conferência visual de fechar conversa e da thread que nasce (ADR 0059): só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em .vitest/cap
// (fora do Git) e quem roda os move para fora do repositório. O app só tem tema escuro.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";
const shot = (name: string) => page.screenshot({ path: `../../.vitest/cap/${name}.png`, save: true });
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const poll = <T,>(read: () => T) => expect.poll(read, { timeout: 5000, interval: 100 });

describe.skipIf(!ON)("capturas de fechar conversa e da thread que nasce", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await page.viewport(1440, 900);
  });
  const start = async () => {
    await page.viewport(1440, 900);
    await mountConversations({ seed: (chat) => { chat.seedGeneral([{ person: "oi", assistant: "olá" }]); seedDeep(chat, 2); } });
    await poll(() => rows().length).toBeGreaterThanOrEqual(4);
    await settle(600);
  };
  const write = async (placeholder: string, mention: string | null) => {
    await userEvent.click(page.getByRole("combobox", { name: placeholder }));
    if (mention !== null) {
      await userEvent.keyboard("@");
      await page.getByRole("listbox", { name: "Pessoas" }).getByRole("option", { name: mention }).click();
    }
    await userEvent.keyboard("pode olhar isto?");
    await settle(400);
  };

  it("a lista: linha com o ×, aviso com Desfazer e Fechadas aberta", async () => {
    await start();
    const leaf = rows().at(-1)!;
    await userEvent.hover(leaf);
    await settle(300);
    await shot("01-linha-com-o-x");
    leaf.closest(".conv-line")!.querySelector<HTMLButtonElement>(".conv-close")!.click();
    await poll(() => q(".conv-toast")).not.toBeNull();
    await userEvent.unhover(document.body);
    await settle(300);
    await shot("02-aviso-com-desfazer");
    q<HTMLButtonElement>(".conv-closed-toggle")!.click();
    await settle(400);
    await shot("03-fechadas-aberta");
  });

  it("o campo: thread nascendo sem e com quem já estava, e marcando só quem já participa", async () => {
    await start();
    rowOf("ALFA-1").click();
    await settle(900);
    await write("Mensagem", "Bia Nogueira");
    await shot("04-campo-thread-nascendo-sem-quem-ja-estava");
    document.body.replaceChildren();
    await start();
    rows().at(-1)!.click();
    await settle(900);
    await write("Responder na thread", "Duda");
    await shot("05-campo-thread-nascendo-com-quem-ja-estava");
    document.body.replaceChildren();
    await start();
    rows().at(-1)!.click();
    await settle(900);
    await write("Responder na thread", "Bia Nogueira");
    await shot("06-campo-marcando-so-quem-ja-participa");
  });

  it("dois fechamentos seguidos (aviso no plural) e o último nível (@ aberto, quem é de fora apagado)", async () => {
    await page.viewport(1440, 900);
    await mountConversations({
      seed: (chat) => {
        const main = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        chat.openThreadIn(main, { from: "person-1", body: "Bia, olha", to: ["person-2"] });
        chat.openThreadIn(main, { from: "person-1", body: "Caio, olha", to: ["person-3"] });
        chat.readAll();
      },
    });
    await poll(() => rows().length).toBeGreaterThanOrEqual(4);
    await settle(600);
    for (const row of rows().filter((candidate) => /^Thread com/.test(candidate.textContent ?? ""))) {
      row.closest(".conv-line")!.querySelector<HTMLButtonElement>(".conv-close")!.click();
      await settle(300);
    }
    await poll(() => q(".conv-toast")?.textContent ?? "").toContain("2 conversas fechadas.");
    await shot("07-dois-fechamentos");
    document.body.replaceChildren();
    await page.viewport(1440, 900);
    await mountConversations({
      seed: (chat) => {
        let parent = chat.seedConversation("t1", [{ person: "oi", assistant: "olá" }]);
        for (let depth = 1; depth <= 9; depth += 1) parent = chat.openThreadIn(parent, { from: "person-1", body: `Nível ${depth}`, to: ["person-2"] });
        chat.readAll();
      },
    });
    await poll(() => rows().length).toBeGreaterThanOrEqual(5);
    await settle(600);
    rows().at(-1)!.click();
    await settle(900);
    await userEvent.click(page.getByRole("combobox", { name: "Responder na thread" }));
    await userEvent.keyboard("@");
    await poll(() => q(".mention-list")).not.toBeNull();
    await settle(400);
    await shot("08-ultimo-nivel");
  });
});

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../theme.css";
import "../../map/status-mark.css";
import { makeTicket } from "../../test/fakes.js";
import { RichDescription } from "./RichDescription.js";

const tickets = [makeTicket("t47", "p1", 47, "Adicionar opção para exportar sem cabeçalho", { key: "TREEPM-47", status: "in_progress" })];

const show = async (value: string, editing: boolean, onChange = vi.fn()) => {
  const screen = await render(
    <div style={{ width: 300, font: "14px sans-serif" }}>
      <RichDescription value={value} editing={editing} canEdit label="Descrição" placeholder="" mentions={{ projectId: "p1", tickets }} onChange={onChange} onOpenMention={vi.fn()} />
    </div>,
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  return screen;
};

describe("mention as a single label", () => {
  const cases = [false, true].flatMap((editing) => [0, 4, 8, 12, 16, 20, 24, 28, 32].map((filler) => [editing, filler] as const));
  it.each(cases)("never breaks in the middle, wherever the line ends (editing: %s, filler: %s)", async (editing, filler) => {
    await show(`${"x".repeat(filler)} Ver TREEPM-47 agora`, editing);
    const mention = document.querySelector(".description-mention") as HTMLElement;
    expect(mention).not.toBeNull();
    // Uma peça só: um único retângulo de linha, mesmo quando a etiqueta cai no fim da linha.
    expect(mention.getClientRects()).toHaveLength(1);
    const key = mention.getBoundingClientRect();
    expect(key.height).toBeLessThan(30);
  });

  it("pushes the whole label to the next line when it does not fit", async () => {
    await show(`${"x".repeat(24)} Ver TREEPM-47 agora`, false);
    const mention = document.querySelector(".description-mention") as HTMLElement;
    const paragraph = document.querySelector(".tiptap p") as HTMLElement;
    expect(mention.getBoundingClientRect().top - paragraph.getBoundingClientRect().top).toBeGreaterThan(10);
    expect(mention.getClientRects()).toHaveLength(1);
  });

  it("keeps the situation mark, the key and the title on one line, with one continuous background", async () => {
    await show("Depende de TREEPM-47", false);
    const mention = document.querySelector(".description-mention") as HTMLElement;
    const key = mention.getBoundingClientRect();
    const before = getComputedStyle(mention, "::before");
    const after = getComputedStyle(mention, "::after");
    expect(key.height).toBeLessThan(30);
    expect(before.content).not.toBe("none");
    expect(after.content).toContain("Adicionar opção");
    expect(getComputedStyle(mention).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});

describe("links", () => {
  const seen = () => {
    const events: { href: string; prevented: boolean }[] = [];
    // Registra e impede a navegação de verdade, para o teste não abrir aba.
    document.addEventListener("click", (event) => {
      const link = (event.target as Element).closest("a");
      if (link) {
        events.push({ href: link.href, prevented: event.defaultPrevented });
        event.preventDefault();
      }
    });
    return events;
  };

  it("clicking a link while reading opens its address (the browser follows it)", async () => {
    const events = seen();
    const screen = await show("[site](https://a.com/x)", false);
    await screen.getByRole("link", { name: "site" }).click();
    expect(events).toEqual([{ href: "https://a.com/x", prevented: false }]);
  });

  it("clicking a link while editing puts the caret there and does not navigate", async () => {
    const open = vi.spyOn(window, "open");
    await show("[site](https://a.com/x)", true);
    const link = document.querySelector("a")!;
    await userEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    expect(link.closest("[contenteditable=true]")).not.toBeNull();
    expect(link.contains(window.getSelection()!.anchorNode)).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)"])("%s is never a link, while reading or after editing", async (href) => {
    const onChange = vi.fn();
    await show(`[x](${href}) fim`, true, onChange);
    const bad = () => Array.from(document.querySelectorAll("a")).filter((a) => /^(javascript|data|vbscript):/i.test(a.getAttribute("href") ?? ""));
    expect(bad()).toEqual([]);
    await userEvent.click(document.querySelector(".tiptap") as HTMLElement);
    await userEvent.keyboard("{Control>}{End}{/Control}!");
    expect(onChange).toHaveBeenCalled();
    expect(bad()).toEqual([]);
  });
});

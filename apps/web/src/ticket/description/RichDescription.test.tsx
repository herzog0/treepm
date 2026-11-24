import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeTicket } from "../../test/fakes.js";
import { RichDescription } from "./RichDescription.js";
import type { RichDescriptionProps } from "./RichDescription.js";

const tickets = [
  makeTicket("t47", "p1", 47, "Adicionar opção de exportar", { key: "TREEPM-47", status: "in_progress" }),
  makeTicket("x9", "p2", 9, "De outro projeto", { key: "OUTRO-9" }),
];

const show = (props: Partial<RichDescriptionProps> & { value: string }) => {
  const callbacks = { onChange: vi.fn(), onToggleTask: vi.fn(), onOpenMention: vi.fn(), onRequestEdit: vi.fn() };
  const view = render(
    <RichDescription editing={false} canEdit label="Descrição" placeholder="" mentions={{ projectId: "p1", tickets, ownId: "t1" }} {...callbacks} {...props} />,
  );
  return { ...callbacks, ...view };
};

describe("RichDescription reading", () => {
  it("reads the subset of markdown: headings, lists, tasks, quote, code and marks", () => {
    const { container } = show({ value: "# Título\n\n## Sub\n\n- a\n- b\n\n1. um\n2. dois\n\n- [ ] fazer\n- [x] feito\n\n> citação\n\n```\nbloco\n```\n\nUse `código`, **negrito**, *itálico* e [link](https://x.com)." });
    expect(within(container).getByRole("heading", { level: 1, name: "Título" })).toBeInTheDocument();
    expect(within(container).getByRole("heading", { level: 2, name: "Sub" })).toBeInTheDocument();
    expect(container.querySelectorAll("ul:not([data-type]) > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelectorAll('ul[data-type="taskList"] > li')).toHaveLength(2);
    expect(container.querySelector("blockquote")).toHaveTextContent("citação");
    expect(container.querySelector("pre code")).toHaveTextContent("bloco");
    expect(container.querySelector("code:not(pre code)")).toHaveTextContent("código");
    expect(container.querySelector("strong")).toHaveTextContent("negrito");
    expect(container.querySelector("em")).toHaveTextContent("itálico");
    expect(container.querySelector("a")).toHaveAttribute("href", "https://x.com");
  });

  it("keeps a single line break as a line break", () => {
    const { container } = show({ value: "linha um\nlinha dois" });
    const paragraphs = container.querySelectorAll(".tiptap p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.textContent).toBe("linha um\nlinha dois");
  });

  it("shows HTML, images and tables as text, never as elements", () => {
    const { container } = show({ value: "<b>negrito?</b> <script>x</script> ![img](a.png)\n\n| a | b |\n|---|---|" });
    expect(container.querySelector("b, script, img, table")).toBeNull();
    expect(container).toHaveTextContent("<b>negrito?</b> <script>x</script> ![img](a.png)");
  });

  it("never rewrites the text when the person did not edit", () => {
    const { onChange, onToggleTask } = show({ value: "Critérios de aceite:\n- um\n- dois" });
    expect(onChange).not.toHaveBeenCalled();
    expect(onToggleTask).not.toHaveBeenCalled();
  });
});

describe("RichDescription mentions", () => {
  it("shows a key of a ticket of the same project as a link with the situation, the key and the current title", () => {
    const { container, onOpenMention } = show({ value: "Veja TREEPM-47 depois." });
    const link = screen.getByRole("link", { name: "TREEPM-47 Adicionar opção de exportar, Em andamento" });
    expect(link).toHaveTextContent("TREEPM-47");
    // Uma peça só: a própria etiqueta leva a situação e o título (desenhados pelo CSS), sem pedaços soltos ao lado.
    const mention = container.querySelector(".description-mention")!;
    expect(mention).toHaveAttribute("data-state", "in_progress");
    expect(mention).toHaveAttribute("data-title", "Adicionar opção de exportar");
    expect(container.querySelector(".description-mention-mark, .description-mention-title")).toBeNull();
    fireEvent.click(link);
    expect(onOpenMention).toHaveBeenCalledWith("t47");
  });

  it("shortens a long title by characters and keeps the full title in the accessible name", () => {
    const long = "Um título muito comprido que não cabe numa etiqueta de menção sem ser cortado";
    const { container } = show({ value: "TREEPM-47", mentions: { projectId: "p1", tickets: [{ ...tickets[0]!, title: long }] } });
    const mention = container.querySelector(".description-mention")!;
    expect(mention.getAttribute("data-title")!.endsWith("…")).toBe(true);
    expect(mention.getAttribute("data-title")!.length).toBeLessThan(long.length);
    expect(mention.getAttribute("aria-label")).toContain(long);
  });

  it("opens the ticket with Enter on the mention", () => {
    const { onOpenMention } = show({ value: "TREEPM-47" });
    fireEvent.keyDown(screen.getByRole("link"), { key: "Enter" });
    expect(onOpenMention).toHaveBeenCalledWith("t47");
  });

  it("leaves a key that does not exist, a key of another project and a key inside code as plain text", () => {
    const { container } = show({ value: "TREEPM-99 e OUTRO-9 e `TREEPM-47`\n\n```\nTREEPM-47\n```" });
    expect(container.querySelector(".description-mention")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("RichDescription tasks", () => {
  it("lets who can edit check and uncheck a task while reading, and hands over the new text", () => {
    const { onToggleTask } = show({ value: "- [ ] fazer\n- [x] feito" });
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    expect(onToggleTask).toHaveBeenLastCalledWith("- [x] fazer\n- [x] feito");
    fireEvent.click(boxes[1]!);
    expect(onToggleTask).toHaveBeenLastCalledWith("- [x] fazer\n- [ ] feito");
  });

  it("does not let a read-only person check a task", () => {
    const { onToggleTask } = show({ value: "- [ ] fazer", canEdit: false });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleTask).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});

describe("RichDescription read-only", () => {
  it("does not ask for edition and is not focusable when the person cannot edit", () => {
    const { container, onRequestEdit } = show({ value: "texto", canEdit: false });
    expect(screen.queryByRole("group", { name: "Descrição" })).toBeNull();
    fireEvent.click(container.querySelector(".tiptap")!);
    expect(onRequestEdit).not.toHaveBeenCalled();
  });

  it("asks for edition when who can edit presses Enter on the text", () => {
    const { onRequestEdit } = show({ value: "texto" });
    fireEvent.keyDown(screen.getByRole("group", { name: "Descrição" }), { key: "Enter" });
    expect(onRequestEdit).toHaveBeenCalledTimes(1);
  });
});

describe("RichDescription links", () => {
  const hrefs = (container: HTMLElement) => Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:msgbox(1)"])("does not make a link of %s", (href) => {
    const { container, onChange } = show({ value: `[x](${href}) e texto` });
    expect(hrefs(container).filter((value) => /^(javascript|data|vbscript):/i.test(value))).toEqual([]);
    expect(container).toHaveTextContent("x");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["http://a.com/x", "https://a.com/x", "mailto:a@b.com"])("makes %s a link that opens in a new tab without opener or referrer", (href) => {
    const { container } = show({ value: `[x](${href})` });
    const link = container.querySelector("a")!;
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("RichDescription e o elo de pessoa (ADR 0058, revisão 2)", () => {
  const person = (id: string, name: string) => ({ person: { id, displayName: name } as never, blocked: false });
  const people = { options: [person("p2", "Bia")], names: new Map([["p2", "Bia"]]) };

  it("com a lista de pessoas, mostra o nome atual da pessoa e não o guardado no texto", () => {
    const { container } = show({ value: "[@Administrador](person:p2)", people });
    expect(container.querySelector(".mention-person")).toHaveTextContent("@Bia");
    expect(container.textContent).not.toContain("Administrador");
  });

  it("id que não existe: o nome guardado, sem destaque", () => {
    const { container } = show({ value: "[@Zé](person:p9)", people });
    expect(container.querySelector(".mention-person")).toHaveClass("is-gone");
    expect(container).toHaveTextContent("@Zé");
  });

  it("sem a lista de pessoas (a descrição, a resposta do assistente) o elo é só @Nome", () => {
    const { container } = show({ value: "Fale com [@Bia](person:p2)." });
    expect(container.querySelector(".mention-person")).toBeNull();
    expect(container.querySelector("[data-person-id]")).toBeNull();
    expect(container).toHaveTextContent("Fale com @Bia.");
  });
});

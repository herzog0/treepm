import { describe, expect, it } from "vitest";
import { stripMarkdown } from "./excerpt.js";

describe("stripMarkdown", () => {
  it("removes heading, list, task, quote and code signs", () => {
    expect(stripMarkdown("# Título\n- item um\n1. item dois\n- [x] feito\n- [ ] a fazer\n> citação")).toBe("Título\nitem um\nitem dois\nfeito\na fazer\ncitação");
  });

  it("removes bold, italic, inline code and keeps the words", () => {
    expect(stripMarkdown("**negrito**, *itálico*, _outro_ e `código`")).toBe("negrito, itálico, outro e código");
  });

  it("keeps only the text of a link", () => {
    expect(stripMarkdown("veja [a página](https://x.com/a_b) agora")).toBe("veja a página agora");
  });

  it("drops code fences and keeps their content", () => {
    expect(stripMarkdown("antes\n```\nlinha de código\n```\ndepois")).toBe("antes\nlinha de código\ndepois");
  });

  it("removes a marker left open by a truncated excerpt", () => {
    expect(stripMarkdown("começo **negri")).toBe("começo negri");
  });

  it("leaves plain text, keys and snake_case words alone", () => {
    expect(stripMarkdown("Ver TREEPM-47 e snake_case_nome, 2*3")).toBe("Ver TREEPM-47 e snake_case_nome, 2*3");
  });
});

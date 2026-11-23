import { describe, expect, it } from "vitest";
import { EMBEDDING_TEXT_MAX_CHARS, ticketEmbeddingText } from "./ticket-embedding-text.js";

describe("ticketEmbeddingText", () => {
  it("é o título, uma linha em branco e a descrição", () => {
    expect(ticketEmbeddingText({ title: "Sincronizar", description: "Receber só o diff." })).toBe("Sincronizar\n\nReceber só o diff.");
  });

  it("sem descrição é só o título, sem linhas sobrando", () => {
    expect(ticketEmbeddingText({ title: "  Sincronizar  ", description: " \n " })).toBe("Sincronizar");
  });

  it("corta em 8 000 caracteres sem partir um par substituto", () => {
    expect(EMBEDDING_TEXT_MAX_CHARS).toBe(8000);
    const text = ticketEmbeddingText({ title: "T", description: "a".repeat(9000) });
    expect(Array.from(text)).toHaveLength(8000);
    const emoji = ticketEmbeddingText({ title: "T", description: "😀".repeat(9000) });
    expect(Array.from(emoji)).toHaveLength(8000);
    expect(emoji.endsWith("😀")).toBe(true);
  });
});

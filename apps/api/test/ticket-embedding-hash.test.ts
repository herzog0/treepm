import { createHash } from "node:crypto";
import { ticketEmbeddingText } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { ticketEmbeddingHash } from "../src/assistant/ticket-embeddings.js";

describe("ticketEmbeddingHash", () => {
  const base = { title: "Sincronizar", description: "Receber só o diff." };
  it("é o sha256 em hex do texto final e é estável", () => {
    expect(ticketEmbeddingHash(base)).toBe(createHash("sha256").update(ticketEmbeddingText(base), "utf8").digest("hex"));
    expect(ticketEmbeddingHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(ticketEmbeddingHash(base)).toBe(ticketEmbeddingHash({ ...base }));
  });
  it("muda quando o título ou a descrição mudam", () => {
    expect(ticketEmbeddingHash({ ...base, title: "Outro" })).not.toBe(ticketEmbeddingHash(base));
    expect(ticketEmbeddingHash({ ...base, description: "Outra." })).not.toBe(ticketEmbeddingHash(base));
  });
  it("não muda com situação, pai, prioridade ou qualquer outro campo", () => {
    const withOthers = { ...base, status: "done", parentId: "p", priority: 9, number: 4 } as typeof base;
    expect(ticketEmbeddingHash(withOthers)).toBe(ticketEmbeddingHash(base));
  });
});

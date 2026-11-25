import { describe, expect, it } from "vitest";
import type { CommentOut, ConversationOut, HistoryValue, MessageOut } from "../src/mcp/mcp-people-read.js";
import { cleanMentions } from "../src/mcp/mcp-text.js";
import type { CleanText } from "../src/mcp/mcp-text.js";

// Revisão de segurança da fatia 3 (M6): todo campo de texto livre que sai pelas leituras de pessoas é `CleanText`, que só o limpador
// produz. Este teste é verificado pelo `typecheck`: se um campo aceitar texto cru, a diretiva `@ts-expect-error` deixa de ter erro e a
// verificação falha.
describe("estrutural por tipo: texto cru não sai", () => {
  it("campos de texto livre só aceitam o que passou pelo limpador", () => {
    const raw: string = "Jur [@x@y.test](person:6f1c2c1e-3b0e-4a57-9f55-0d2a5c1f7a10)";
    // @ts-expect-error texto cru não é CleanText
    const asClean: CleanText = raw;
    // @ts-expect-error texto cru não é valor de campo do histórico
    const asHistory: HistoryValue = raw;
    // @ts-expect-error corpo de comentário
    const commentBody: CommentOut["body"] = raw;
    // @ts-expect-error área de comentário
    const commentArea: CommentOut["area"] = raw;
    // @ts-expect-error corpo de mensagem
    const messageBody: MessageOut["body"] = raw;
    // @ts-expect-error título ou assunto de conversa
    const title: ConversationOut["title"] = raw;
    const clean = cleanMentions(raw, () => undefined);
    const ok: [CleanText, HistoryValue, CommentOut["body"], ConversationOut["title"]] = [clean, clean, clean, clean];
    expect([asClean, asHistory, commentBody, commentArea, messageBody, title, ...ok]).toHaveLength(10);
    expect(clean).toBe("Jur @Unnamed person");
  });
});

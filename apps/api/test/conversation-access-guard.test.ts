import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rawTemplates } from "./recursive-query-guard.test.js";

// Guarda (ADR 0055, regra 3): as tabelas de conversa só são tocadas pelo serviço e pela porta de acesso. Outro arquivo que as leia
// passa por cima de `ConversationAccess.resolve` e da regra de visibilidade.
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWED = new Set(["assistant/conversation.service.ts", "assistant/conversation-access.ts"]);
const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? sources(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
const CLIENT = /\.(conversation|conversationParticipant|conversationMessage)\s*\.\s*[a-zA-Z]+\s*\(/;
const TABLES = /\b(conversations|conversation_participants|conversation_messages)\b/;

describe("quem toca as tabelas de conversa", () => {
  it("nenhum arquivo fora do serviço e da porta de acesso usa o cliente ou o SQL delas", () => {
    const offenders = sources(SRC)
      .filter((file) => !ALLOWED.has(relative(SRC, file)))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return CLIENT.test(text) || rawTemplates(text).some((t) => TABLES.test(t));
      })
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("a guarda enxerga os dois arquivos permitidos (não está cega)", () => {
    const hits = sources(SRC).filter((file) => ALLOWED.has(relative(SRC, file))).filter((f) => CLIENT.test(readFileSync(f, "utf8")));
    expect(hits).toHaveLength(2);
  });
});

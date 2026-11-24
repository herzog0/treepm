import { describe, expect, it } from "vitest";
import {
  CHAT_ASSISTANT_PER_PERSON_PER_MINUTE,
  CHAT_HISTORY_MAX_CHARS,
  CHAT_THREAD_PER_PERSON_PER_MINUTE,
  CHAT_HISTORY_MAX_MESSAGES,
  chatBodyOf,
  trimChatHistory,
} from "./chat.js";
import type { ChatTurn } from "./chat.js";

describe("chatBodyOf", () => {
  it("apara e recusa vazio e acima do teto", () => {
    expect(chatBodyOf("  oi  ")).toBe("oi");
    expect(chatBodyOf("   ")).toBeNull();
    expect(chatBodyOf("a".repeat(4000))).toHaveLength(4000);
    expect(chatBodyOf("a".repeat(4001))).toBeNull();
  });
});

describe("trimChatHistory (o teto do que vai ao provedor)", () => {
  const turn = (author: ChatTurn["author"], body: string): ChatTurn => ({ author, body });

  it("deixa como está o que cabe", () => {
    const history = [turn("person", "a"), turn("assistant", "b"), turn("person", "c")];
    expect(trimChatHistory(history)).toEqual(history);
  });

  it("guarda as mais recentes e começa por mensagem da pessoa", () => {
    const history: ChatTurn[] = [];
    for (let i = 0; i < CHAT_HISTORY_MAX_MESSAGES + 5; i += 1) history.push(turn(i % 2 === 0 ? "person" : "assistant", `m${i}`));
    history.push(turn("person", "ultima"));
    const kept = trimChatHistory(history);
    expect(kept.length).toBeLessThanOrEqual(CHAT_HISTORY_MAX_MESSAGES);
    expect(kept[0]?.author).toBe("person");
    expect(kept[kept.length - 1]?.body).toBe("ultima");
  });

  it("respeita o teto de caracteres, sempre mantendo a mensagem nova", () => {
    const big = "x".repeat(3000);
    const history: ChatTurn[] = [];
    for (let i = 0; i < 20; i += 1) history.push(turn(i % 2 === 0 ? "person" : "assistant", big));
    history.push(turn("person", "nova"));
    const kept = trimChatHistory(history);
    expect(kept.reduce((sum, m) => sum + m.body.length, 0)).toBeLessThanOrEqual(CHAT_HISTORY_MAX_CHARS);
    expect(kept[kept.length - 1]?.body).toBe("nova");
    expect(kept[0]?.author).toBe("person");
  });

  it("histórico vazio continua vazio", () => {
    expect(trimChatHistory([])).toEqual([]);
  });
});

describe("Revisão 1: caracteres que o banco não aceita e limite de thread", () => {
  it.each(["a\u0000b", "a\u0001", "a\u001f", "a\u007f", "a\ud800", "\udc00a"])("chatBodyOf recusa %j", (raw) => {
    expect(chatBodyOf(raw)).toBeNull();
  });
  it("aceita tabulação, quebra de linha, acentos e emoji", () => {
    expect(chatBodyOf("a\tb\nc\r\nação 😀")).toBe("a\tb\nc\r\nação 😀");
  });
  it("o limite de thread é maior que o do assistente e positivo", () => {
    expect(CHAT_THREAD_PER_PERSON_PER_MINUTE).toBeGreaterThan(CHAT_ASSISTANT_PER_PERSON_PER_MINUTE);
  });
});

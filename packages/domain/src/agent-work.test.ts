import { describe, expect, it } from "vitest";
import {
  AGENT_WORK_DEFAULT_MINUTES,
  AGENT_WORK_MAX_MINUTES,
  AGENT_WORK_MIN_MINUTES,
  AGENT_WORK_NOTE_MAX,
  agentWorkEnd,
  agentWorkIsValid,
  agentWorkNoteOf,
  agentWorkRefusal,
  agentWorkWindow,
} from "./agent-work.js";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const MIN = 60_000;

describe("agentWorkIsValid", () => {
  it("vale só enquanto o fim é futuro", () => {
    expect(agentWorkIsValid(new Date(NOW + 1), NOW)).toBe(true);
    expect(agentWorkIsValid(new Date(NOW), NOW)).toBe(false);
    expect(agentWorkIsValid(new Date(NOW - 1), NOW)).toBe(false);
    expect(agentWorkIsValid(null, NOW)).toBe(false);
  });
});

describe("agentWorkRefusal", () => {
  it("liga em a fazer, em andamento e em revisão", () => {
    for (const status of ["todo", "in_progress", "in_review"] as const) expect(agentWorkRefusal(status, false)).toBeNull();
  });
  it("recusa ticket concluído ou cancelado", () => {
    expect(agentWorkRefusal("done", false)).toBe("finished");
    expect(agentWorkRefusal("cancelled", false)).toBe("finished");
  });
  it("recusa ideia ou ticket dentro de uma, qualquer que seja a situação", () => {
    expect(agentWorkRefusal("todo", true)).toBe("idea");
    expect(agentWorkRefusal("done", true)).toBe("idea");
  });
});

describe("agentWorkWindow", () => {
  it("usa 60 minutos quando não vier", () => {
    expect(AGENT_WORK_DEFAULT_MINUTES).toBe(60);
    expect(agentWorkWindow(undefined)).toEqual({ ok: true, minutes: 60 });
  });
  it("aceita de 5 a 240 minutos inteiros", () => {
    expect(AGENT_WORK_MIN_MINUTES).toBe(5);
    expect(AGENT_WORK_MAX_MINUTES).toBe(240);
    expect(agentWorkWindow(5)).toEqual({ ok: true, minutes: 5 });
    expect(agentWorkWindow(240)).toEqual({ ok: true, minutes: 240 });
  });
  it("recusa menos de 5, mais de 240, fração e valor que não é número", () => {
    for (const bad of [4, 241, 0, -1, 5.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(agentWorkWindow(bad).ok).toBe(false);
  });
});

describe("agentWorkEnd", () => {
  it("soma os minutos ao instante dado, sem olhar o relógio do sistema", () => {
    expect(agentWorkEnd(NOW, 60).getTime()).toBe(NOW + 60 * MIN);
  });
});

describe("agentWorkNoteOf", () => {
  it("recusa caracteres de direção e invisíveis (U+200B a U+200F, U+202A a U+202E, U+2060 a U+2069, U+FEFF), no meio e nas pontas", () => {
    const bad = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff];
    for (const code of bad) {
      const ch = String.fromCodePoint(code);
      for (const text of [`ab${ch}cd`, `${ch}abcd`, `abcd${ch}`]) expect(agentWorkNoteOf(text), `U+${code.toString(16)} em "${text.length}"`).toBeNull();
    }
    // vizinhos fora dos intervalos continuam valendo
    for (const code of [0x200a, 0x2010, 0x202f, 0x205f, 0x206a]) expect(agentWorkNoteOf(`ab${String.fromCodePoint(code)}cd`), `U+${code.toString(16)}`).not.toBeNull();
    expect(agentWorkNoteOf("acentuação e emoji 🚧")).toBe("acentuação e emoji 🚧");
  });
  it("apara, aceita até 200 caracteres e trata vazio como sem nota", () => {
    expect(AGENT_WORK_NOTE_MAX).toBe(200);
    expect(agentWorkNoteOf("  escrevendo os testes  ")).toBe("escrevendo os testes");
    expect(agentWorkNoteOf("")).toBe("");
    expect(agentWorkNoteOf(undefined)).toBe("");
    expect(agentWorkNoteOf("a".repeat(200))).toHaveLength(200);
  });
  it("recusa mais de 200 caracteres (depois de aparar)", () => {
    expect(agentWorkNoteOf("a".repeat(201))).toBeNull();
    expect(agentWorkNoteOf(`  ${"a".repeat(200)}  `)).toHaveLength(200);
  });
  it("recusa quebra de linha e caracteres de controle", () => {
    expect(agentWorkNoteOf("linha 1\nlinha 2")).toBeNull();
    expect(agentWorkNoteOf("a\u0000b")).toBeNull();
  });
});

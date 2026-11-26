import { describe, expect, it } from "vitest";
import { daysOverdue, DUE_DATE_MAX, DUE_DATE_MIN, isOverdue, isValidDueDate, parseDueDate, utcToday } from "./due-date.js";

// ADR 0064: o prazo é uma data de calendário (`AAAA-MM-DD`), sem hora e sem fuso.
describe("isValidDueDate", () => {
  it.each(["2026-12-12", "2000-01-01", "2100-12-31", "2024-02-29", "2026-01-31"])("aceita %s", (value) => {
    expect(isValidDueDate(value)).toBe(true);
  });
  it.each([
    "2026-02-30",
    "2026-02-29",
    "2100-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-12-1",
    "26-12-12",
    "2026/12/12",
    "2026-12-12T00:00:00Z",
    " 2026-12-12",
    "1999-12-31",
    "2101-01-01",
    "",
    "abc",
  ])("recusa %j", (value) => {
    expect(isValidDueDate(value)).toBe(false);
  });
  it("recusa o que não é texto", () => {
    expect(isValidDueDate(20261212 as unknown as string)).toBe(false);
    expect(isValidDueDate(null as unknown as string)).toBe(false);
  });
  it("a faixa é 2000-01-01 a 2100-12-31", () => {
    expect(DUE_DATE_MIN).toBe("2000-01-01");
    expect(DUE_DATE_MAX).toBe("2100-12-31");
  });
});

describe("parseDueDate", () => {
  it("devolve a data quando é válida e null quando não é", () => {
    expect(parseDueDate("2026-12-12")).toBe("2026-12-12");
    expect(parseDueDate("2026-02-30")).toBeNull();
    expect(parseDueDate(undefined)).toBeNull();
    expect(parseDueDate(12)).toBeNull();
  });
});

describe("isOverdue", () => {
  const today = "2026-12-12";
  it("prazo anterior a hoje e aberto: atrasado", () => {
    for (const category of ["todo", "in_progress", "in_review"] as const) {
      expect(isOverdue({ dueDate: "2026-12-11", category, today, idea: false })).toBe(true);
    }
  });
  it("prazo hoje ou depois: em dia", () => {
    expect(isOverdue({ dueDate: today, category: "todo", today, idea: false })).toBe(false);
    expect(isOverdue({ dueDate: "2026-12-13", category: "todo", today, idea: false })).toBe(false);
  });
  it("concluído e cancelado nunca estão atrasados", () => {
    expect(isOverdue({ dueDate: "2020-01-01", category: "done", today, idea: false })).toBe(false);
    expect(isOverdue({ dueDate: "2020-01-01", category: "cancelled", today, idea: false })).toBe(false);
  });
  it("ideia (raiz em qualquer estágio, ou ticket dentro dela) nunca está atrasada", () => {
    for (const category of ["todo", "in_progress", "in_review"] as const) {
      expect(isOverdue({ dueDate: "2020-01-01", category, today, idea: true })).toBe(false);
      expect(daysOverdue({ dueDate: "2020-01-01", category, today, idea: true })).toBe(0);
    }
  });
  it("sem prazo nunca está atrasado", () => {
    expect(isOverdue({ dueDate: null, category: "todo", today, idea: false })).toBe(false);
  });
  it("a comparação é de texto de datas, atravessando mês e ano", () => {
    expect(isOverdue({ dueDate: "2025-12-31", category: "todo", today: "2026-01-01", idea: false })).toBe(true);
    expect(isOverdue({ dueDate: "2026-09-30", category: "todo", today: "2026-10-01", idea: false })).toBe(true);
  });
});

describe("daysOverdue", () => {
  it("quantos dias desde o prazo, só quando atrasado", () => {
    expect(daysOverdue({ dueDate: "2026-12-11", category: "todo", today: "2026-12-12", idea: false })).toBe(1);
    expect(daysOverdue({ dueDate: "2026-11-12", category: "in_progress", today: "2026-12-12", idea: false })).toBe(30);
    expect(daysOverdue({ dueDate: "2024-02-28", category: "todo", today: "2024-03-01", idea: false })).toBe(2);
    expect(daysOverdue({ dueDate: "2025-12-31", category: "todo", today: "2026-12-31", idea: false })).toBe(365);
  });
  it("0 quando não está atrasado", () => {
    expect(daysOverdue({ dueDate: "2026-12-12", category: "todo", today: "2026-12-12", idea: false })).toBe(0);
    expect(daysOverdue({ dueDate: "2026-12-01", category: "done", today: "2026-12-12", idea: false })).toBe(0);
    expect(daysOverdue({ dueDate: null, category: "todo", today: "2026-12-12", idea: false })).toBe(0);
  });
});

describe("utcToday", () => {
  it("o dia em UTC do instante dado", () => {
    expect(utcToday(Date.UTC(2026, 11, 12, 23, 59, 59))).toBe("2026-12-12");
    expect(utcToday(Date.UTC(2026, 11, 13, 0, 0, 0))).toBe("2026-12-13");
  });
});

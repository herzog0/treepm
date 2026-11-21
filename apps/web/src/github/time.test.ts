import { describe, expect, it } from "vitest";
import { formatDate, relativeTime } from "./time.js";

const now = Date.parse("2026-11-21T12:00:00.000Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it.each([
    [5, "agora"],
    [59, "agora"],
    [60, "há 1 minuto"],
    [150, "há 2 minutos"],
    [3600, "há 1 hora"],
    [7300, "há 2 horas"],
    [86400, "há 1 dia"],
    [3 * 86400, "há 3 dias"],
  ])("%is ago reads %s", (seconds, text) => {
    expect(relativeTime(ago(seconds), now)).toBe(text);
  });

  it("never goes negative for a timestamp slightly in the future", () => {
    expect(relativeTime(ago(-30), now)).toBe("agora");
  });
});

describe("formatDate", () => {
  it("writes the date in Portuguese", () => {
    expect(formatDate("2026-11-20T15:00:00.000Z")).toBe("20 de novembro de 2026");
  });
});

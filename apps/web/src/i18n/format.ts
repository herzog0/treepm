import type { Language } from "./languages.js";

/** Datas, números e maiúsculas no idioma ativo. Os idiomas da interface já são códigos válidos para `Intl`. */

const dateFormats = new Map<Language, Intl.DateTimeFormat>();

/** "20 de novembro de 2026" · "November 20, 2026" · "20 de noviembre de 2026". */
export function formatDate(language: Language, iso: string): string {
  let format = dateFormats.get(language);
  if (!format) {
    format = new Intl.DateTimeFormat(language, { day: "numeric", month: "long", year: "numeric" });
    dateFormats.set(language, format);
  }
  return format.format(new Date(iso));
}

export function formatNumber(language: Language, value: number, options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(language, options);
}

export function toUpper(language: Language, text: string): string {
  return text.toLocaleUpperCase(language);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_FOR = 7 * DAY;

const relativeFormats = new Map<Language, Intl.RelativeTimeFormat>();
const shortDateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Hora de uma entrada de atividade: relativa enquanto recente ("agora", "há 5 minutos", "ontem") e absoluta
 * ("15 de nov.", com o ano só quando não é o corrente) a partir de sete dias. `now` vem de quem chama, para testar.
 */
export function formatActivityTime(language: Language, iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  const elapsed = Math.max(0, now.getTime() - then);
  if (elapsed < RELATIVE_FOR) {
    let relative = relativeFormats.get(language);
    if (!relative) {
      relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
      relativeFormats.set(language, relative);
    }
    if (elapsed < MINUTE) return relative.format(0, "second");
    if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), "minute");
    if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), "hour");
    return relative.format(-Math.floor(elapsed / DAY), "day");
  }
  const withYear = new Date(then).getFullYear() !== now.getFullYear();
  const key = `${language}:${withYear}`;
  let format = shortDateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(language, withYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
    shortDateFormats.set(key, format);
  }
  return format.format(new Date(then));
}

/** Data e hora completas, para o `title` da hora de uma entrada. `timeZone` só existe para os testes. */
export function formatDateTime(language: Language, iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
}

/** A hora do dia (sem data), na hora local: "até 14:32" do marcador de trabalho pela IA (ADR 0043). */
export function formatClock(language: Language, iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(language, { timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
}

const dueDateFormats = new Map<Language, Intl.DateTimeFormat>();

/**
 * Prazo do ticket (ADR 0064): data de calendário `AAAA-MM-DD`, sem hora nem fuso. Lida como meia-noite em UTC e formatada
 * em UTC, para não andar um dia em fuso nenhum: "1 de dezembro de 2026" · "December 1, 2026" · "1 de diciembre de 2026".
 */
export function formatDueDate(language: Language, dueDate: string): string {
  let format = dueDateFormats.get(language);
  if (!format) {
    format = new Intl.DateTimeFormat(language, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    dueDateFormats.set(language, format);
  }
  return format.format(new Date(`${dueDate}T00:00:00Z`));
}

const listFormats = new Map<Language, Intl.ListFormat>();

/** Nomes numa lista com a conjunção do idioma: "A, B e C" · "A, B, and C" · "A, B y C". */
export function formatList(language: Language, items: readonly string[]): string {
  let format = listFormats.get(language);
  if (!format) {
    format = new Intl.ListFormat(language, { style: "long", type: "conjunction" });
    listFormats.set(language, format);
  }
  return format.format(items);
}

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

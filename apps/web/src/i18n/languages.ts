/** Idiomas da interface (ADR 0035). O português é o idioma de origem. */
export const LANGUAGES = ["pt-BR", "en", "es-MX"] as const;
export type Language = (typeof LANGUAGES)[number];

/** O que a pessoa escolhe em Configurações: um idioma ou "auto", que segue o navegador. */
export const LANGUAGE_PREFERENCES = ["auto", ...LANGUAGES] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "auto";

/** `pt*` vira `pt-BR`, `es*` vira `es-MX`, qualquer outro (ou lista vazia) vira `en`. Vale o primeiro idioma da lista. */
export function languageFromNavigator(languages: readonly string[]): Language {
  const primary = languages[0]?.toLowerCase().split("-")[0];
  if (primary === "pt") return "pt-BR";
  if (primary === "es") return "es-MX";
  return "en";
}

export function resolveLanguage(preference: LanguagePreference, navigatorLanguages: readonly string[]): Language {
  return preference === "auto" ? languageFromNavigator(navigatorLanguages) : preference;
}

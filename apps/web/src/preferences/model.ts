import { z } from "zod";
import { DEFAULT_LANGUAGE_PREFERENCE, LANGUAGE_PREFERENCES } from "../i18n/languages.js";
import type { LanguagePreference } from "../i18n/languages.js";

/** Preferências da pessoa (ADR 0028). Cada preferência nova entra aqui, com o padrão dela. */
export interface Preferences {
  /** Idioma da interface (ADR 0035); "auto" segue o navegador. */
  readonly language: LanguagePreference;
}

export const DEFAULT_PREFERENCES: Preferences = { language: DEFAULT_LANGUAGE_PREFERENCE };

const FORMAT_VERSION = 1;
const language = z.enum(LANGUAGE_PREFERENCES);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Lê `unsafeMetadata.treepm.preferences`. Valor ausente ou inválido vira o padrão, campo a campo; o dado é
 * gravável pelo navegador e nunca serve de autorização.
 */
export function parsePreferences(unsafeMetadata: unknown): Preferences {
  const stored = isRecord(unsafeMetadata) && isRecord(unsafeMetadata.treepm) ? unsafeMetadata.treepm.preferences : undefined;
  if (!isRecord(stored) || stored.v !== FORMAT_VERSION) return DEFAULT_PREFERENCES;
  const chosenLanguage = language.safeParse(stored.language);
  // Uma chave `camera` guardada por versões antigas (ADR 0028) é ignorada; ao gravar de novo ela não é reescrita.
  return { language: chosenLanguage.success ? chosenLanguage.data : DEFAULT_PREFERENCES.language };
}

/** Novo `unsafeMetadata` com as preferências gravadas no formato versionado e as demais chaves preservadas. */
export function withPreferences(unsafeMetadata: Record<string, unknown>, preferences: Preferences): Record<string, unknown> {
  const treepm = isRecord(unsafeMetadata.treepm) ? unsafeMetadata.treepm : {};
  return {
    ...unsafeMetadata,
    treepm: { ...treepm, preferences: { v: FORMAT_VERSION, language: preferences.language } },
  };
}

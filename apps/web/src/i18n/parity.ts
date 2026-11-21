import { LANGUAGES } from "./languages.js";
import type { Language } from "./languages.js";

/**
 * Verificação de paridade dos catálogos (ADR 0035). Recebe os arquivos como o `import.meta.glob` os entrega
 * (`./locales/<idioma>/<área>.json` → conteúdo) e devolve uma lista de problemas; vazia quer dizer que os três
 * idiomas têm os mesmos arquivos, as mesmas chaves, as mesmas variáveis e as formas de plural que cada idioma exige.
 */

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
/** `{{nome}}`, `{{nome, formato}}` e marcação do `Trans` (`<0>`, `<strong>`). */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}|<\/?([\w-]+)\s*\/?>/g;
/** `_zero` é permitido em qualquer idioma: o português precisa dele para "0 membros" (a regra do idioma manda o 0 para o singular). */
const ALWAYS_ALLOWED = new Set(["zero"]);

interface Entry {
  text: string;
  /** Sufixo de plural (`one`, `other`…) quando a chave é uma forma de plural. */
  form: string | null;
  base: string;
}

function flatten(value: unknown, prefix: string, out: Map<string, unknown>) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value);
  }
}

function variablesOf(text: string): string {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1] ? `{{${match[1]}}}` : `<${match[2]}>`);
  return [...found].sort().join(" ");
}

export function checkParity(files: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const byLanguage = new Map<Language, Map<string, unknown>>();
  const namespaces = new Set<string>();

  for (const [path, content] of Object.entries(files)) {
    const match = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!match) {
      problems.push(`unexpected catalog path ${path}`);
      continue;
    }
    const language = match[1] as Language;
    if (!LANGUAGES.includes(language)) {
      problems.push(`unknown language directory ${match[1]}`);
      continue;
    }
    if (!byLanguage.has(language)) byLanguage.set(language, new Map());
    byLanguage.get(language)!.set(match[2]!, content);
    namespaces.add(match[2]!);
  }

  for (const namespace of [...namespaces].sort()) {
    const entries = new Map<Language, Map<string, Entry>>();
    for (const language of LANGUAGES) {
      const content = byLanguage.get(language)?.get(namespace);
      if (content === undefined) {
        problems.push(`missing file ${language}/${namespace}.json`);
        continue;
      }
      const flat = new Map<string, unknown>();
      flatten(content, "", flat);
      const map = new Map<string, Entry>();
      for (const [key, value] of flat) {
        if (typeof value !== "string") {
          problems.push(`${language} ${namespace}: "${key}" is not text`);
          continue;
        }
        if (value.trim() === "") problems.push(`${language} ${namespace}: "${key}" is empty`);
        const suffix = PLURAL_SUFFIX.exec(key);
        map.set(key, { text: value, form: suffix ? suffix[1]! : null, base: suffix ? key.slice(0, suffix.index) : key });
      }
      entries.set(language, map);
    }

    // Chaves de cada idioma, reunidas pela base (as formas de plural contam como uma chave só).
    const bases = new Map<Language, Map<string, Entry[]>>();
    for (const [language, map] of entries) {
      const grouped = new Map<string, Entry[]>();
      for (const entry of map.values()) grouped.set(entry.base, [...(grouped.get(entry.base) ?? []), entry]);
      bases.set(language, grouped);
    }

    const reference = bases.get("pt-BR");
    const allBases = new Set([...bases.values()].flatMap((grouped) => [...grouped.keys()]));
    for (const base of [...allBases].sort()) {
      const referenceEntries = reference?.get(base);
      for (const language of LANGUAGES) {
        const group = bases.get(language);
        if (!group) continue;
        const own = group.get(base);
        if (!own) {
          problems.push(`${language} ${namespace}: missing key "${base}"`);
          continue;
        }
        if (!referenceEntries) {
          problems.push(`${language} ${namespace}: missing key "${base}" in pt-BR`);
          continue;
        }
        const isPlural = own.some((entry) => entry.form !== null);
        const referenceIsPlural = referenceEntries.some((entry) => entry.form !== null);
        if (isPlural !== referenceIsPlural) {
          problems.push(
            referenceIsPlural
              ? `${language} ${namespace}: "${base}" is plural in pt-BR but not in ${language}`
              : `${language} ${namespace}: "${base}" is plural in ${language} but not in pt-BR`,
          );
          continue;
        }
        if (isPlural) {
          const present = new Set(own.map((entry) => entry.form!));
          const required = new Set(new Intl.PluralRules(language).resolvedOptions().pluralCategories);
          for (const form of required) if (!present.has(form)) problems.push(`${language} ${namespace}: "${base}" lacks the plural form _${form}`);
          for (const form of present) {
            if (!required.has(form as Intl.LDMLPluralRule) && !ALWAYS_ALLOWED.has(form)) {
              problems.push(`${language} ${namespace}: "${base}" has the unexpected plural form _${form}`);
            }
          }
        }
        const expected = variablesOf((referenceEntries.find((entry) => entry.form === "other") ?? referenceEntries[0]!).text);
        if (language === "pt-BR" && isPlural) {
          for (const entry of referenceEntries) {
            const actual = variablesOf(entry.text);
            if (actual !== expected) problems.push(`pt-BR ${namespace}: "${base}_${entry.form}" has variables ${actual} but its _other has ${expected}`);
          }
          continue;
        }
        if (language === "pt-BR") continue;
        for (const entry of own) {
          const actual = variablesOf(entry.text);
          if (actual !== expected) {
            const key = entry.form ? `${entry.base}_${entry.form}` : entry.base;
            problems.push(`${language} ${namespace}: "${key}" has variables ${actual} but pt-BR has ${expected}`);
          }
        }
      }
    }
  }
  return problems;
}

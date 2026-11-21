import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { Language } from "../i18n/languages.js";
import { setTestLanguage } from "../test/i18n.js";
import { describeTicketListIssue, ticketListIssueText } from "./parseTicketList.js";

const CODES = ["text_before_first_item", "stray_line", "empty_title", "title_too_long", "description_too_long", "too_many_items", "depth_too_deep", "empty_list", "marker_on_parent"];

describe.each([
  {
    language: "pt-BR" as const,
    prefix: "Linha 7: ",
    messages: {
      description_too_long: "A descrição passa de 20.000 caracteres.",
      too_many_items: "A lista passa de 500 itens. Importe em lotes menores.",
      text_before_first_item: "Há texto antes do primeiro item. Comece a lista com “- ” ou “* ”.",
    },
    unknown: "Linha 2: a lista não pôde ser interpretada.",
  },
  {
    language: "en" as const,
    prefix: "Line 7: ",
    messages: {
      description_too_long: "The description is longer than 20,000 characters.",
      too_many_items: "The list has more than 500 items. Import in smaller batches.",
      text_before_first_item: "There is text before the first item. Start the list with “- ” or “* ”.",
    },
    unknown: "Line 2: the list could not be interpreted.",
  },
  {
    language: "es-MX" as const,
    prefix: "Línea 7: ",
    messages: {
      description_too_long: "La descripción pasa de 20,000 caracteres.",
      too_many_items: "La lista pasa de 500 elementos. Importa en lotes más pequeños.",
      text_before_first_item: "Hay texto antes del primer elemento. Empieza la lista con “- ” o “* ”.",
    },
    unknown: "Línea 2: no se pudo interpretar la lista.",
  },
])("ticketListIssueText in $language", ({ language, prefix, messages, unknown }) => {
  it("describes every code with the line number, in the language", async () => {
    await setTestLanguage(language as Language);
    const t = i18n.getFixedT(language, "tickets");
    for (const [code, text] of Object.entries(messages)) expect(ticketListIssueText(t, language, { line: 7, code })).toBe(`${prefix}${text}`);
    for (const code of CODES) {
      const message = ticketListIssueText(t, language, { line: 7, code });
      expect(message.startsWith(prefix)).toBe(true);
      expect(message).not.toContain(code);
      expect(message.length).toBeGreaterThan(15);
    }
    expect(ticketListIssueText(t, language, { line: 2, code: "xyz" })).toBe(unknown);
  });
});

describe("describeTicketListIssue (kept for import/)", () => {
  it("still answers in Portuguese", () => {
    expect(describeTicketListIssue({ line: 1, code: "empty_list" })).toBe("Linha 1: Não há nenhum item na lista.");
  });
});

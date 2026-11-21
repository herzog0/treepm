import { act } from "@testing-library/react";
import i18n from "../i18n/index.js";
import type { Language } from "../i18n/languages.js";

/**
 * Os testes rodam em `pt-BR` (o `test-setup.ts` fixa o idioma antes de cada teste). Para renderizar outra
 * tela em outro idioma, chame isto antes do `render`.
 */
export async function setTestLanguage(language: Language): Promise<void> {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
}

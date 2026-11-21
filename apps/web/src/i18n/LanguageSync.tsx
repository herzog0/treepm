import { useLayoutEffect } from "react";
import { usePreferences } from "../preferences/context.js";
import i18n from "./index.js";
import { resolveLanguage } from "./languages.js";

/**
 * Põe o idioma ativo de acordo com a preferência da pessoa (ADR 0035). Com "Automático" vale o navegador, e uma
 * mudança do idioma do navegador acompanha. Vive dentro do provedor de preferências; a troca atualiza a tela
 * inteira e o `<html lang>` sem recarregar.
 */
export function LanguageSync() {
  const { preferences } = usePreferences();
  const preference = preferences.language;
  useLayoutEffect(() => {
    const apply = () => void i18n.changeLanguage(resolveLanguage(preference, navigator.languages));
    apply();
    if (preference !== "auto") return;
    window.addEventListener("languagechange", apply);
    return () => window.removeEventListener("languagechange", apply);
  }, [preference]);
  return null;
}

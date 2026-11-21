import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { languageFromNavigator, LANGUAGES } from "./languages.js";
import { resources } from "./resources.js";

const initial = languageFromNavigator(typeof navigator === "undefined" ? [] : navigator.languages);

void i18n.use(initReactI18next).init({
  lng: initial,
  resources,
  ns: Object.keys(resources["pt-BR"]),
  defaultNS: "app",
  supportedLngs: [...LANGUAGES],
  // Sem idioma de reserva: texto que falta aparece como a própria chave, em vez de cair em português sem aviso.
  fallbackLng: false,
  load: "currentOnly",
  interpolation: { escapeValue: false },
  initAsync: false,
  react: { useSuspense: false },
});

/** `<html lang>` acompanha o idioma ativo (ADR 0035). */
const syncHtmlLang = (language: string) => {
  if (typeof document !== "undefined") document.documentElement.lang = language;
};
syncHtmlLang(i18n.language);
i18n.on("languageChanged", syncHtmlLang);

export default i18n;

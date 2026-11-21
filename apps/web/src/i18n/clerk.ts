import { enUS } from "@clerk/localizations/en-US";
import { esMX } from "@clerk/localizations/es-MX";
import { ptBR } from "@clerk/localizations/pt-BR";
import type { Language } from "./languages.js";

/** Tradução dos componentes do Clerk para cada idioma, com os ajustes de texto do produto (um por idioma). */
const LOCALIZATIONS: Record<Language, typeof ptBR> = {
  "pt-BR": { ...ptBR, formFieldInputPlaceholder__signUpPassword: "Crie uma senha" },
  en: { ...enUS, formFieldInputPlaceholder__signUpPassword: "Create a password" },
  "es-MX": { ...esMX, formFieldInputPlaceholder__signUpPassword: "Crea una contraseña" },
};

export const clerkLocalization = (language: Language): typeof ptBR => LOCALIZATIONS[language];

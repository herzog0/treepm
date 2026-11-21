// Preparação da suíte de navegador (`pnpm test:browser`): o texto da interface começa sempre em português, como na suíte de jsdom.
import { beforeEach } from "vitest";
import i18n from "../i18n/index.js";

beforeEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

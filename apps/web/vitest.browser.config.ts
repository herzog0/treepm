import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Suíte de navegador real, sem janela, separada da suíte de jsdom (ADR 0036).
// Se TREEPM_PLAYWRIGHT_WS estiver definida, conecta a um Chromium já rodando (contêiner) em vez de abrir o Chrome da máquina, cujo driver de vídeo trava.
const wsEndpoint = process.env["TREEPM_PLAYWRIGHT_WS"];
const launchOptions = { executablePath: process.env.TREEPM_CHROME ?? "/usr/bin/google-chrome" };
const providerOptions = wsEndpoint ? { connectOptions: { wsEndpoint } } : { launchOptions };
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./src/test/browser-setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(providerOptions),
      instances: [{ browser: "chromium" }],
    },
  },
});

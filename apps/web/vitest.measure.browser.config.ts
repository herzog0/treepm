import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Medição do mapa com projeto grande em navegador real, sem janela (TREEPM-191): `pnpm measure:big-project:browser`.
// Fora das suítes permanentes (`*.measure.browser.tsx`, nunca `*.browser.test.tsx`); sem captura de tela em falha, para não deixar `.png` no repositório.
// Se TREEPM_PLAYWRIGHT_WS estiver definida, conecta a um Chromium já rodando (contêiner) em vez de abrir o Chrome da máquina, cujo driver de vídeo trava.
const wsEndpoint = process.env["TREEPM_PLAYWRIGHT_WS"];
const launchOptions = { executablePath: process.env.TREEPM_CHROME ?? "/usr/bin/google-chrome" };
const providerOptions = wsEndpoint ? { connectOptions: { wsEndpoint } } : { launchOptions };
const measureDir = process.env["MEASURE_DIR"] ?? fileURLToPath(new URL("../../.measure/big-project/", import.meta.url));
export default defineConfig({
  plugins: [react()],
  define: { __MEASURE_DIR__: JSON.stringify(measureDir), __MEASURE_SIZES__: JSON.stringify(process.env["MEASURE_SIZES"] ?? "1000,5000,20000") },
  test: {
    include: ["src/perf/**/*.measure.browser.tsx"],
    setupFiles: ["./src/test/browser-setup.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright(providerOptions),
      instances: [{ browser: "chromium" }],
    },
  },
});

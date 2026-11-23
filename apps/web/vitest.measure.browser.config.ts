import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Medição do mapa com projeto grande em navegador real, sem janela (TREEPM-191): `pnpm measure:big-project:browser`.
// Fora das suítes permanentes (`*.measure.browser.tsx`, nunca `*.browser.test.tsx`); sem captura de tela em falha, para não deixar `.png` no repositório.
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
      provider: playwright({ launchOptions: { executablePath: process.env.TREEPM_CHROME ?? "/usr/bin/google-chrome" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});

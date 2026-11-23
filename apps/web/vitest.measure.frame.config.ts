import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Perfil do quadro do mapa com projeto grande (TREEPM-247): `pnpm measure:map-frame`. Mesmas regras de `vitest.measure.browser.config.ts`.
const measureDir = process.env["MEASURE_DIR"] ?? fileURLToPath(new URL("../../.measure/big-project/", import.meta.url));
// MEASURE_REACT=development usa o React de desenvolvimento (jsxDEV, validações: custo bem maior que o de produção); o padrão é o React de produção com
// `react-dom/profiling` (o `<Profiler>` só reporta nele), que é o que o usuário roda.
const production = (process.env["MEASURE_REACT"] ?? "production") === "production";
export default defineConfig({
  mode: production ? "production" : "test",
  esbuild: production ? { jsxDev: false } : {},
  plugins: [react()],
  resolve: { alias: production ? [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] : [] },
  optimizeDeps: { esbuildOptions: { define: production ? { "process.env.NODE_ENV": '"production"' } : {} } },
  define: {
    ...(production ? { "process.env.NODE_ENV": '"production"' } : {}),
    __MEASURE_DIR__: JSON.stringify(measureDir),
    __MEASURE_SIZES__: JSON.stringify(process.env["MEASURE_SIZES"] ?? "1000,5000,20000"),
    __MEASURE_REACT__: JSON.stringify(production ? "production (react-dom/profiling)" : "development"),
    __MEASURE_STYLE__: JSON.stringify(process.env["MEASURE_STYLE"] ?? ""),
    __MEASURE_LABEL__: JSON.stringify(process.env["MEASURE_LABEL"] ?? ""),
    __MEASURE_PASSES__: JSON.stringify(process.env["MEASURE_PASSES"] ?? "frames,react,trace,cpu"),
  },
  test: {
    include: ["src/perf/mapFrame.measure.browser.tsx"],
    setupFiles: ["./src/test/browser-setup.ts"],
    testTimeout: 1_800_000,
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

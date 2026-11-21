import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";

// Suíte de navegador real, sem janela, separada da suíte de jsdom (ADR 0036).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    setupFiles: ["./src/test/browser-setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { executablePath: process.env.TREEPM_CHROME ?? "/usr/bin/google-chrome" },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});

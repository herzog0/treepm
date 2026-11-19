import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const proxy = { "/api": "http://localhost:4310" };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
});

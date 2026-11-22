import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const proxy = { "/api": "http://localhost:4310" };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
  test: {
    environment: "jsdom",
    // Metade dos núcleos (o padrão do Vitest é quase todos). Cada arquivo cria o próprio jsdom e o mapa é pesado: com a máquina
    // dividida com outras suítes, workers demais disputam CPU e testes de ~2 s passam do prazo (TREEPM-101). Medido: ~5-10 %
    // mais lento com a máquina ocupada por outros processos, e sem falhas por prazo sob carga.
    maxWorkers: Math.max(2, Math.floor(availableParallelism() / 2)),
    setupFiles: ["./src/test-setup.ts"],
    exclude: [...configDefaults.exclude, "**/*.browser.test.{ts,tsx}"],
  },
});

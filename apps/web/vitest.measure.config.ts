import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Medição com projeto grande, em Node, sem navegador (TREEPM-191): `pnpm measure:big-project`. Fora das suítes permanentes
// (nome `*.measure.ts`, nunca `*.test.ts`), de propósito: leva minutos e depende de dados gerados fora do Git.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/perf/**/*.measure.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0056, fatia 2: a pergunta sobre o projeto saiu; tudo o que era dela passa pelo chat (thread de assunto). Guarda estática simples.
const ROOT = join(__dirname, "..", "..", "..");
const SOURCES = ["apps/api/src", "apps/api/scripts", "apps/web/src", "packages/domain/src", "packages/db/src"];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" || name === "generated" ? [] : files(path)) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("a pergunta sobre o projeto não existe mais", () => {
  const forbidden = [["assistant", "/ask"].join(""), "ProjectAnswerer", "PROJECT_ANSWERER", "askProject", "AskPanel", "ask-labels", "claude-project-answerer"];
  it("nenhum código referencia a rota, o respondedor, o painel ou o cliente", () => {
    const offenders = SOURCES.flatMap((dir) => files(join(ROOT, dir))).filter((file) => forbidden.some((word) => readFileSync(file, "utf8").includes(word)));
    expect(offenders.map((file) => file.slice(ROOT.length + 1))).toEqual([]);
  });
  it("os arquivos da pergunta foram removidos", () => {
    for (const gone of ["apps/api/src/assistant/ask.controller.ts", "apps/api/src/assistant/ask.schema.ts", "apps/api/src/assistant/ask-labels.ts", "apps/api/src/assistant/claude-project-answerer.ts", "apps/web/src/assistant/AskPanel.tsx"]) {
      expect(existsSync(join(ROOT, gone)), gone).toBe(false);
    }
  });
});

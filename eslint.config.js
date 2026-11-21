import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import noLiteralUiText from "./eslint-rules/no-literal-ui-text.js";

// Verificação contra texto literal em componente (ADR 0035), ligada por diretório de apps/web/src.
// Ela vale para todo `.tsx` fora de testes, exceto para os diretórios abaixo, que ainda não foram convertidos para o
// catálogo de traduções. Ao converter um diretório, tire-o desta lista: este é o único lugar a editar.
const I18N_PENDING_DIRECTORIES = ["panel", "ticket", "tickets", "import", "github", "map", "assistant", "api", "demo"];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.js"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["**/*.test.tsx", "apps/web/src/test/**", ...I18N_PENDING_DIRECTORIES.map((directory) => `apps/web/src/${directory}/**`)],
    plugins: { treepm: { rules: { "no-literal-ui-text": noLiteralUiText } } },
    rules: { "treepm/no-literal-ui-text": "error" },
  }
);

import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import noLiteralUiText from "./eslint-rules/no-literal-ui-text.js";

// Verificação contra texto literal em componente (ADR 0035): vale para todo `.tsx` de apps/web/src, fora de testes.

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
    ignores: ["**/*.test.tsx", "apps/web/src/test/**"],
    plugins: { treepm: { rules: { "no-literal-ui-text": noLiteralUiText } } },
    rules: { "treepm/no-literal-ui-text": "error" },
  }
);

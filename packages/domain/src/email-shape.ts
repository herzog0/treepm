/**
 * O critério ÚNICO de "isto tem forma de e-mail" (C2 da fatia 2 do ADR 0061; antes só em `apps/api/src/mcp/person-name.ts`). Um nome
 * de exibição com essa forma nunca é guardado nem mostrado como nome: vira ausente (importação do Linear) ou o rótulo neutro (MCP).
 * Quem chama limita o tamanho do texto antes (a expressão não é ancorada).
 */
const EMAIL_SHAPE = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/;

export function looksLikeEmail(text: string): boolean {
  return EMAIL_SHAPE.test(text);
}

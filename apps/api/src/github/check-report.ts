export type CheckFacts = { slug: string; permissions: Record<string, string>; installationCount: number };

/**
 * A saída do `github:check`: só o slug do app, o NOME das permissões (nunca o nível) e a quantidade de instalações.
 * Nenhum token, chave, identificador de instalação ou login passa por aqui.
 */
export function formatCheckReport(facts: CheckFacts): string {
  const names = Object.keys(facts.permissions).sort();
  return [`App: ${facts.slug}`, `Permissões: ${names.length > 0 ? names.join(", ") : "nenhuma"}`, `Instalações: ${facts.installationCount}`].join("\n");
}

/** Mensagem do caso desligado: nomeia só as variáveis que faltam, nunca valores. */
export function disabledMessage(missing: readonly string[]): string {
  return `A ligação com o GitHub está desligada; faltam as variáveis: ${missing.join(", ")}. Nada foi chamado.`;
}

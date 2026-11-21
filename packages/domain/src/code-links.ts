const MAX_TICKET_NUMBER = 2_147_483_647;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Os números de ticket citados em `text` pela chave do projeto (ADR 0032): `KEY-<dígitos>`, sem diferenciar
 * maiúsculas, com o caractere antes de `KEY` fora de letra e dígito e o caractere depois dos dígitos fora de dígito.
 * Zero e números acima do inteiro de 32 bits não valem. Sem repetidos, em ordem crescente.
 */
export function ticketNumbersIn(text: string, projectKey: string): number[] {
  if (projectKey.length === 0) return [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(projectKey)}-(\\d+)(?!\\d)`, "giu");
  const found = new Set<number>();
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value >= 1 && value <= MAX_TICKET_NUMBER) found.add(value);
  }
  return [...found].sort((a, b) => a - b);
}

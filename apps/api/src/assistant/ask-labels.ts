import { scanTicketKeys } from "@treepm/domain";

/**
 * Rótulos neutros da pergunta sobre o projeto (ADR 0037): o provedor nunca vê a chave de um ticket nem a do projeto, só
 * `T` e o número (`T47`). Funções puras; quem chama sabe qual é o projeto.
 */

/** Rótulo solto: mesmas bordas de palavra da chave de ticket (`scanTicketKeys`), número sem zero à esquerda. */
const LABEL = /(?<![\p{L}\p{N}_-])T([1-9]\d{0,8})(?![\p{L}\p{N}_-])/gu;
const LABEL_EXACT = /^T([1-9]\d{0,8})$/;

export const labelOf = (number: number): string => `T${number}`;

/** `T47` → 47; qualquer outra coisa (inclusive `T-47`, `t47`, `T0`, com espaço em volta) → `null`. */
export function parseLabel(text: string): number | null {
  const match = LABEL_EXACT.exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

/** Ida: cada chave deste projeto (`CHAVE-47`) vira `T47`. Chaves de outros projetos ficam como estão. */
export function toNeutralLabels(text: string, projectKey: string): string {
  const prefix = `${projectKey}-`;
  let out = "";
  let at = 0;
  for (const match of scanTicketKeys(text)) {
    if (!match.key.startsWith(prefix)) continue;
    const number = match.key.slice(prefix.length);
    if (!/^\d+$/.test(number)) continue;
    out += text.slice(at, match.start) + `T${Number(number)}`;
    at = match.end;
  }
  return out + text.slice(at);
}

/** Os números dos rótulos soltos de um texto, sem repetição, na ordem em que aparecem. */
export function labelNumbers(text: string): number[] {
  return [...new Set(Array.from(text.matchAll(LABEL), (match) => Number(match[1])))];
}

/** Volta: cada `T<número>` solto cujo número é de um ticket que existe vira `CHAVE-<número>`; os demais ficam como vieram. */
export function fromNeutralLabels(text: string, projectKey: string, existing: { has(number: number): boolean }): string {
  return text.replace(LABEL, (all, digits: string) => (existing.has(Number(digits)) ? `${projectKey}-${digits}` : all));
}

import { createHash } from "node:crypto";
import type { BranchSummaryInput } from "./ports.js";

/**
 * Marca do conteúdo de que a IA escreveu um resumo de ramo (ADR 0029): hash do título, do trecho da descrição e dos
 * títulos e resumos dos filhos, na ordem recebida. Desde a ADR 0033 é só registro: nenhum código a compara, e o texto
 * guardado não é refeito quando a marca deixa de bater.
 * JSON delimita os campos, então "ab"+"c" nunca colide com "a"+"bc"; resumo ausente (`null`) difere de vazio.
 */
export function branchContentMark(input: BranchSummaryInput): string {
  const canonical = JSON.stringify([
    input.title,
    input.descriptionExcerpt,
    input.children.map((child) => [child.title, child.summary]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

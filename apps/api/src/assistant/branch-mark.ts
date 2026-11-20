import { createHash } from "node:crypto";
import type { BranchSummaryInput } from "./ports.js";

/**
 * Marca do conteúdo de que um resumo de ramo saiu (ADR 0029): hash do título, do trecho da descrição e dos
 * títulos e resumos dos filhos, na ordem recebida. Quando a marca guardada deixa de bater, o resumo é refeito.
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

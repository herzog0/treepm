/**
 * Fusão por posição de duas listas ordenadas de candidatos (ADR 0053, item 7): a triagem por palavras (`related.ts`) e os
 * vizinhos por vetor. Função pura. A nota de um id é a soma de `1 / (60 + posição)` em cada lista em que aparece (posição
 * começa em 1); quem está numa lista só soma só dela. Empate pela ordem na lista de palavras e, depois, na de vetor.
 *
 * Regra do corte: com a união das duas listas dentro de `limit`, nada some. Com a união maior, o corte é por nota, então as
 * listas dividem o espaço e um candidato só de palavras em posição baixa pode ficar de fora (quanto isso acontece é o que a
 * medição da triagem conta, ADR 0053, item 8).
 */
export const FUSION_RANK_CONSTANT = 60;

export type FusionOrigin = "words" | "vector" | "both";
export type FusedHit = { id: string; score: number; origin: FusionOrigin };

export function fuseRankings(words: readonly string[], vector: readonly string[], limit: number): FusedHit[] {
  if (limit <= 0) return [];
  type Row = { id: string; score: number; wordsAt: number; vectorAt: number };
  const rows = new Map<string, Row>();
  const add = (list: readonly string[], kind: "wordsAt" | "vectorAt"): void => {
    list.forEach((id, index) => {
      const row = rows.get(id) ?? { id, score: 0, wordsAt: Infinity, vectorAt: Infinity };
      // Repetição na mesma lista: vale só a primeira posição.
      if (row[kind] !== Infinity) return;
      row[kind] = index + 1;
      row.score += 1 / (FUSION_RANK_CONSTANT + index + 1);
      rows.set(id, row);
    });
  };
  add(words, "wordsAt");
  add(vector, "vectorAt");
  return [...rows.values()]
    .sort((a, b) => b.score - a.score || a.wordsAt - b.wordsAt || a.vectorAt - b.vectorAt)
    .slice(0, limit)
    .map((row) => ({ id: row.id, score: row.score, origin: row.wordsAt !== Infinity && row.vectorAt !== Infinity ? "both" : row.wordsAt !== Infinity ? "words" : "vector" }));
}

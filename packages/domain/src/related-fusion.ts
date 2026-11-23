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

/**
 * Fusão por intercalação (ADR 0053, ajuste depois da medição): alterna um de cada lista, começando pelas palavras (palavras 1,
 * vetor 1, palavras 2, vetor 2…), pulando quem já entrou, até `limit`. Quando uma lista acaba, segue com a outra. Ao contrário
 * da soma de posições, quem está nas duas listas não passa à frente de quem está numa só: o 4º achado das palavras fica, no
 * pior caso, no 7º lugar. `score` só existe para manter a forma de `FusedHit`: decresce com a posição na saída.
 */
export function interleaveRankings(words: readonly string[], vector: readonly string[], limit: number): FusedHit[] {
  if (limit <= 0) return [];
  const inWords = new Set(words);
  const inVector = new Set(vector);
  const seen = new Set<string>();
  const out: FusedHit[] = [];
  let w = 0;
  let v = 0;
  const take = (list: readonly string[], at: number): number => {
    let next = at;
    while (next < list.length && seen.has(list[next] as string)) next += 1;
    if (next < list.length) {
      const id = list[next] as string;
      seen.add(id);
      out.push({ id, score: 0, origin: inWords.has(id) && inVector.has(id) ? "both" : inWords.has(id) ? "words" : "vector" });
      next += 1;
    }
    return next;
  };
  while (out.length < limit && (w < words.length || v < vector.length)) {
    w = take(words, w);
    if (out.length >= limit) break;
    v = take(vector, v);
  }
  return out.map((hit, index) => ({ ...hit, score: 1 / (index + 1) }));
}

/** A regra de fusão escolhida por `SEMANTIC_TRIAGE` (`off` não funde: o vetor chega vazio). */
export type FusionRule = "rrf" | "interleave";

export function fuseBy(rule: FusionRule, words: readonly string[], vector: readonly string[], limit: number): FusedHit[] {
  return rule === "interleave" ? interleaveRankings(words, vector, limit) : fuseRankings(words, vector, limit);
}

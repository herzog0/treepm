/**
 * Os casos que amarram o domínio ao banco no nome de etiqueta (TREEPM-466, revisão E1, item 1). A MESMA lista é conferida contra
 * `labelNameRefused` (teste do domínio) e contra os CHECKs `project_labels_name_check` e `project_labels_name_key_check` da migration
 * 0048, gravando `name` e `labelNameKey(name)` (teste de banco em `apps/api/test/label-name-cases.test.ts`): se um dos dois mudar sem o
 * outro, um dos testes quebra. `refused`: o banco recusaria este nome guardado como está (e por isso `cleanLabelName` nunca o devolve).
 */
const FDFA = "\ufdfa"; // \ufdfa: um ponto de código que a NFKC expande em 18.

export const LABEL_NAME_CASES: readonly { name: string; refused: boolean }[] = [
  // O banco aceita.
  { name: "Bug", refused: false },
  { name: "Bug crítico", refused: false },
  { name: "Café", refused: false },
  { name: "Ｂｕｇ", refused: false },
  { name: "🐛".repeat(60), refused: false },
  { name: "x".repeat(60), refused: false },
  { name: "a  b", refused: false },
  // 13 × 18 = 234 pontos de código na chave: ainda cabe nos 240.
  { name: FDFA.repeat(13), refused: false },
  { name: `abcdef${FDFA.repeat(13)}`, refused: false },
  // A chave passa de 240.
  { name: FDFA.repeat(14), refused: true },
  { name: `abcdefg${FDFA.repeat(13)}`, refused: true },
  { name: FDFA.repeat(60), refused: true },
  // Tamanho, pontas e controle.
  { name: "", refused: true },
  { name: "x".repeat(61), refused: true },
  { name: " Bug", refused: true },
  { name: "Bug ", refused: true },
  { name: "a\nb", refused: true },
  { name: "a\tb", refused: true },
  { name: "a\u0085b", refused: true },
  { name: "a\u2028b", refused: true },
  { name: "a\u2029b", refused: true },
  // Formato invisível e controle de direção.
  { name: "bug\u200b", refused: true },
  { name: "b\u00adug", refused: true },
  { name: "\u2060", refused: true },
  { name: "a\u200cb", refused: true },
  { name: "a\u200db", refused: true },
  { name: "a\u200eb", refused: true },
  { name: "a\u200fb", refused: true },
  { name: "a\u202ab", refused: true },
  { name: "a\u202eb", refused: true },
  { name: "a\u2066b", refused: true },
  { name: "a\u2069b", refused: true },
  { name: "a\ufeffb", refused: true },
];

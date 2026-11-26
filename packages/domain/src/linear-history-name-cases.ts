/**
 * Os casos que amarram o domínio ao banco no nome de autor do histórico do Linear (TREEPM-482, revisão H1, item 1). A MESMA lista é
 * conferida contra `linearHistoryNameRefused` (teste do domínio) e contra o CHECK `external_actor_name NOT LIKE '%@%.%'` da migration 0046
 * (teste de banco em `apps/api/test/linear-history-names.test.ts`): se um dos dois mudar sem o outro, um dos testes quebra.
 * `refused`: o banco recusaria este nome (e por isso a importação o grava sem nome).
 */
export const LINEAR_HISTORY_NAME_CASES: readonly { name: string; refused: boolean }[] = [
  // Os quatro da revisão: não têm forma de e-mail para `looksLikeEmail`, mas o CHECK os recusa.
  { name: "Ana @ Acme Inc.", refused: true },
  { name: "@joao.silva", refused: true },
  { name: "Suporte @ v2.0", refused: true },
  { name: "Sentry @ app.io", refused: true },
  // E-mail de verdade e variações.
  { name: "ana@exemplo.com", refused: true },
  { name: "a@b.c", refused: true },
  { name: "@.", refused: true },
  { name: "x@y.", refused: true },
  { name: "Robô @ Sentinela.io", refused: true },
  { name: "Ana @ Acme @ Inc.", refused: true },
  // O banco aceita: sem `@`, ou sem `.` DEPOIS do `@`.
  { name: "Ana", refused: false },
  { name: "Ana Maria", refused: false },
  { name: "Dr. Ana", refused: false },
  { name: "Dr. Ana @ casa", refused: false },
  { name: "@joao", refused: false },
  { name: "ana.@", refused: false },
  { name: "50% @ x_y", refused: false },
  { name: "Ângela Ñandú 😀", refused: false },
];

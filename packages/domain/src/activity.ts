/** Janela de junção das edições seguidas da descrição (ADR 0040): menos de 10 minutos entre uma e a seguinte. */
export const DESCRIPTION_MERGE_WINDOW_MS = 10 * 60_000;

/** O que a junção precisa saber de uma entrada de atividade; o resto da entrada passa intacto. */
export interface MergeableEntry {
  readonly type: string;
  /** Quem fez; `null` quando não há pessoa (nunca junta). */
  readonly actorId: string | null;
  /** Instante em milissegundos. */
  readonly occurredAt: number;
  /** A contribuição a que a entrada se refere (ADR 0041); só `contribution_text_changed` usa, e sem ela nunca junta. */
  readonly contributionId?: string | null;
}

/** Uma entrada do resultado: `entry` é a mais nova do grupo (dá o instante); `oldest` é a mais antiga (dá a identidade e a posição). */
export interface MergedEntry<T extends MergeableEntry> {
  readonly entry: T;
  readonly oldest: T;
}

/**
 * Junta edições seguidas da descrição (ou do texto da mesma contribuição, ADR 0041) pela mesma pessoa. A lista vem da mais nova para a mais antiga.
 * Duas entradas vizinhas se juntam quando as duas são `description_changed` (ou `contribution_text_changed` da mesma contribuição), têm a mesma pessoa e a mais nova
 * está a MENOS de 10 minutos da mais antiga; a distância é sempre entre vizinhas, não desde o começo do grupo,
 * e qualquer outra entrada no meio desfaz a sequência. A decisão depende só do par de vizinhas, então
 * cortar a lista entre dois grupos já fechados dá o mesmo resultado que juntar a lista inteira.
 */
export function mergeDescriptionEdits<T extends MergeableEntry>(newestFirst: readonly T[]): MergedEntry<T>[] {
  const merged: { entry: T; oldest: T }[] = [];
  for (const item of newestFirst) {
    const last = merged[merged.length - 1];
    if (last && joins(last.oldest, item)) last.oldest = item;
    else merged.push({ entry: item, oldest: item });
  }
  return merged;
}

/** Edições de texto que se juntam: as da descrição do ticket e as do texto de uma contribuição (ADR 0041), nunca entre si. */
function sameEditedText(newer: MergeableEntry, older: MergeableEntry): boolean {
  if (newer.type !== older.type) return false;
  if (newer.type === "description_changed") return true;
  return newer.type === "contribution_text_changed" && !!newer.contributionId && newer.contributionId === older.contributionId;
}

function joins(newer: MergeableEntry, older: MergeableEntry): boolean {
  return (
    sameEditedText(newer, older) &&
    newer.actorId !== null &&
    newer.actorId === older.actorId &&
    newer.occurredAt - older.occurredAt < DESCRIPTION_MERGE_WINDOW_MS
  );
}

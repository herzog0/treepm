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
  /** A rodada de sincronização do Linear (`comments_imported`, `relations_imported`, `history_imported`): os eventos da mesma rodada, gravados um por página, viram uma entrada. */
  readonly runId?: string | null;
  /** Quantos comentários, relações ou registros do histórico o evento trouxe (`comments_imported`, `relations_imported`, `history_imported`). */
  readonly count?: number;
}

/** Uma entrada do resultado: `entry` é a mais nova do grupo (dá o instante); `oldest` é a mais antiga (dá a identidade e a posição). */
export interface MergedEntry<T extends MergeableEntry> {
  readonly entry: T;
  readonly oldest: T;
  /** `comments_imported`, `relations_imported` e `history_imported`: a soma das contagens do grupo. */
  readonly count?: number;
}

/**
 * Junta edições seguidas da descrição (ou do texto da mesma contribuição, ADR 0041) pela mesma pessoa. A lista vem da mais nova para a mais antiga.
 * Duas entradas vizinhas se juntam quando as duas são `description_changed` (ou `contribution_text_changed` da mesma contribuição), têm a mesma pessoa e a mais nova
 * está a MENOS de 10 minutos da mais antiga; a distância é sempre entre vizinhas, não desde o começo do grupo,
 * e qualquer outra entrada no meio desfaz a sequência. A decisão depende só do par de vizinhas, então
 * cortar a lista entre dois grupos já fechados dá o mesmo resultado que juntar a lista inteira.
 */
export function mergeDescriptionEdits<T extends MergeableEntry>(newestFirst: readonly T[]): MergedEntry<T>[] {
  const merged: { entry: T; oldest: T; count?: number }[] = [];
  for (const item of newestFirst) {
    const last = merged[merged.length - 1];
    if (last && sameImportRun(last.oldest, item)) {
      last.oldest = item;
      last.count = (last.count ?? 0) + (item.count ?? 0);
    } else if (last && joins(last.oldest, item)) last.oldest = item;
    else merged.push(isImportCount(item.type) ? { entry: item, oldest: item, count: item.count ?? 0 } : { entry: item, oldest: item });
  }
  return merged;
}

/** Edições de texto que se juntam: as da descrição do ticket e as do texto de uma contribuição (ADR 0041), nunca entre si. */
function sameEditedText(newer: MergeableEntry, older: MergeableEntry): boolean {
  if (newer.type !== older.type) return false;
  if (newer.type === "description_changed") return true;
  return newer.type === "contribution_text_changed" && !!newer.contributionId && newer.contributionId === older.contributionId;
}

/** Entradas de contagem trazida do Linear numa rodada: comentários (fatia 2), relações (fatia 3) e registros do histórico (fatia 4). */
const isImportCount = (type: string): boolean => type === "comments_imported" || type === "relations_imported" || type === "history_imported";

/**
 * Comentários ou relações trazidos do Linear na mesma rodada (C2, item 6): vizinhos do MESMO tipo, qualquer que seja a distância. Sem
 * rodada, nunca; comentários e relações nunca se juntam.
 */
function sameImportRun(newer: MergeableEntry, older: MergeableEntry): boolean {
  return isImportCount(newer.type) && newer.type === older.type && !!newer.runId && newer.runId === older.runId;
}

function joins(newer: MergeableEntry, older: MergeableEntry): boolean {
  return (
    sameEditedText(newer, older) &&
    newer.actorId !== null &&
    newer.actorId === older.actorId &&
    newer.occurredAt - older.occurredAt < DESCRIPTION_MERGE_WINDOW_MS
  );
}

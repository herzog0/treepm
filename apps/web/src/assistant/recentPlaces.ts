/** Quantos lugares recentes a web guarda por organização, projeto e pessoa (TREEPM-358). */
export const MAX_RECENT = 8;

/** Os tickets em que a pessoa esteve agora há pouco (ADR 0054, adendo). Só ids, só neste navegador. */
export interface RecentPlaces {
  /** Do mais recente ao mais antigo; vazio quando não há nada ou o armazenamento não responde. */
  read: (projectId: string) => string[];
  /** Põe o ticket na frente da lista, sem repetir. Não faz nada quando o armazenamento não responde. */
  record: (projectId: string, ticketId: string) => void;
}

export const noRecentPlaces: RecentPlaces = { read: () => [], record: () => undefined };

const keyOf = (orgId: string, projectId: string, personId: string) => `treepm.recent.${orgId}.${projectId}.${personId}`;

/** `localStorage` pode faltar, lançar ou vir vazio (janela privada, dados bloqueados): a tela funciona igual sem ele. */
function readIds(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const entry of parsed) if (typeof entry === "string" && !ids.includes(entry)) ids.push(entry);
    return ids.slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function createRecentPlaces(orgId: string, personId: string): RecentPlaces {
  return {
    read: (projectId) => readIds(keyOf(orgId, projectId, personId)),
    record: (projectId, ticketId) => {
      const key = keyOf(orgId, projectId, personId);
      const next = [ticketId, ...readIds(key).filter((id) => id !== ticketId)].slice(0, MAX_RECENT);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* sem armazenamento: o lugar recente simplesmente não fica */
      }
    },
  };
}

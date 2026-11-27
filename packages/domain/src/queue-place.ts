import { ideaRootsOf, isFinished } from "./tickets.js";
import type { TicketNode } from "./tickets.js";

/**
 * O tipo de "depende de" (ADR 0068, seção 3): `start` ("para começar") segura o começo do trabalho; `deliver` ("para entregar") deixa
 * começar e só segura a conclusão.
 */
export const DEPENDENCY_NEEDS = ["start", "deliver"] as const;
export type DependencyNeed = (typeof DEPENDENCY_NEEDS)[number];

/** Uma dependência: `from` depende de `to`, do tipo `need`. */
export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly need: DependencyNeed;
}

/**
 * O lugar na fila (ADR 0068, seção 4): `free` (livre: as dependências para começar estão todas concluídas ou canceladas), `next`
 * (próximo: tem dependência para começar aberta, e todas as abertas são tickets livres) e `waiting` (esperando: os demais).
 */
export const QUEUE_PLACES = ["free", "next", "waiting"] as const;
export type QueuePlace = (typeof QUEUE_PLACES)[number];

/**
 * O lugar na fila de cada ticket aberto, sem filhos e que não é ideia (ADR 0068, seção 4); os outros tickets não entram no mapa.
 * "Sem filhos" é sem filho que não seja ideia (a mesma conta da situação do pai, seção 2). Um alvo só é "livre" quando ELE tem lugar na
 * fila e esse lugar é livre (decisão da coordenação na revisão 1): alvo com filhos ou ideia (raiz ou dentro dela) não tem lugar, então
 * quem depende dele para começar fica esperando. Dependência para entregar não conta. A regra também existe em SQL (`ticket-reads.ts`, `queuePlaceSql`); o teste `sql-oracle`
 * garante que concordam: quem mudar uma muda a outra.
 */
export function queuePlaces(tickets: readonly TicketNode[], dependencies: readonly DependencyEdge[]): Map<string, QueuePlace> {
  const statusOf = new Map(tickets.map((ticket) => [ticket.id, ticket.status] as const));
  const isOpen = (id: string): boolean => {
    const status = statusOf.get(id);
    return status !== undefined && !isFinished(status);
  };
  const openStart = new Map<string, string[]>();
  for (const edge of dependencies) {
    if (edge.need !== "start" || !isOpen(edge.to)) continue;
    const list = openStart.get(edge.from);
    if (list) list.push(edge.to);
    else openStart.set(edge.from, [edge.to]);
  }
  const hasChildren = new Set<string>();
  for (const ticket of tickets) if (ticket.parentId !== null && (ticket.ideaStage ?? null) === null) hasChildren.add(ticket.parentId);
  const inIdea = ideaRootsOf(tickets);
  const hasPlace = (id: string): boolean => isOpen(id) && !hasChildren.has(id) && !inIdea.has(id);
  const isFree = (id: string): boolean => hasPlace(id) && (openStart.get(id) ?? []).length === 0;
  const places = new Map<string, QueuePlace>();
  for (const ticket of tickets) {
    if (!hasPlace(ticket.id)) continue;
    const open = openStart.get(ticket.id) ?? [];
    places.set(ticket.id, open.length === 0 ? "free" : open.every(isFree) ? "next" : "waiting");
  }
  return places;
}

/** Tamanho máximo do motivo de um impedimento (ADR 0068, seção 5), em caracteres; o banco confere o mesmo limite. */
export const IMPEDIMENT_REASON_MAX = 1000;

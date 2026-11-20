import type { PlacementTarget, TicketSummary } from "../api/client.js";
import { ancestorsOf } from "../ticket/tree.js";

/** Onde o ticket novo entra: filho de `parentId` (`null` = raiz do projeto), com o caminho de títulos até ele. */
export type Destination = PlacementTarget;

/** Destino sob o ticket `parentId` (ou a raiz), com o caminho montado a partir dos tickets do projeto. */
export function destinationUnder(list: readonly TicketSummary[], parentId: string | null): Destination {
  if (parentId === null) return { parentId: null, path: [] };
  const ticket = list.find((entry) => entry.id === parentId);
  if (!ticket) return { parentId, path: [] };
  return { parentId, path: [...ancestorsOf(list, ticket), ticket].map((entry) => ({ id: entry.id, title: entry.title })) };
}

/** O pai do destino; a raiz do projeto não tem nível acima. */
export function oneLevelUp(destination: Destination): Destination | null {
  if (destination.parentId === null) return null;
  const path = destination.path.slice(0, -1);
  return { parentId: path.at(-1)?.id ?? null, path };
}

export const destinationLabel = (destination: Destination): string =>
  destination.path.length === 0 ? "Raiz do projeto" : destination.path.map((step) => step.title).join(" › ");

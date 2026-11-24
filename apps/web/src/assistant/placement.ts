import type { TFunction } from "i18next";
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

export const destinationLabel = (t: TFunction<"assistant">, destination: Destination): string =>
  destination.path.length === 0 ? t("path.root") : destination.path.map((step) => step.title).join(" › ");

/** Quantos lugares recentes a pergunta mostra. */
export const MAX_RECENT_SHOWN = 3;

/** Um lugar oferecido na pergunta: o ticket, com o caminho até ele (ele incluído). */
export interface PlaceChoice {
  id: string;
  title: string;
  path: readonly { id: string; title: string }[];
}

/**
 * Os lugares recentes que entram na pergunta (TREEPM-358): vivos na lista do projeto (nem cancelados nem ideias), dentro do nó da
 * pergunta (na raiz, em qualquer lugar do projeto) e do escopo, e que não são o próprio nó nem uma das opções do servidor.
 */
export function recentChoices(
  list: readonly TicketSummary[],
  recentIds: readonly string[],
  question: { at: { id: string | null }; options: readonly { id: string }[] },
  scopeId: string | null,
): PlaceChoice[] {
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const taken = new Set([question.at.id, ...question.options.map((option) => option.id)]);
  const choices: PlaceChoice[] = [];
  for (const id of recentIds) {
    const ticket = byId.get(id);
    if (!ticket || taken.has(id)) continue;
    const path = [...ancestorsOf(list, ticket), ticket];
    // O servidor tira a subárvore inteira de um ticket cancelado ou de uma ideia: um ancestral assim também tira o recente.
    if (path.some((step) => step.status === "cancelled" || step.idea != null)) continue;
    if (question.at.id !== null && !path.slice(0, -1).some((step) => step.id === question.at.id)) continue;
    if (scopeId !== null && !path.some((step) => step.id === scopeId)) continue;
    choices.push({ id, title: ticket.title, path: path.map((step) => ({ id: step.id, title: step.title })) });
    if (choices.length === MAX_RECENT_SHOWN) break;
  }
  return choices;
}

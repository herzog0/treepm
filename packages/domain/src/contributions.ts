import type { Actor } from "./index.js";
import { canEditTicket } from "./tickets.js";

/** As situações de uma contribuição de área (ADR 0041); informativas, nunca mudam a situação do ticket. */
export const CONTRIBUTION_STATUSES = ["todo", "in_progress", "done"] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

/** O texto de uma contribuição tem de 0 a 20.000 caracteres (mesmo limite da descrição do ticket). */
export const CONTRIBUTION_TEXT_MAX = 20_000;

export function isContributionText(text: string): boolean {
  return text.length <= CONTRIBUTION_TEXT_MAX;
}

/** Mexe nas contribuições quem pode editar o ticket (ADR 0041): gestor, colaborador e administrador da organização. */
export function canEditContributions(actor: Actor, projectId: string): boolean {
  return canEditTicket(actor, projectId);
}

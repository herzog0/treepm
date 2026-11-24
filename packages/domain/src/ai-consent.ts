import type { Actor } from "./index.js";

/**
 * Versão do que a organização aceita (ADR 0039). Enquanto o texto dos documentos é rascunho vale `rascunho-3`; quando o
 * texto aprovado for publicado a constante muda e todo aceite dado ao rascunho deixa de valer.
 */
export const AI_CONSENT_VERSION = "rascunho-3";

/** `assistant`: texto de tickets e de conversas vai à Anthropic e à TypeSafe, e título e descrição de tickets vão à Voyage AI (vetores da busca por significado, ADR 0053). `code_reading`: trechos de código vão à Anthropic. */
export const AI_CONSENT_KINDS = ["assistant", "code_reading"] as const;
export type AiConsentKind = (typeof AI_CONSENT_KINDS)[number];

/** Onde os dois documentos públicos ficam no site. */
export const AI_CONSENT_PATHS = { terms: "/termos", privacy: "/privacidade" } as const;

/** O que basta saber de uma linha de aceite para dizer se ela vale. */
export type AiConsentRecord = { version: string; withdrawnAt: Date | null };

/** Em vigor: existe, não foi retirado e é da versão atual dos documentos. */
export function isAiConsentInForce(record: AiConsentRecord | null | undefined): boolean {
  return record != null && record.withdrawnAt === null && record.version === AI_CONSENT_VERSION;
}

/** Allows organization admins (the same rule as the MCP switch) to give and withdraw the AI consents (ADR 0039). */
export function canManageAiConsent(actor: Actor): boolean {
  return actor.clerkRole === "admin";
}

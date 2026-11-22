import { ForbiddenException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { isAiConsentInForce } from "@treepm/domain";
import type { AiConsentKind } from "@treepm/domain";

/**
 * Conferência do aceite da organização para a IA (ADR 0039). Funções puras sobre a transação do tenant, sem Nest: a API
 * (`AssistantGate`) e as ferramentas de linha de comando usam as mesmas. Nunca grava nada.
 */

async function inForce(tx: Pick<TenantClient, "organizationConsent">, orgId: string, kind: AiConsentKind): Promise<boolean> {
  // A linha aberta (não retirada) é a única que pode valer; ela vale se for da versão atual dos documentos.
  const row = await tx.organizationConsent.findFirst({
    where: { orgId, kind, withdrawnAt: null },
    select: { documentVersion: true, withdrawnAt: true },
  });
  return row !== null && isAiConsentInForce({ version: row.documentVersion, withdrawnAt: row.withdrawnAt });
}

/** O aceite `assistant` está em vigor: texto de tickets e de conversas pode ir à Anthropic e à TypeSafe. */
export function assistantConsentInForce(tx: Pick<TenantClient, "organizationConsent">, orgId: string): Promise<boolean> {
  return inForce(tx, orgId, "assistant");
}

/** A leitura de código vale só com os dois aceites em vigor (o segundo depende do primeiro). */
export async function codeReadingConsentInForce(tx: Pick<TenantClient, "organizationConsent">, orgId: string): Promise<boolean> {
  return (await inForce(tx, orgId, "assistant")) && (await inForce(tx, orgId, "code_reading"));
}

export async function requireAssistantConsent(tx: Pick<TenantClient, "organizationConsent">, orgId: string): Promise<void> {
  if (!(await assistantConsentInForce(tx, orgId))) {
    throw new ForbiddenException({
      code: "assistant_consent_required",
      message: "Um administrador da organização precisa aceitar o uso do assistente de IA em Configurações.",
    });
  }
}

/** Ainda sem consumidor: a leitura de código pela IA é o TREEPM-82. */
export async function requireCodeReadingConsent(tx: Pick<TenantClient, "organizationConsent">, orgId: string): Promise<void> {
  if (!(await codeReadingConsentInForce(tx, orgId))) {
    throw new ForbiddenException({
      code: "code_reading_consent_required",
      message: "Um administrador da organização precisa aceitar a leitura de código pela IA em Configurações.",
    });
  }
}

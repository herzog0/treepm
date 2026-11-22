import { createPrismaClient, withTenant } from "@treepm/db";
import { assistantConsentInForce } from "../../src/ai-consent/consent-check.js";
import type { AppConfig } from "../../src/config.js";

/**
 * As ferramentas que leem tickets de uma organização e chamam provedor de IA conferem o aceite `assistant` dessa
 * organização (ADR 0039) antes de qualquer leitura ou chamada, e recusam sem ele. Só lê o banco; nunca grava aceite.
 */
export async function requireAssistantConsentOfOrg(config: AppConfig, orgId: string): Promise<void> {
  const prisma = createPrismaClient(config.DATABASE_URL);
  try {
    const inForce = await withTenant(prisma, { orgId, userId: "placement-rebuild" }, (tx) => assistantConsentInForce(tx, orgId));
    if (!inForce) {
      throw new Error(
        `A organização ${orgId} não tem o aceite do assistente de IA em vigor (ADR 0039). Um administrador precisa aceitar em Configurações > IA e privacidade; esta ferramenta não aceita em nome de ninguém e nada foi enviado a provedor.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

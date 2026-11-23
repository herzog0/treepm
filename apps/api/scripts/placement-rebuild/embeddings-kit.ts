import { VoyageEmbeddingProvider } from "../../src/assistant/voyage-embedding-provider.js";
import type { EmbeddingProvider } from "../../src/assistant/ports.js";
import { createPrismaClient, withTenant } from "@treepm/db";
import { loadConfig } from "../../src/config.js";
import type { AppConfig } from "../../src/config.js";
import type { EmbeddingStore } from "../../src/assistant/ticket-embeddings.js";
import { FakeEmbeddingProvider } from "./fakes.js";

/** O provedor de vetores da ferramenta: o falso (ensaio), o da Voyage (com `VOYAGE_API_KEY`) ou nenhum. Nunca lê `.env*`: a chave vem da configuração do processo. */
export function embeddingProviderFor(config: AppConfig, fake: boolean): EmbeddingProvider | null {
  if (fake) return new FakeEmbeddingProvider();
  return config.VOYAGE_API_KEY ? new VoyageEmbeddingProvider({ apiKey: config.VOYAGE_API_KEY, timeoutMs: 30_000 }) : null;
}

/**
 * O provedor falso nunca sobrescreve vetor de verdade: se o projeto tem alguma linha de `ticket_embeddings` de modelo diferente de
 * `fake`, a ferramenta recusa ANTES de gravar qualquer coisa. Só números e o nome do modelo na mensagem.
 */
export async function refuseFakeOverReal(store: EmbeddingStore, projectId: string): Promise<void> {
  const real = await store.run(async (tx) => (await tx.$queryRaw<{ n: number }[]>`select count(*)::int as n from ticket_embeddings where project_id = ${projectId}::uuid and model <> 'fake'`)[0]?.n ?? 0);
  if (real > 0) throw new Error(`Recusado: o projeto já tem ${real} vetores de um modelo de verdade; o provedor falso (--fake-providers) os sobrescreveria. Nada foi gravado. Use um projeto de ensaio.`);
}

/** A mesma recusa para comandos que falam com a API (a conferência do aceite já passou): abre o banco só para contar. */
export async function refuseFakeOverRealOfOrg(org: string, user: string, projectId: string): Promise<void> {
  const prisma = createPrismaClient(loadConfig(process.env).DATABASE_URL);
  try {
    await refuseFakeOverReal({ run: (fn) => withTenant(prisma, { orgId: org, userId: user }, (tx) => fn(tx, org)) }, projectId);
  } finally {
    await prisma.$disconnect();
  }
}

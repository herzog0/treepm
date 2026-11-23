import { createPrismaClient, withTenant } from "@treepm/db";
import { EMBEDDING_MODEL } from "../../src/assistant/ports.js";
import { loadConfig } from "../../src/config.js";
import { requireAssistantConsentOfOrg } from "./consent.js";
import { embeddingProviderFor, refuseFakeOverReal } from "./embeddings-kit.js";
import type { CliOptions } from "./core.js";
import { EMBEDDING_SYNC_MAX, embeddingPlan, embeddingStatus, loadEmbeddableTickets, syncEmbeddings } from "../../src/assistant/ticket-embeddings.js";
import type { EmbeddingStore } from "../../src/assistant/ticket-embeddings.js";
import type { EmbeddingProvider } from "../../src/assistant/ports.js";

/** Prazo de cada lote da reindexação (a requisição da API usa 4 s; a ferramenta local pode esperar mais). */
const REINDEX_DEADLINE_MS = 60_000;

export type EmbeddingsContext = {
  store: EmbeddingStore;
  projectId: string;
  /** `null` sem `VOYAGE_API_KEY` (e sem `--fake-providers`): só o `--dry-run` e o status funcionam. */
  provider: EmbeddingProvider | null;
  dryRun: boolean;
  /** O modelo contra o qual o estado e o plano são calculados (`fake` no ensaio, o da Voyage no resto). */
  model: string;
  log: (line: string) => void;
  /** Tickets por lote da reindexação; só os testes trocam. */
  max?: number;
};

/** `embeddings-status`: só números. Nenhum texto de ticket, nenhum provedor. */
export async function embeddingsStatusCommand(ctx: EmbeddingsContext): Promise<number> {
  const status = await ctx.store.run((tx) => embeddingStatus(tx, ctx.projectId, ctx.model));
  ctx.log(`vivos: ${status.live}`);
  ctx.log(`em dia: ${status.upToDate}`);
  ctx.log(`desatualizados: ${status.outdated}`);
  ctx.log(`faltando: ${status.missing}`);
  return 0;
}

/**
 * `embeddings-reindex`: põe o projeto inteiro em dia, em lotes, imprimindo só números. Com `--dry-run` não toca no provedor:
 * diz quantos textos e quantos caracteres iriam.
 */
export async function embeddingsReindexCommand(ctx: EmbeddingsContext): Promise<number> {
  if (ctx.dryRun) {
    const plan = await ctx.store.run((tx) => embeddingPlan(tx, ctx.projectId, ctx.model));
    ctx.log(`dry-run: iriam ${plan.texts} textos, ${plan.chars} caracteres; nada foi enviado`);
    return 0;
  }
  const provider = ctx.provider;
  if (provider !== null && provider.model === "fake") await refuseFakeOverReal(ctx.store, ctx.projectId);
  if (provider === null) throw new Error("A reindexação precisa de VOYAGE_API_KEY (ou de --fake-providers, só para ensaio). Nada foi enviado.");
  const tickets = await ctx.store.run((tx) => loadEmbeddableTickets(tx, ctx.projectId));
  ctx.log(`vivos: ${tickets.length}`);
  for (let batch = 1; ; batch += 1) {
    const result = await syncEmbeddings(ctx.store, { projectId: ctx.projectId, tickets, provider, max: ctx.max ?? EMBEDDING_SYNC_MAX, deadlineMs: REINDEX_DEADLINE_MS });
    ctx.log(`lote ${batch}: em dia ao começar: ${result.upToDate}, gravados: ${result.embedded}, pendentes: ${result.pending}, ms: ${result.ms}`);
    if (result.failure !== undefined) {
      ctx.log(`falha: ${result.failure}; o que já foi gravado fica e a ferramenta pode ser rodada de novo`);
      return 1;
    }
    if (result.pending === 0) return 0;
    // Sem falha e sem progresso, mas com pendentes: nada mais a fazer agora; sai com erro.
    if (result.embedded === 0) return 1;
  }
}

/** O que o `runEmbeddingsCommand` troca nos testes: o provedor, o registro de saída e um aviso de que o banco foi aberto. */
export type EmbeddingsRunDeps = {
  log: (line: string) => void;
  providerFor?: typeof embeddingProviderFor;
  onConnect?: () => void;
};

/**
 * `embeddings-status` e `embeddings-reindex` (ADR 0053): leem tickets de verdade e o segundo os manda à Voyage, então a
 * conferência do aceite da organização vem ANTES de abrir o banco ou criar o provedor. Falam com o banco direto, sem subir a
 * API. Devolve o código de saída: 0, ou 1 quando o reindex termina com falha ou com pendentes.
 */
export async function runEmbeddingsCommand(command: "embeddings-status" | "embeddings-reindex", options: CliOptions, deps: EmbeddingsRunDeps): Promise<number> {
  const config = loadConfig(process.env);
  await requireAssistantConsentOfOrg(config, options.org as string);
  const orgId = options.org as string;
  deps.onConnect?.();
  const prisma = createPrismaClient(config.DATABASE_URL);
  try {
    const fake = options.fakeProviders ?? false;
    const dryRun = options.dryRun ?? false;
    const provider = command === "embeddings-reindex" && !dryRun ? (deps.providerFor ?? embeddingProviderFor)(config, fake) : null;
    const ctx: EmbeddingsContext = {
      store: { run: (fn) => withTenant(prisma, { orgId, userId: options.user as string }, (tx) => fn(tx, orgId)) },
      projectId: options.project as string,
      provider,
      dryRun,
      model: provider?.model ?? (fake ? "fake" : EMBEDDING_MODEL),
      log: deps.log,
    };
    return command === "embeddings-status" ? await embeddingsStatusCommand(ctx) : await embeddingsReindexCommand(ctx);
  } finally {
    await prisma.$disconnect();
  }
}

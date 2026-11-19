import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";
import type { Prisma } from "./generated/client.js";

export { PrismaClient } from "./generated/client.js";
export type { Prisma } from "./generated/client.js";
export * from "./generated/enums.js";

export type TenantContext = {
  /** ID da Clerk Organization, vindo do token verificado. */
  orgId: string;
  /** ID do usuário Clerk (`sub`), vindo do token verificado. */
  userId: string;
};

export type TenantClient = Prisma.TransactionClient;

/**
 * Cria o cliente com a conexão da API (papel `treepm_app`, com pool).
 * Sem `connectionString`, lê `DATABASE_URL`.
 */
export function createPrismaClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL não está definida.");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/**
 * Executa `fn` em UMA transação interativa cujo contexto de tenant é aplicado
 * antes de qualquer outra instrução (ADR 0021). `set_config(..., true)` vale só
 * até o fim da transação, portanto é seguro atrás de PgBouncer em modo transação.
 * Valores sempre parametrizados, nunca interpolados.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  context: TenantContext,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!context.orgId || !context.userId) {
    throw new Error("withTenant exige orgId e userId não vazios.");
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`select set_config('app.org_id', ${context.orgId}, true), set_config('app.user_id', ${context.userId}, true)`;
    return fn(tx);
  });
}

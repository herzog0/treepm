import { AsyncLocalStorage } from "node:async_hooks";
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
 * Prazo da transação interativa do tenant (ADR 0045, revisão 1). O padrão do Prisma 7 é 5 s, igual à espera pela trava de estrutura
 * de então; quem esperava quase todo o prazo ficava sem orçamento e a transação fechava no meio. Agora a espera é de 3 s e o prazo, de 15 s. Fica em um objeto para
 * os testes reduzirem os prazos; o valor de produção é o definido aqui.
 */
export const tenantTransaction = { timeoutMs: 15_000 };

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
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`select set_config('app.org_id', ${context.orgId}, true), set_config('app.user_id', ${context.userId}, true)`;
      const changed = new Set<string>();
      const result = await changedProjects.run(changed, () => fn(tx));
      await touchChangedProjects(tx, changed);
      return result;
    },
    { timeout: tenantTransaction.timeoutMs },
  );
}

/** Os projetos que a transação em andamento marcou como mudados (ADR 0046); um conjunto por `withTenant`. */
const changedProjects = new AsyncLocalStorage<Set<string>>();

/**
 * Marca o projeto como mudado na transação corrente: a versão da lista de tickets (`projects.updated_at`, ADR 0046) é tocada UMA
 * vez, como o ÚLTIMO comando antes de confirmar, e só se a transação não falhar. Assim a linha do projeto fica travada apenas entre
 * esse comando e o commit, e as escritas de ticket não esperam umas pelas outras. Só vale dentro de `withTenant`: fora dele lança
 * (um toque esquecido deixaria o mapa velho, em silêncio).
 */
export function markProjectChanged(projectId: string): void {
  const changed = changedProjects.getStore();
  if (changed === undefined) throw new Error("markProjectChanged fora de withTenant: a versão do projeto não seria tocada.");
  changed.add(projectId);
}

/**
 * `tickets_version + 1`: um contador, sem relógio (nunca repete nem recua). As linhas são travadas em ordem de id (duas transações com mais de um projeto não se cruzam).
 */
async function touchChangedProjects(tx: TenantClient, changed: ReadonlySet<string>): Promise<void> {
  if (changed.size === 0) return;
  const ids = [...changed].sort();
  await tx.$executeRaw`
    with locked as (select org_id, id from projects where id = any(${ids}::uuid[]) order by id for update)
    update projects p set tickets_version = p.tickets_version + 1
    from locked where p.org_id = locked.org_id and p.id = locked.id`;
}

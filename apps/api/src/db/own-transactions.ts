import { createParamDecorator, SetMetadata } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";

export const OWN_TRANSACTIONS = "treepm:own-transactions";
export const TENANT_RUNNER_KEY = "treepm:tenant-runner";

/**
 * Executor de transações curtas com o contexto de tenant (ADR 0021). Cada `run` abre uma transação nova,
 * aplica `app.org_id`/`app.user_id` e entrega o `Principal` RECARREGADO nela: o papel é lido de novo a
 * cada transação, então uma escrita que vem depois de uma chamada longa confere a permissão atual, não a
 * de antes da chamada.
 */
export interface TenantRunner {
  run<T>(fn: (tx: TenantClient, principal: Principal) => Promise<T>): Promise<T>;
}

/**
 * Declara que a rota NÃO roda inteira na transação do interceptor (ADR 0029): ela recebe um
 * `TenantRunner` (`@Tenant()`) e abre transações curtas ao redor da chamada a um provedor externo.
 * Sem esta marca, o comportamento da rota é o de sempre (ADR 0021). `@Tx()` não existe nelas.
 */
export const OwnTransactions = (): MethodDecorator => SetMetadata(OWN_TRANSACTIONS, true);

export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantRunner => {
  const request = context.switchToHttp().getRequest<Record<string, unknown>>();
  const runner = request[TENANT_RUNNER_KEY] as TenantRunner | undefined;
  if (!runner) throw new Error("Rota sem @OwnTransactions() ou pública.");
  return runner;
});

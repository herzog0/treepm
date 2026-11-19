import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";

export const TX_KEY = "treepm:tx";

/**
 * Entrega ao handler o cliente TRANSACIONAL do tenant. É a única forma de um
 * controller alcançar o banco: o `PrismaClient` cru não é exportado.
 */
export const Tx = createParamDecorator((_data: unknown, context: ExecutionContext): TenantClient => {
  const request = context.switchToHttp().getRequest<Record<string, unknown>>();
  const tx = request[TX_KEY] as TenantClient | undefined;
  if (!tx) throw new Error("Rota sem transação de tenant (rota pública?).");
  return tx;
});

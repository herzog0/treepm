import { Inject, Injectable } from "@nestjs/common";
import { withTenant } from "@treepm/db";
import type { PrismaClient, TenantClient, TenantContext } from "@treepm/db";
import { PRISMA } from "./prisma.provider.js";

/**
 * Abre uma transação do tenant fora do ciclo de uma requisição com sessão (ADR 0021), para as entradas que não
 * passam pelo interceptor: hoje, a resolução de um token de acesso (ADR 0038). Cada `run` é uma transação curta.
 */
@Injectable()
export class TenantTransactions {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  run<T>(context: TenantContext, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, context, fn);
  }
}

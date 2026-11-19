import { Inject, Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { from, lastValueFrom } from "rxjs";
import type { Observable } from "rxjs";
import { SESSION_KEY } from "../auth/auth.guard.js";
import type { RequestWithSession } from "../auth/auth.guard.js";
import { PRISMA } from "./prisma.provider.js";
import { TX_KEY } from "./tx.decorator.js";

/**
 * Envolve CADA requisição autenticada em `withTenant` (ADR 0021). O handler
 * inteiro roda dentro da transação; qualquer erro faz rollback.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithSession & Record<string, unknown>>();
    const session = request[SESSION_KEY];
    if (!session) return next.handle(); // rota pública: sem tenant, sem transação.

    return from(
      withTenant(this.prisma, { orgId: session.orgId, userId: session.userId }, async (tx) => {
        request[TX_KEY] = tx;
        return lastValueFrom(next.handle(), { defaultValue: undefined });
      }),
    );
  }
}

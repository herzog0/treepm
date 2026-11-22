import { Inject, Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { withTenant } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import { from, lastValueFrom } from "rxjs";
import type { Observable } from "rxjs";
import { AuthorizationService } from "../access/authorization.service.js";
import { IdentityService } from "../access/identity.service.js";
import type { Identity } from "../access/identity.service.js";
import { PRINCIPAL_KEY, REFRESH_IDENTITY } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { PrincipalService } from "../access/principal.service.js";
import { SESSION_KEY } from "../auth/auth.guard.js";
import type { AuthenticatedSession, RequestWithSession } from "../auth/auth.guard.js";
import { OWN_TRANSACTIONS, TENANT_RUNNER_KEY } from "./own-transactions.js";
import type { TenantRunner } from "./own-transactions.js";
import { PRISMA } from "./prisma.provider.js";
import { TX_KEY } from "./tx.decorator.js";

type Request = RequestWithSession & Record<string, unknown>;

/**
 * Envolve CADA requisição autenticada em `withTenant` (ADR 0021); o handler
 * inteiro roda dentro da transação e qualquer erro faz rollback.
 *
 * A consulta ao Clerk (rede) acontece ANTES da transação: o diretório só é
 * lido no primeiro acesso, quando o papel mudou, ou em rotas `@RefreshIdentity()`.
 *
 * Rotas `@OwnTransactions()` (ADR 0029) não rodam dentro da transação: o interceptor só resolve o
 * `Principal` numa transação curta e entrega um `TenantRunner` para o handler abrir as suas.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(PrincipalService) private readonly principals: PrincipalService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const session = request[SESSION_KEY];
    if (!session) return next.handle(); // rota pública: sem tenant, sem transação.

    const refresh = this.reflector.getAllAndOverride<boolean | undefined>(REFRESH_IDENTITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const own = this.reflector.get<boolean | undefined>(OWN_TRANSACTIONS, context.getHandler());
    return from(this.run(request, session, Boolean(refresh), Boolean(own), next));
  }

  private async run(
    request: Request,
    session: AuthenticatedSession,
    refresh: boolean,
    own: boolean,
    next: CallHandler,
  ): Promise<unknown> {
    const clerkRole = this.identities.clerkRoleOf(session);
    const tenant = { orgId: session.orgId, userId: session.userId };

    let identity: Identity | null = null;
    if (refresh || !(await withTenant(this.prisma, tenant, (tx) => this.identities.isCurrent(tx, session, clerkRole)))) {
      identity = await this.identities.fetch(session); // fora de qualquer transação.
    }

    if (own) {
      // Transação curta só para provisionar e montar o Principal; o handler abre as dele.
      const principal = await withTenant(this.prisma, tenant, (tx) => this.principals.load(tx, session, clerkRole, identity));
      request[PRINCIPAL_KEY] = principal;
      request[TENANT_RUNNER_KEY] = this.runner(tenant, principal);
      return lastValueFrom(next.handle(), { defaultValue: undefined });
    }

    return withTenant(this.prisma, tenant, async (tx) => {
      request[TX_KEY] = tx;
      request[PRINCIPAL_KEY] = await this.principals.load(tx, session, clerkRole, identity);
      return lastValueFrom(next.handle(), { defaultValue: undefined });
    });
  }

  private runner(tenant: { orgId: string; userId: string }, principal: Principal): TenantRunner {
    return {
      run: (fn) =>
        withTenant(this.prisma, tenant, async (tx) => {
          const actor = await this.authorization.loadActor(tx, principal.person.id, principal.actor.clerkRole);
          return fn(tx, { ...principal, actor });
        }),
    };
  }
}

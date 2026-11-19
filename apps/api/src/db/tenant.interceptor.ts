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
import { SESSION_KEY } from "../auth/auth.guard.js";
import type { AuthenticatedSession, RequestWithSession } from "../auth/auth.guard.js";
import { PRISMA } from "./prisma.provider.js";
import { TX_KEY } from "./tx.decorator.js";

type Request = RequestWithSession & Record<string, unknown>;

/**
 * Envolve CADA requisição autenticada em `withTenant` (ADR 0021); o handler
 * inteiro roda dentro da transação e qualquer erro faz rollback.
 *
 * A consulta ao Clerk (rede) acontece ANTES da transação: o diretório só é
 * lido no primeiro acesso, quando o papel mudou, ou em rotas `@RefreshIdentity()`.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const session = request[SESSION_KEY];
    if (!session) return next.handle(); // rota pública: sem tenant, sem transação.

    const refresh = this.reflector.getAllAndOverride<boolean | undefined>(REFRESH_IDENTITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return from(this.run(request, session, Boolean(refresh), next));
  }

  private async run(
    request: Request,
    session: AuthenticatedSession,
    refresh: boolean,
    next: CallHandler,
  ): Promise<unknown> {
    const clerkRole = this.identities.clerkRoleOf(session);
    const tenant = { orgId: session.orgId, userId: session.userId };

    let identity: Identity | null = null;
    if (refresh || !(await withTenant(this.prisma, tenant, (tx) => this.identities.isCurrent(tx, session, clerkRole)))) {
      identity = await this.identities.fetch(session); // fora de qualquer transação.
    }

    return withTenant(this.prisma, tenant, async (tx) => {
      const { person, organization } = await this.identities.provision(tx, session, clerkRole, identity);
      const actor = await this.authorization.loadActor(tx, person.id, clerkRole);
      request[TX_KEY] = tx;
      request[PRINCIPAL_KEY] = { session, person, organization, actor };
      return lastValueFrom(next.handle(), { defaultValue: undefined });
    });
  }
}

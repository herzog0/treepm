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
import { withStructureTimeoutTranslation } from "../tickets/structure-lock.js";
import { STRUCTURE_QUEUE, structureKey, withStructureSlot } from "../tickets/structure-queue.js";
import type { StructureRoute } from "../tickets/structure-queue.js";

type Request = RequestWithSession & Record<string, unknown>;

/**
 * Envolve CADA requisição autenticada em `withTenant` (ADR 0021); o handler
 * inteiro roda dentro da transação e qualquer erro faz rollback.
 *
 * A consulta ao Clerk (rede) acontece ANTES da transação: o diretório só é
 * lido no primeiro acesso, quando o papel mudou, ou em rotas `@RefreshIdentity()`.
 *
 * Rotas `@QueuesStructure()` (ADR 0045, adendo 1) esperam numa fila em memória ANTES de a transação abrir, para quem muda a estrutura
 * não ocupar conexões do pool enquanto espera a trava do projeto.
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
    const queue = this.reflector.get<StructureRoute | undefined>(STRUCTURE_QUEUE, context.getHandler());
    if (queue !== undefined && own) {
      // Defeito de programação: a rota abre as próprias transações, então a fila seria ignorada em silêncio.
      throw new Error("@QueuesStructure não vale em rota @OwnTransactions: a fila de estrutura não seria usada.");
    }
    const slot = queue === undefined ? undefined : this.slotFor(queue, request, context);
    return from(this.run(request, session, Boolean(refresh), Boolean(own), next, slot));
  }

  /**
   * O sinal de aborto e a rota da fila de estrutura, ou nada se este pedido não muda a estrutura (a decisão sai da forma do pedido
   * cru, porque os pipes ainda não rodaram). A chave, que pode pedir uma leitura curta, sai em `queueKey`, já dentro de `run`.
   */
  private slotFor(route: StructureRoute, request: Request, context: ExecutionContext): { route: StructureRoute; signal: AbortSignal } | undefined {
    if (route.when !== undefined && !route.when(request["body"])) return undefined;
    const controller = new AbortController();
    const response = context.switchToHttp().getResponse<{ once(event: string, listener: () => void): unknown; writableFinished?: boolean; destroyed?: boolean; socket?: { destroyed?: boolean } | null }>();
    if (response.destroyed === true || response.socket?.destroyed === true) controller.abort(); // o cliente fechou antes de chegarmos aqui
    else {
      response.once("close", () => {
        if (!response.writableFinished) controller.abort(); // requisição abortada: quem ainda espera na fila sai dela
      });
    }
    return { route, signal: controller.signal };
  }

  /**
   * A chave da fila: organização + projeto. Em rota de ticket ou de conversa, o projeto sai de uma leitura curta no contexto da
   * organização (RLS valendo), fora da transação da escrita. Sem projeto (id inválido, ticket que a organização não enxerga): sem fila.
   */
  private async queueKey(route: StructureRoute, request: Request, tenant: { orgId: string; userId: string }): Promise<string | undefined> {
    const params = request["params"] as Record<string, string> | undefined;
    if (route.by === "project") return structureKey(tenant.orgId, params?.["projectId"]);
    const id = params?.["id"];
    if (structureKey(tenant.orgId, id) === undefined) return undefined; // não é um uuid
    const projectId = await withTenant(this.prisma, tenant, async (tx) =>
      route.by === "ticket"
        ? (await tx.ticket.findFirst({ where: { id: id as string }, select: { projectId: true } }))?.projectId
        : (await tx.ticketConversation.findFirst({ where: { id: id as string }, select: { projectId: true } }))?.projectId,
    );
    return structureKey(tenant.orgId, projectId);
  }

  private async run(
    request: Request,
    session: AuthenticatedSession,
    refresh: boolean,
    own: boolean,
    next: CallHandler,
    slot?: { route: StructureRoute; signal: AbortSignal },
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

    const open = (): Promise<unknown> =>
      withStructureTimeoutTranslation((watch) =>
        withTenant(this.prisma, tenant, async (tx) => {
          watch(tx);
          request[TX_KEY] = tx;
          request[PRINCIPAL_KEY] = await this.principals.load(tx, session, clerkRole, identity);
          return lastValueFrom(next.handle(), { defaultValue: undefined });
        }),
      );
    const key = slot === undefined ? undefined : await this.queueKey(slot.route, request, tenant);
    return slot === undefined || key === undefined ? open() : withStructureSlot(key, open, slot.signal);
  }

  private runner(tenant: { orgId: string; userId: string }, principal: Principal): TenantRunner {
    return {
      run: (fn) =>
        withStructureTimeoutTranslation((watch) =>
          withTenant(this.prisma, tenant, async (tx) => {
            watch(tx);
            const actor = await this.authorization.loadActor(tx, principal.person.id, principal.actor.clerkRole);
            return fn(tx, { ...principal, actor });
          }),
        ),
    };
  }
}

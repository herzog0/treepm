import { Inject, Injectable, Logger } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { ClerkRole } from "@treepm/domain";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
import { actAsNotAllowed } from "./act-as.js";
import type { ActAsRequest } from "./act-as.js";
import { AuthorizationService } from "./authorization.service.js";
import { IdentityService } from "./identity.service.js";
import type { Identity } from "./identity.service.js";
import type { Principal } from "./principal.js";

/**
 * Monta o `Principal` de uma pessoa dentro de uma transação do tenant: provisiona (ou lê) organização e pessoa e
 * carrega os papéis do banco. É o caminho único da sessão (interceptor do tenant) e do token de acesso (ADR 0038).
 */
@Injectable()
export class PrincipalService {
  private readonly logger = new Logger("ActAs");

  constructor(
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async load(
    tx: TenantClient,
    session: AuthenticatedSession,
    clerkRole: ClerkRole,
    identity: Identity | null,
    actAs: ActAsRequest = { requested: false },
  ): Promise<Principal> {
    // "Entrar como" (ADR 0057): a conferência do pedido acontece AQUI, uma vez só e antes de qualquer provisionamento, para uma
    // recusa não deixar efeito. A pessoa de verdade tem de já existir e estar ativa (o provisionamento reativaria quem estivesse inativa).
    const requester = actAs.requested ? await this.requireActiveAdmin(tx, session, clerkRole, actAs) : null;
    const { person, organization } = await this.identities.provision(tx, session, clerkRole, identity);
    if (!actAs.requested || requester === null) {
      const actor = await this.authorization.loadActor(tx, person.id, clerkRole);
      return { session, person, organization, actor };
    }
    // O alvo: da mesma organização (a RLS já restringe, e a conferência é explícita), de teste e ativo. Qualquer outra coisa é a mesma recusa.
    const target =
      actAs.personId === null
        ? null
        : await tx.person.findFirst({
            where: { id: actAs.personId, orgId: session.orgId, isTest: true, active: true },
            select: { id: true, displayName: true, email: true, avatarUrl: true },
          });
    if (!target) {
      // O corpo da recusa é um só; o MOTIVO fica só no log do servidor (o sinal de sondagem: pedir para agir como pessoa de verdade).
      let reason = "malformed_header";
      if (actAs.personId !== null) {
        const found = await tx.person.findFirst({ where: { id: actAs.personId, orgId: session.orgId }, select: { isTest: true, active: true } });
        reason = found === null ? "target_not_found" : !found.isTest ? "target_real_person" : "target_inactive";
      }
      throw this.refuse(reason, session, requester?.id ?? null, actAs.personId);
    }
    const actor = await this.authorization.loadActor(tx, target.id, "member");
    return {
      session,
      person: { ...target, clerkRole: "member" },
      organization,
      actor,
      via: { kind: "act-as", realPersonId: person.id, realDisplayName: person.displayName },
    };
  }

  /**
   * Rota com várias transações (`@OwnTransactions`, ADR 0029): a conferência da primeira não vale para as seguintes (a pessoa de teste
   * pode ter sido desativada entre elas). Cada transação reconfere quem pede e o alvo, com a mesma recusa e o mesmo registro.
   */
  async recheckActAs(tx: TenantClient, principal: Principal): Promise<void> {
    const via = principal.via;
    if (via?.kind !== "act-as") return;
    const session = principal.session;
    const request: ActAsRequest = { requested: true, personId: principal.person.id };
    const requester = await tx.person.findFirst({ where: { id: via.realPersonId, orgId: session.orgId, active: true, isTest: false, clerkRole: "admin" }, select: { id: true } });
    if (!requester) throw this.refuse("requester_changed", session, via.realPersonId, request.personId);
    const target = await tx.person.findFirst({ where: { id: principal.person.id, orgId: session.orgId, isTest: true, active: true }, select: { id: true } });
    if (!target) throw this.refuse("target_changed", session, via.realPersonId, request.personId);
  }

  /** A recusa única, com o motivo em código e só ids no log do servidor (nada de nome, e-mail ou conteúdo). */
  private refuse(reason: string, session: AuthenticatedSession, realPersonId: string | null, targetId: string | null): ReturnType<typeof actAsNotAllowed> {
    this.logger.warn(`act-as refused reason=${reason} org=${session.orgId} user=${session.userId} real=${realPersonId ?? "-"} target=${targetId ?? "-"}`);
    return actAsNotAllowed();
  }

  /** Quem pede é administrador de verdade (papel da sessão) e está ativa no banco; senão, a recusa única. */
  private async requireActiveAdmin(tx: TenantClient, session: AuthenticatedSession, clerkRole: ClerkRole, actAs: ActAsRequest): Promise<{ id: string }> {
    const requested = actAs.requested ? actAs.personId : null;
    if (clerkRole !== "admin") throw this.refuse("requester_not_admin", session, null, requested);
    const stored = await tx.person.findUnique({
      where: { orgId_clerkUserId: { orgId: session.orgId, clerkUserId: session.userId } },
      select: { id: true, active: true, isTest: true },
    });
    if (!stored || !stored.active || stored.isTest) throw this.refuse("requester_inactive_or_unknown", session, stored?.id ?? null, requested);
    return { id: stored.id };
  }
}

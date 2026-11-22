import { Inject, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { ClerkRole } from "@treepm/domain";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
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
  constructor(
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async load(tx: TenantClient, session: AuthenticatedSession, clerkRole: ClerkRole, identity: Identity | null): Promise<Principal> {
    const { person, organization } = await this.identities.provision(tx, session, clerkRole, identity);
    const actor = await this.authorization.loadActor(tx, person.id, clerkRole);
    return { session, person, organization, actor };
  }
}

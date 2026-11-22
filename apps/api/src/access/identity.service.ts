import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { ClerkRole } from "@treepm/domain";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
import { DIRECTORY_PROVIDER } from "../auth/directory-provider.js";
import type { DirectoryOrganization, DirectoryProvider, DirectoryUser } from "../auth/directory-provider.js";
import { parseClerkRole } from "./actor.js";

/** Dados de identidade lidos no Clerk; sempre obtidos ANTES de abrir a transação do tenant. */
export type Identity = { user: DirectoryUser; organization: DirectoryOrganization };

export type PersonRecord = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  clerkRole: ClerkRole;
};

export type OrganizationRecord = { orgId: string; name: string; slug: string; mcpEnabled: boolean; mcpWriteEnabled: boolean };

/** Provisionamento idempotente de organização e pessoa (ADR 0022). */
@Injectable()
export class IdentityService {
  constructor(@Inject(DIRECTORY_PROVIDER) private readonly directory: DirectoryProvider) {}

  /** Papel Clerk do token; papéis fora de `admin`/`member` (ADR 0019) não entram. */
  clerkRoleOf(session: AuthenticatedSession): ClerkRole {
    const role = parseClerkRole(session.orgRole);
    if (!role) throw new ForbiddenException("Papel de organização não suportado.");
    return role;
  }

  /** Consulta o Clerk. Não pode ser chamado com a transação do tenant aberta. */
  async fetch(session: AuthenticatedSession): Promise<Identity> {
    const [user, organization] = await Promise.all([
      this.directory.getUser(session.userId),
      this.directory.getOrganization(session.orgId),
    ]);
    return { user, organization };
  }

  /** `true` quando organização e pessoa já existem, ativas e com o papel Clerk atual. */
  async isCurrent(tx: TenantClient, session: AuthenticatedSession, clerkRole: ClerkRole): Promise<boolean> {
    const [organization, person] = await Promise.all([
      tx.organization.findUnique({ where: { orgId: session.orgId }, select: { orgId: true } }),
      tx.person.findUnique({
        where: { orgId_clerkUserId: { orgId: session.orgId, clerkUserId: session.userId } },
        select: { active: true, clerkRole: true },
      }),
    ]);
    return Boolean(organization && person?.active && person.clerkRole === clerkRole);
  }

  /**
   * Garante organização e pessoa na transação. Com `identity`, faz o upsert
   * completo (o mesmo do `/api/me`); sem ele, apenas lê o que já existe.
   */
  async provision(
    tx: TenantClient,
    session: AuthenticatedSession,
    clerkRole: ClerkRole,
    identity: Identity | null,
  ): Promise<{ person: PersonRecord; organization: OrganizationRecord }> {
    const orgId = session.orgId;
    if (identity) {
      const organization = await tx.organization.upsert({
        where: { orgId },
        create: { orgId, name: identity.organization.name, slug: identity.organization.slug },
        update: { name: identity.organization.name, slug: identity.organization.slug },
      });
      const fields = {
        displayName: identity.user.displayName,
        email: identity.user.email,
        avatarUrl: identity.user.avatarUrl,
        clerkRole,
        active: true,
      };
      const person = await tx.person.upsert({
        where: { orgId_clerkUserId: { orgId, clerkUserId: session.userId } },
        create: { orgId, clerkUserId: session.userId, ...fields },
        update: fields,
      });
      return { person, organization };
    }
    const [organization, person] = await Promise.all([
      tx.organization.findUnique({ where: { orgId } }),
      tx.person.findUnique({ where: { orgId_clerkUserId: { orgId, clerkUserId: session.userId } } }),
    ]);
    if (!organization || !person) throw new Error("Pessoa não provisionada: o estado mudou entre as transações.");
    return { person, organization };
  }
}

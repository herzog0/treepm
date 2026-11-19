import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { DIRECTORY_PROVIDER } from "../auth/directory-provider.js";
import type { DirectoryProvider } from "../auth/directory-provider.js";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
import { parseOutput } from "../common/zod.js";
import { buildActor, parseClerkRole } from "./actor.js";
import { meResponseSchema } from "./me.schema.js";
import type { MeResponse } from "./me.schema.js";

@Injectable()
export class MeService {
  constructor(@Inject(DIRECTORY_PROVIDER) private readonly directory: DirectoryProvider) {}

  /** Provisiona de forma idempotente organização e pessoa, na transação do tenant (ADR 0022). */
  async me(tx: TenantClient, session: AuthenticatedSession): Promise<MeResponse> {
    const clerkRole = parseClerkRole(session.orgRole);
    if (!clerkRole) throw new ForbiddenException("Papel de organização não suportado.");

    const [user, org] = await Promise.all([
      this.directory.getUser(session.userId),
      this.directory.getOrganization(session.orgId),
    ]);

    const organization = await tx.organization.upsert({
      where: { orgId: session.orgId },
      create: { orgId: session.orgId, name: org.name, slug: org.slug },
      update: { name: org.name, slug: org.slug },
    });
    const person = await tx.person.upsert({
      where: { orgId_clerkUserId: { orgId: session.orgId, clerkUserId: session.userId } },
      create: {
        orgId: session.orgId,
        clerkUserId: session.userId,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        clerkRole,
        active: true,
      },
      update: {
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        clerkRole,
        active: true,
      },
    });

    const [teams, projects] = await Promise.all([
      tx.teamMembership.findMany({ where: { personId: person.id }, orderBy: { teamId: "asc" } }),
      tx.projectMembership.findMany({ where: { personId: person.id }, orderBy: { projectId: "asc" } }),
    ]);
    const actor = buildActor(
      clerkRole,
      teams.map((row) => ({ teamId: row.teamId, role: row.role })),
      projects.map((row) => ({ projectId: row.projectId, role: row.role })),
    );

    return parseOutput(meResponseSchema, {
      person: {
        id: person.id,
        displayName: person.displayName,
        email: person.email,
        avatarUrl: person.avatarUrl,
      },
      organization: { orgId: organization.orgId, name: organization.name, slug: organization.slug },
      roles: {
        clerk: actor.clerkRole,
        teams: [...actor.teamRoles].map(([teamId, role]) => ({ teamId, role })),
        projects: [...actor.projectRoles].map(([projectId, role]) => ({ projectId, role })),
      },
    });
  }
}

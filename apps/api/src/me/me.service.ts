import { Inject, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";
import { assistantConsentInForce } from "../ai-consent/consent-check.js";
import { parseOutput } from "../common/zod.js";
import { CONFIG, assistantEnabled, githubEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { meResponseSchema } from "./me.schema.js";
import type { MeResponse } from "./me.schema.js";

@Injectable()
export class MeService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /** O provisionamento já ocorreu no interceptor do tenant, antes do handler. */
  async me(tx: TenantClient, { person, organization, actor, via }: Principal): Promise<MeResponse> {
    const configured = assistantEnabled(this.config);
    const consent = await assistantConsentInForce(tx, organization.orgId);
    return parseOutput(meResponseSchema, {
      person: {
        id: person.id,
        displayName: person.displayName,
        email: person.email,
        avatarUrl: person.avatarUrl,
      },
      actingAs: via?.kind === "act-as" ? { realDisplayName: via.realDisplayName } : null,
      organization: { orgId: organization.orgId, name: organization.name, slug: organization.slug },
      assistant: { configured, consent, enabled: configured && consent },
      github: { enabled: githubEnabled(this.config) },
      mcp: { enabled: organization.mcpEnabled, writeEnabled: organization.mcpWriteEnabled, peopleEnabled: organization.mcpPeopleEnabled },
      roles: {
        clerk: actor.clerkRole,
        teams: [...actor.teamRoles].map(([teamId, role]) => ({ teamId, role })),
        projects: [...actor.projectRoles].map(([projectId, role]) => ({ projectId, role })),
      },
    });
  }
}

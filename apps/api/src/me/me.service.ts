import { Injectable } from "@nestjs/common";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import { meResponseSchema } from "./me.schema.js";
import type { MeResponse } from "./me.schema.js";

@Injectable()
export class MeService {
  /** O provisionamento já ocorreu no interceptor do tenant, antes do handler. */
  me({ person, organization, actor }: Principal): MeResponse {
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

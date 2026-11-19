import { Controller, Get, Inject } from "@nestjs/common";
import { z } from "zod";
import type { TenantClient } from "@treepm/db";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";

const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  clerkRole: z.enum(["admin", "member"]),
  active: z.boolean(),
});
const peopleSchema = z.array(personSchema);

@Controller("people")
export class PeopleController {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  @Get()
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<z.output<typeof peopleSchema>> {
    this.authorization.viewDirectory(principal.actor);
    const people = await tx.person.findMany({ orderBy: [{ displayName: "asc" }, { id: "asc" }] });
    return parseOutput(peopleSchema, people);
  }
}

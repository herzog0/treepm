import { Controller, Get, Inject } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
import { Tx } from "../db/tx.decorator.js";
import { MeService } from "./me.service.js";
import type { MeResponse } from "./me.schema.js";
import { Session } from "./session.decorator.js";

@Controller("me")
export class MeController {
  constructor(@Inject(MeService) private readonly service: MeService) {}

  @Get()
  me(@Tx() tx: TenantClient, @Session() session: AuthenticatedSession): Promise<MeResponse> {
    return this.service.me(tx, session);
  }
}

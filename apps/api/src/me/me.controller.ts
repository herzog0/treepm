import { Controller, Get, Inject } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal, RefreshIdentity } from "../access/principal.js";
import { Tx } from "../db/tx.decorator.js";
import type { Principal } from "../access/principal.js";
import { MeService } from "./me.service.js";
import type { MeResponse } from "./me.schema.js";

@Controller("me")
export class MeController {
  constructor(@Inject(MeService) private readonly service: MeService) {}

  /** Sempre relê o Clerk (fora da transação) para refletir nome, e-mail e organização. */
  @Get()
  @RefreshIdentity()
  me(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    return this.service.me(tx, principal);
  }
}

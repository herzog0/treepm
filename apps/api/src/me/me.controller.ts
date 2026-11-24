import { Controller, Get, Inject, Logger } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal, RefreshIdentity } from "../access/principal.js";
import { Tx } from "../db/tx.decorator.js";
import type { Principal } from "../access/principal.js";
import { MeService } from "./me.service.js";
import type { MeResponse } from "./me.schema.js";

@Controller("me")
export class MeController {
  private readonly logger = new Logger("ActAs");

  constructor(@Inject(MeService) private readonly service: MeService) {}

  /** Sempre relê o Clerk (fora da transação) para refletir nome, e-mail e organização. */
  @Get()
  @RefreshIdentity()
  me(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    // Uma linha por início de uso do "entrar como" (a rota de identidade é lida ao entrar e ao recarregar): só os dois ids.
    if (principal.via?.kind === "act-as") this.logger.log(`act-as real=${principal.via.realPersonId} as=${principal.person.id}`);
    return this.service.me(tx, principal);
  }
}

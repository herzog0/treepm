import { Controller, Get, Inject } from "@nestjs/common";
import { CurrentPrincipal, RefreshIdentity } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { MeService } from "./me.service.js";
import type { MeResponse } from "./me.schema.js";

@Controller("me")
export class MeController {
  constructor(@Inject(MeService) private readonly service: MeService) {}

  /** Sempre relê o Clerk (fora da transação) para refletir nome, e-mail e organização. */
  @Get()
  @RefreshIdentity()
  me(@CurrentPrincipal() principal: Principal): MeResponse {
    return this.service.me(principal);
  }
}

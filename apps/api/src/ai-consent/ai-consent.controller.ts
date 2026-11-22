import { Body, Controller, Delete, Get, Inject, Param, Put } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ZodPipe } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { AiConsentService } from "./ai-consent.service.js";
import { acceptConsentSchema, consentKindSchema } from "./ai-consent.schema.js";
import type { ConsentState } from "./ai-consent.schema.js";

/** "IA e privacidade" nas configurações da organização (ADR 0039). Todas as respostas trazem o estado inteiro. */
@Controller("organization/ai-consent")
export class AiConsentController {
  constructor(@Inject(AiConsentService) private readonly service: AiConsentService) {}

  @Get()
  state(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<ConsentState> {
    return this.service.state(tx, principal.organization.orgId);
  }

  @Put(":kind")
  accept(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("kind", new ZodPipe(consentKindSchema)) kind: z.output<typeof consentKindSchema>,
    @Body(new ZodPipe(acceptConsentSchema)) body: z.output<typeof acceptConsentSchema>,
  ): Promise<ConsentState> {
    return this.service.accept(tx, principal, kind, body.version);
  }

  @Delete(":kind")
  withdraw(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("kind", new ZodPipe(consentKindSchema)) kind: z.output<typeof consentKindSchema>,
  ): Promise<ConsentState> {
    return this.service.withdraw(tx, principal, kind);
  }
}

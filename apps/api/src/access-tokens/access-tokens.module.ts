import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { AccessTokenManager } from "./access-token-manager.js";
import { AccessTokenService } from "./access-token.service.js";
import { AccessTokensController, OrganizationController } from "./access-tokens.controller.js";
import { ACCESS_TOKEN_CLOCK, systemClock } from "./clock.js";

/** Tokens de acesso por pessoa e projeto (ADR 0038, fatia 1). O endereço MCP usa o `AccessTokenService`. */
@Module({
  imports: [AccessModule, AuthModule, DbModule],
  controllers: [OrganizationController, AccessTokensController],
  providers: [ActivityService, AccessTokenManager, AccessTokenService, { provide: ACCESS_TOKEN_CLOCK, useValue: systemClock }],
  exports: [AccessTokenService, ACCESS_TOKEN_CLOCK],
})
export class AccessTokensModule {}

import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AuthorizationService } from "./authorization.service.js";
import { IdentityService } from "./identity.service.js";
import { PrincipalService } from "./principal.service.js";

@Module({
  imports: [AuthModule],
  providers: [IdentityService, AuthorizationService, PrincipalService],
  exports: [IdentityService, AuthorizationService, PrincipalService],
})
export class AccessModule {}

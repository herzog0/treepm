import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { AuthorizationService } from "./authorization.service.js";
import { IdentityService } from "./identity.service.js";

@Module({
  imports: [AuthModule],
  providers: [IdentityService, AuthorizationService],
  exports: [IdentityService, AuthorizationService],
})
export class AccessModule {}

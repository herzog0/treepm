import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ACCESS_TOKEN_CLOCK, systemClock } from "../access-tokens/clock.js";
import { ProjectQueryService } from "./project-query.service.js";

@Module({
  imports: [AccessModule],
  providers: [{ provide: ACCESS_TOKEN_CLOCK, useValue: systemClock }, ProjectQueryService],
  exports: [ProjectQueryService],
})
export class QueryModule {}

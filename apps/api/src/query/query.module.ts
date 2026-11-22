import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ProjectQueryService } from "./project-query.service.js";

@Module({
  imports: [AccessModule],
  providers: [ProjectQueryService],
  exports: [ProjectQueryService],
})
export class QueryModule {}

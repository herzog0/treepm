import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { TicketsService } from "./tickets.service.js";

@Module({
  imports: [AccessModule],
  providers: [ActivityService, TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}

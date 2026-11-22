import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { TicketActivityService } from "./ticket-activity.service.js";
import { TicketCommentsService } from "./ticket-comments.service.js";
import { TicketsService } from "./tickets.service.js";

@Module({
  imports: [AccessModule],
  providers: [ActivityService, TicketsService, TicketActivityService, TicketCommentsService],
  exports: [TicketsService, TicketActivityService, TicketCommentsService],
})
export class TicketsModule {}

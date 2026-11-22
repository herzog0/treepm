import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { TicketActivityService } from "./ticket-activity.service.js";
import { TicketCommentsService } from "./ticket-comments.service.js";
import { TicketContributionsService } from "./ticket-contributions.service.js";
import { TicketsService } from "./tickets.service.js";

@Module({
  imports: [AccessModule],
  providers: [ActivityService, TicketsService, TicketActivityService, TicketCommentsService, TicketContributionsService],
  exports: [TicketsService, TicketActivityService, TicketCommentsService, TicketContributionsService],
})
export class TicketsModule {}

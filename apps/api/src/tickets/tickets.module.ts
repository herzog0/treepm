import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { ACCESS_TOKEN_CLOCK, systemClock } from "../access-tokens/clock.js";
import { AgentWorkService } from "./agent-work.service.js";
import { IdeasService } from "./ideas.service.js";
import { TicketActivityService } from "./ticket-activity.service.js";
import { TicketCommentsService } from "./ticket-comments.service.js";
import { TicketContributionsService } from "./ticket-contributions.service.js";
import { TicketsService } from "./tickets.service.js";

@Module({
  imports: [AccessModule],
  providers: [{ provide: ACCESS_TOKEN_CLOCK, useValue: systemClock }, ActivityService, AgentWorkService, TicketsService, IdeasService, TicketActivityService, TicketCommentsService, TicketContributionsService],
  exports: [AgentWorkService, TicketsService, IdeasService, TicketActivityService, TicketCommentsService, TicketContributionsService],
})
export class TicketsModule {}

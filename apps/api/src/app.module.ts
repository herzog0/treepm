import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AccessModule } from "./access/access.module.js";
import { AiConsentModule } from "./ai-consent/ai-consent.module.js";
import { AccessTokensModule } from "./access-tokens/access-tokens.module.js";
import { ActivityService } from "./activity/activity.service.js";
import { AreasController } from "./areas/areas.controller.js";
import { AssistantModule } from "./assistant/assistant.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ErrorFilter } from "./common/error.filter.js";
import { ConfigModule } from "./config.module.js";
import { DbModule } from "./db/db.module.js";
import { GithubModule } from "./github/github.module.js";
import { HealthController } from "./health.controller.js";
import { LinearModule } from "./linear/linear.module.js";
import { McpModule } from "./mcp/mcp.module.js";
import { MeController } from "./me/me.controller.js";
import { MeService } from "./me/me.service.js";
import { QueryModule } from "./query/query.module.js";
import { PeopleController } from "./people/people.controller.js";
import { ProjectsController } from "./projects/projects.controller.js";
import { TicketsModule } from "./tickets/tickets.module.js";
import { IdeasController } from "./tickets/ideas.controller.js";
import { TicketCommentsController } from "./tickets/ticket-comments.controller.js";
import { TicketContributionsController } from "./tickets/ticket-contributions.controller.js";
import { TicketsController } from "./tickets/tickets.controller.js";
import { TeamsController } from "./teams/teams.controller.js";

@Module({
  imports: [ConfigModule, AuthModule, AccessModule, DbModule, TicketsModule, AssistantModule, GithubModule, QueryModule, AccessTokensModule, McpModule, AiConsentModule, LinearModule],
  controllers: [
    HealthController,
    MeController,
    PeopleController,
    TeamsController,
    AreasController,
    ProjectsController,
    TicketsController,
    IdeasController,
    TicketCommentsController,
    TicketContributionsController,
  ],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }, MeService, ActivityService],
})
export class AppModule {}

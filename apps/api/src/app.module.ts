import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AccessModule } from "./access/access.module.js";
import { ActivityService } from "./activity/activity.service.js";
import { AreasController } from "./areas/areas.controller.js";
import { AuthModule } from "./auth/auth.module.js";
import { ErrorFilter } from "./common/error.filter.js";
import { ConfigModule } from "./config.module.js";
import { DbModule } from "./db/db.module.js";
import { HealthController } from "./health.controller.js";
import { MeController } from "./me/me.controller.js";
import { MeService } from "./me/me.service.js";
import { PeopleController } from "./people/people.controller.js";
import { ProjectsController } from "./projects/projects.controller.js";
import { TicketsController } from "./tickets/tickets.controller.js";
import { TeamsController } from "./teams/teams.controller.js";

@Module({
  imports: [ConfigModule, AuthModule, AccessModule, DbModule],
  controllers: [
    HealthController,
    MeController,
    PeopleController,
    TeamsController,
    AreasController,
    ProjectsController,
    TicketsController,
  ],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }, MeService, ActivityService],
})
export class AppModule {}

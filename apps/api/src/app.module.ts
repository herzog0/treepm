import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module.js";
import { ErrorFilter } from "./common/error.filter.js";
import { ConfigModule } from "./config.module.js";
import { DbModule } from "./db/db.module.js";
import { HealthController } from "./health.controller.js";
import { MeController } from "./me/me.controller.js";
import { MeService } from "./me/me.service.js";

@Module({
  imports: [ConfigModule, AuthModule, DbModule],
  controllers: [HealthController, MeController],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    MeService,
  ],
})
export class AppModule {}

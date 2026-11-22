import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { AiConsentController } from "./ai-consent.controller.js";
import { AiConsentService } from "./ai-consent.service.js";

/** Aceite da organização para a IA (ADR 0039): as rotas de Configurações e o serviço que a API inteira usa para conferir. */
@Module({
  imports: [AccessModule],
  controllers: [AiConsentController],
  providers: [ActivityService, AiConsentService],
  exports: [AiConsentService],
})
export class AiConsentModule {}

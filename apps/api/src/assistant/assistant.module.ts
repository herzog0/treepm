import Anthropic from "@anthropic-ai/sdk";
import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { ClaudeConversationProvider, sdkStreamer } from "./claude-conversation-provider.js";
import { TicketConversationsController } from "./conversations.controller.js";
import { CONVERSATION_PROVIDER } from "./ports.js";

@Module({
  imports: [AccessModule],
  controllers: [TicketConversationsController],
  providers: [
    {
      provide: CONVERSATION_PROVIDER,
      inject: [CONFIG],
      // Sem as duas chaves a IA fica desligada e não existe provedor (a API sobe normalmente).
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeConversationProvider(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
  ],
})
export class AssistantModule {}

import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { ClaudeConversationProvider, sdkStreamer } from "./claude-conversation-provider.js";
import { TicketConversationsController } from "./conversations.controller.js";
import { TicketsModule } from "../tickets/tickets.module.js";
import { ClaudeBranchSummarizer } from "./claude-branch-summarizer.js";
import { JevBranchJudge, sdkSystemOne } from "./jev-branch-judge.js";
import { PlacementService } from "./placement.service.js";
import { BRANCH_JUDGE, BRANCH_SUMMARIZER, CONVERSATION_PROVIDER } from "./ports.js";

@Module({
  imports: [AccessModule, TicketsModule],
  controllers: [TicketConversationsController],
  providers: [
    PlacementService,
    {
      provide: CONVERSATION_PROVIDER,
      inject: [CONFIG],
      // Sem as duas chaves a IA fica desligada e não existe provedor (a API sobe normalmente).
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeConversationProvider(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
    {
      provide: BRANCH_SUMMARIZER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeBranchSummarizer(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
    {
      provide: BRANCH_JUDGE,
      inject: [CONFIG],
      // A chave vem da configuração da API (não do ambiente do processo); sem repetição automática além de uma.
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.TYPESAFE_API_KEY
          ? new JevBranchJudge(sdkSystemOne(new TypeSafeClient({ apiKey: config.TYPESAFE_API_KEY, logLevel: "off" })))
          : null,
    },
  ],
})
export class AssistantModule {}

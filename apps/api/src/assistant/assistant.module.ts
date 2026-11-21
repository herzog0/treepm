import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { ClaudeConversationProvider, sdkStreamer } from "./claude-conversation-provider.js";
import { BranchSummaryController } from "./branch-summary.controller.js";
import { TicketConversationsController } from "./conversations.controller.js";
import { TicketsModule } from "../tickets/tickets.module.js";
import { ClaudeBranchSummarizer } from "./claude-branch-summarizer.js";
import { ClaudeGroupNamer } from "./claude-group-namer.js";
import { JevAffinityJudge } from "./jev-affinity-judge.js";
import { JevBranchJudge, sdkSystemOne } from "./jev-branch-judge.js";
import { PlacementService } from "./placement.service.js";
import { AFFINITY_JUDGE, BRANCH_JUDGE, BRANCH_SUMMARIZER, CONVERSATION_PROVIDER, GROUP_NAMER, PLACEMENT_TIMEOUTS } from "./ports.js";

@Module({
  imports: [AccessModule, TicketsModule],
  controllers: [TicketConversationsController, BranchSummaryController],
  providers: [
    ActivityService,
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
    {
      provide: AFFINITY_JUDGE,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.TYPESAFE_API_KEY
          ? new JevAffinityJudge(sdkSystemOne(new TypeSafeClient({ apiKey: config.TYPESAFE_API_KEY, logLevel: "off" })))
          : null,
    },
    {
      provide: GROUP_NAMER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeGroupNamer(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
    // Os prazos da ADR (30 s a descida, 20 s a proposta) valem quando nada os troca; os testes trocam.
    { provide: PLACEMENT_TIMEOUTS, useValue: {} },
  ],
})
export class AssistantModule {}

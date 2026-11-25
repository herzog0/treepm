import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AccessTokensModule } from "../access-tokens/access-tokens.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { AssistantGate } from "./assistant-gate.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { ClaudeConversationProvider, sdkStreamer } from "./claude-conversation-provider.js";
import { BranchSummaryController } from "./branch-summary.controller.js";
import { TicketConversationsController } from "./conversations.controller.js";
import { QueryModule } from "../query/query.module.js";
import { TicketsModule } from "../tickets/tickets.module.js";
import { ClaudeBranchSummarizer } from "./claude-branch-summarizer.js";
import { ClaudeChatProvider } from "./claude-chat-provider.js";
import { ConversationAccess } from "./conversation-access.js";
import { ConversationController } from "./conversation.controller.js";
import { ConversationService } from "./conversation.service.js";
import { ClaudeDescriptionWriter } from "./claude-description-writer.js";
import { DescriptionDraftController } from "./description-draft.controller.js";
import { ClaudeGroupNamer } from "./claude-group-namer.js";
import { ClaudeTicketElaborator } from "./claude-ticket-elaborator.js";
import { JevAffinityJudge } from "./jev-affinity-judge.js";
import { JevBranchJudge, sdkSystemOne } from "./jev-branch-judge.js";
import { JevRelatedJudge } from "./jev-related-judge.js";
import { VoyageEmbeddingProvider } from "./voyage-embedding-provider.js";
import { PlacementService } from "./placement.service.js";
import { CreationThreads } from "./creation-threads.js";
import { TicketDraftService } from "./ticket-draft.service.js";
import { AFFINITY_JUDGE, BRANCH_JUDGE, BRANCH_SUMMARIZER, CHAT_PROVIDER, CONVERSATION_PROVIDER, DESCRIPTION_WRITER, EMBEDDING_PROVIDER, GROUP_NAMER, PLACEMENT_TIMEOUTS, RELATED_JUDGE, TICKET_ELABORATOR } from "./ports.js";

@Module({
  imports: [AccessModule, AccessTokensModule, TicketsModule, QueryModule],
  controllers: [TicketConversationsController, BranchSummaryController, DescriptionDraftController, ConversationController],
  providers: [
    ActivityService,
    PlacementService,
    TicketDraftService,
    CreationThreads,
    ConversationAccess,
    ConversationService,
    AssistantGate,
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
      provide: RELATED_JUDGE,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.TYPESAFE_API_KEY
          ? new JevRelatedJudge(sdkSystemOne(new TypeSafeClient({ apiKey: config.TYPESAFE_API_KEY, logLevel: "off" })))
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
    {
      provide: DESCRIPTION_WRITER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeDescriptionWriter(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
    {
      provide: CHAT_PROVIDER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeChatProvider(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
    {
      provide: TICKET_ELABORATOR,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        assistantEnabled(config) && config.ANTHROPIC_API_KEY
          ? new ClaudeTicketElaborator(sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0 })))
          : null,
    },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [CONFIG],
      // Sem `VOYAGE_API_KEY` não há provedor de vetores, e o assistente continua configurado (ADR 0053).
      useFactory: (config: AppConfig) => (assistantEnabled(config) && config.VOYAGE_API_KEY ? new VoyageEmbeddingProvider({ apiKey: config.VOYAGE_API_KEY }) : null),
    },
    // Os prazos da ADR (30 s a descida, 20 s a proposta) valem quando nada os troca; os testes trocam.
    { provide: PLACEMENT_TIMEOUTS, useValue: {} },
  ],
  exports: [AssistantGate, PlacementService, ConversationService],
})
export class AssistantModule {}

import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";
import { requireAssistantConsent } from "../ai-consent/consent-check.js";
import { CONFIG, assistantEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import type { TenantRunner } from "../db/own-transactions.js";
import {
  AFFINITY_JUDGE,
  BRANCH_JUDGE,
  BRANCH_SUMMARIZER,
  CHAT_PROVIDER,
  CONVERSATION_PROVIDER,
  DESCRIPTION_WRITER,
  EMBEDDING_PROVIDER,
  GROUP_NAMER,
  RELATED_JUDGE,
  TICKET_ELABORATOR,
} from "./ports.js";
import type {
  AffinityJudge,
  BranchJudge,
  BranchSummarizer,
  ChatProvider,
  ConversationProvider,
  DescriptionWriter,
  EmbeddingProvider,
  GroupNamer,
  RelatedJudge,
  TicketElaborator,
} from "./ports.js";
import type { SemanticSettings } from "./semantic-triage.js";
import type { DoubtConfig } from "./placement-doubt.js";

/** Os provedores de IA, entregues só depois de a conferência passar. */
export type AssistantProviders = {
  conversation: ConversationProvider;
  judge: BranchJudge;
  summarizer: BranchSummarizer;
  affinity: AffinityJudge;
  related: RelatedJudge;
  namer: GroupNamer;
  writer: DescriptionWriter;
  chat: ChatProvider;
  elaborator: TicketElaborator;
  /** Vetores da busca por significado (ADR 0053). `null` sem `VOYAGE_API_KEY`: o assistente segue configurado e a busca usa só palavras. */
  embedder: EmbeddingProvider | null;
  /** `SEMANTIC_TRIAGE` e `SEMANTIC_QUERY_KIND`: como as rotas usam os vetores (`off` por padrão). */
  semantic: SemanticSettings;
  /** `PLACEMENT_DOUBT_*`: quando a procura do lugar pergunta (ADR 0054). */
  doubt: DoubtConfig;
};

/**
 * A porta de entrada dos provedores de IA (ADR 0039): é o ÚNICO lugar da API que injeta as portas de `ports.ts`. Quem
 * precisa de um provedor pede aqui e só o recebe depois de, nesta ordem, (1) o assistente estar configurado no servidor
 * (503 `assistant_not_configured`) e (2) a organização da requisição ter o aceite `assistant` em vigor (403
 * `assistant_consent_required`). Nada é lido, montado nem enviado antes disso. Uma função de IA nova nasce pedindo os
 * provedores aqui; um teste falha se alguém injetar uma porta por fora.
 */
@Injectable()
export class AssistantGate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(CONVERSATION_PROVIDER) private readonly conversation: ConversationProvider | null,
    @Optional() @Inject(BRANCH_JUDGE) private readonly judge: BranchJudge | null,
    @Optional() @Inject(BRANCH_SUMMARIZER) private readonly summarizer: BranchSummarizer | null,
    @Optional() @Inject(AFFINITY_JUDGE) private readonly affinity: AffinityJudge | null,
    @Optional() @Inject(RELATED_JUDGE) private readonly related: RelatedJudge | null,
    @Optional() @Inject(GROUP_NAMER) private readonly namer: GroupNamer | null,
    @Optional() @Inject(DESCRIPTION_WRITER) private readonly writer: DescriptionWriter | null,
    @Optional() @Inject(CHAT_PROVIDER) private readonly chat: ChatProvider | null,
    @Optional() @Inject(TICKET_ELABORATOR) private readonly elaborator: TicketElaborator | null,
    @Optional() @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider | null,
  ) {}

  /** Para rota com transação própria (`@OwnTransactions`): o aceite é conferido numa transação curta, antes de tudo. */
  async open(tenant: TenantRunner): Promise<AssistantProviders> {
    const providers = this.configured();
    await tenant.run((tx, principal) => requireAssistantConsent(tx, principal.organization.orgId));
    return providers;
  }

  /** Para rota que já tem a transação da requisição. */
  async openIn(tx: TenantClient, principal: Principal): Promise<AssistantProviders> {
    const providers = this.configured();
    await requireAssistantConsent(tx, principal.organization.orgId);
    return providers;
  }

  private configured(): AssistantProviders {
    const { conversation, judge, summarizer, affinity, related, namer, writer, chat, elaborator } = this;
    if (!assistantEnabled(this.config) || !conversation || !judge || !summarizer || !affinity || !related || !namer || !writer || !chat || !elaborator) {
      throw new ServiceUnavailableException({
        code: "assistant_not_configured",
        message: "O assistente não está configurado neste ambiente.",
      });
    }
    return { conversation, judge, summarizer, affinity, related, namer, writer, chat, elaborator, embedder: this.embedder ?? null, semantic: { mode: this.config.SEMANTIC_TRIAGE, queryKind: this.config.SEMANTIC_QUERY_KIND }, doubt: { low: this.config.PLACEMENT_DOUBT_LOW, high: this.config.PLACEMENT_DOUBT_HIGH, choice: this.config.PLACEMENT_DOUBT_CHOICE } };
  }
}

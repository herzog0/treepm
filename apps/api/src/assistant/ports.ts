/**
 * Portas dos provedores de IA (ADR 0029). A API só conhece estas interfaces: Claude e Jev entram por
 * adaptadores reais (`ClaudeConversationProvider`, e na Parte 2 os de resumo e de Jev) e por falsos
 * determinísticos nos testes. Nenhum teste automático chama provedor de verdade.
 */

export type TicketDraft = { title: string; description: string };

export type ConversationMessage = { author: "person" | "assistant"; body: string };

/** O histórico termina na mensagem nova da pessoa; `draft` é o rascunho atual (ou ainda não há). */
export type ConversationTurnInput = { history: readonly ConversationMessage[]; draft: TicketDraft | null };

export type ConversationTurn = {
  message: string;
  /** `null` enquanto a IA ainda não tem o que propor; o chamador mantém o rascunho anterior. */
  draft: TicketDraft | null;
  /** A IA considera o rascunho pronto para procurar o lugar na árvore. */
  ready: boolean;
  /** Modelo que produziu esta resposta (pode ser o da alternativa em caso de recusa). */
  model: string;
};

/** Um turno de conversa: dados estruturados, nunca ação. */
export interface ConversationProvider {
  turn(input: ConversationTurnInput): Promise<ConversationTurn>;
}

export const CONVERSATION_PROVIDER = Symbol("CONVERSATION_PROVIDER");

/** Provedor fora do ar, lento demais, ou recusa sem alternativa. Vira 503 `assistant_unavailable`. */
export class AssistantUnavailableError extends Error {
  constructor(
    /** Motivo curto e sem texto do usuário nem do modelo (para log e diagnóstico). */
    readonly reason: string,
  ) {
    super("O assistente não está disponível agora.");
    this.name = "AssistantUnavailableError";
  }
}

// ---- Declaradas para a Parte 2 (sem adaptador real ainda) -------------------------------------------------

/**
 * Agrupador filho direto de um nó, candidato a pai do ticket novo (ADR 0031; ticket nunca é candidato). `summary` é o
 * texto que o juiz vê: o resumo do agrupador quando `hasChildren`, ou o trecho da descrição do agrupador vazio (pode
 * ser vazio).
 */
export type BranchCandidate = { id: string; title: string; summary: string; hasChildren: boolean };

/** Probabilidades devolvidas pelo juiz num nível: `belongs` (Noul) e `choice` por candidato (Choice). */
export type BranchJudgment = { belongs: number; choice: Readonly<Record<string, number>> };

/** Jev: julga, em cada nível, em qual agrupador candidato o rascunho cabe. Quem decide é o código. */
export interface BranchJudge {
  judge(input: {
    draft: TicketDraft;
    current: { title: string; summary: string } | null;
    candidates: readonly BranchCandidate[];
  }, options?: { signal?: AbortSignal }): Promise<BranchJudgment>;
}

export const BRANCH_JUDGE = Symbol("BRANCH_JUDGE");

export type BranchSummaryInput = {
  title: string;
  descriptionExcerpt: string;
  children: readonly { title: string; summary: string | null }[];
};

/** Resume o que um ramo cobre (até 600 caracteres), com o modelo que escreveu. */
export interface BranchSummarizer {
  summarize(input: BranchSummaryInput): Promise<{ summary: string; model: string }>;
}

export const BRANCH_SUMMARIZER = Symbol("BRANCH_SUMMARIZER");

/**
 * Portas dos provedores de IA (ADR 0029). A API só conhece estas interfaces: Claude e Jev entram por
 * adaptadores reais (`ClaudeConversationProvider`, e na Parte 2 os de resumo e de Jev) e por falsos
 * determinísticos nos testes. Nenhum teste automático chama provedor de verdade.
 */

export type TicketDraft = { title: string; description: string };

export type ConversationMessage = { author: "person" | "assistant"; body: string };

/**
 * O histórico termina na mensagem nova da pessoa; `draft` é o rascunho atual (ou ainda não há). `groups` são os títulos
 * dos agrupadores do lugar da procura (ADR 0033): no máximo 30, na ordem do número; só títulos.
 */
export type ConversationTurnInput = { history: readonly ConversationMessage[]; draft: TicketDraft | null; groups: readonly string[] };

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
 * Filho direto de um nó que tem filhos, candidato a pai do ticket novo (ADR 0034; o sem filhos só é candidato na
 * segunda fatia). `summary` é o texto que o juiz vê (ADR 0033): o texto guardado de quem tem filhos (escrito pela IA ou
 * pela pessoa); o ticket sem filhos (escopo) vai com o trecho da descrição (pode ser vazio).
 */
export type BranchCandidate = { id: string; title: string; summary: string; hasChildren: boolean };

/**
 * Probabilidades devolvidas pelo juiz num nível: `belongs` (Noul) e `choice` por candidato (Choice). `scopeFit` (Noul)
 * só vem quando a requisição levou a pergunta do escopo (ADR 0031). Sem candidatos, a requisição leva só essa pergunta:
 * `belongs` fica 0 e `choice` vazio, e nenhum dos dois significa nada.
 */
export type BranchJudgment = { belongs: number; choice: Readonly<Record<string, number>>; scopeFit?: number };

/** Jev: julga, em cada nível, em qual agrupador candidato o rascunho cabe. Quem decide é o código. */
export interface BranchJudge {
  judge(input: {
    draft: TicketDraft;
    current: { title: string; summary: string } | null;
    candidates: readonly BranchCandidate[];
    /** Agrupador de escopo da procura, só na primeira requisição dentro dele; `current` fica `null` nela. */
    scope?: BranchCandidate;
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

// ---- Proposta de agrupador (ADR 0031, passo 4) ---------------------------------------------------------------

/** Ticket solto do destino, como o juiz de afinidade o vê (o `id` não sai: o código liga a resposta de volta). */
export type AffinityTicket = { id: string; title: string; descriptionExcerpt: string };

export type AffinityInput = {
  draft: TicketDraft;
  /** Na raiz, só o nome do projeto; em agrupador, o título e o resumo dele. */
  destination: { title: string; summary?: string };
  tickets: readonly AffinityTicket[];
};

/** Jev: o rascunho e cada ticket solto formam um assunto próprio? Devolve o `Noul` por id de ticket. Quem decide é o código. */
export interface AffinityJudge {
  judge(input: AffinityInput, options?: { signal?: AbortSignal }): Promise<Readonly<Record<string, number>>>;
}

export const AFFINITY_JUDGE = Symbol("AFFINITY_JUDGE");

export type GroupNameInput = {
  destinationTitle: string;
  newTicket: { title: string; descriptionExcerpt: string };
  existingTickets: readonly { title: string; descriptionExcerpt: string }[];
};

/** Claude: escreve o título e a descrição do agrupador proposto. */
export interface GroupNamer {
  name(input: GroupNameInput, options?: { signal?: AbortSignal }): Promise<{ title: string; description: string; model: string }>;
}

export const GROUP_NAMER = Symbol("GROUP_NAMER");

/** Prazos da procura em milissegundos (a descida e a proposta); sem valor, valem os da ADR (30 s e 20 s). Os testes trocam. */
export type PlacementTimeouts = { descentMs?: number; proposalMs?: number };
export const PLACEMENT_TIMEOUTS = Symbol("PLACEMENT_TIMEOUTS");

// ---- Escrever na descrição (ADR 0036, fatia 5) -----------------------------------------------------------------

/**
 * O que vai ao provedor para escrever um trecho da descrição, e nada além: o título do ticket, a descrição atual do
 * editor (que pode não estar salva), os títulos do caminho até a raiz (do topo até o pai) e o pedido. Nenhum id.
 */
export type DescriptionDraftInput = { title: string; description: string; ancestors: readonly string[]; request: string };

/** Claude: escreve um trecho em markdown para a descrição, atendendo ao pedido. Nada é gravado por quem chama. */
export interface DescriptionWriter {
  write(input: DescriptionDraftInput, options?: { signal?: AbortSignal }): Promise<{ text: string; model: string }>;
}

export const DESCRIPTION_WRITER = Symbol("DESCRIPTION_WRITER");

// ---- Pergunta sobre o projeto (ADR 0037, fatia 5) --------------------------------------------------------------

/** Resultado de uma ferramenta: texto (JSON) para o modelo; `isError` marca entrada inválida do modelo, que não derruba a pergunta. */
export type ToolOutcome = { content: string; isError: boolean };

/**
 * Quem executa as ferramentas de consulta. O adaptador do Claude só conhece esta interface, nunca o banco. Entrada
 * inválida vira `ToolOutcome` com `isError`; falha de verdade (banco, permissão que mudou) sobe como exceção.
 */
export interface ToolExecutor {
  execute(name: string, input: unknown): Promise<ToolOutcome>;
}

/** Tudo em rótulos neutros (`T47`): a conversão de chaves é de quem chama. A conversa não é guardada em lugar nenhum. */
export type ProjectAnswerInput = { question: string; history: readonly ConversationMessage[]; tools: ToolExecutor };

/** Claude: responde uma pergunta sobre o projeto consultando-o pelas ferramentas. Só leitura. */
export interface ProjectAnswerer {
  answer(input: ProjectAnswerInput): Promise<{ text: string; model: string }>;
}

export const PROJECT_ANSWERER = Symbol("PROJECT_ANSWERER");

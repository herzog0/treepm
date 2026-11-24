/**
 * Portas dos provedores de IA (ADR 0029). A API só conhece estas interfaces: Claude e Jev entram por
 * adaptadores reais (`ClaudeConversationProvider`, e na Parte 2 os de resumo e de Jev) e por falsos
 * determinísticos nos testes. Nenhum teste automático chama provedor de verdade.
 */

export type TicketDraft = { title: string; description: string };

/** Um filho do rascunho (ADR 0044): título e descrição; só um nível. */
export type DraftChild = { title: string; description: string };

/** Máximo de filhos de um rascunho (ADR 0044). */
export const MAX_DRAFT_CHILDREN = 20;

/**
 * O rascunho da conversa: um ticket (sem `children`, ou lista vazia) ou um pai com filhos (ADR 0044). A citação do pedido
 * não faz parte dele: a API a monta na hora de criar.
 */
export type ConversationDraft = TicketDraft & {
  children?: readonly DraftChild[];
  /** Registrar como ideia ao criar (ADR 0044, adendo); ausente = falso. */
  idea?: boolean;
};

export type ConversationMessage = { author: "person" | "assistant"; body: string };

/**
 * O histórico termina na mensagem nova da pessoa; `draft` é o rascunho atual (ou ainda não há). `groups` são os títulos
 * dos agrupadores do lugar da procura (ADR 0033): no máximo 30, na ordem do número; só títulos.
 */
export type ConversationTurnInput = { history: readonly ConversationMessage[]; draft: ConversationDraft | null; groups: readonly string[] };

export type ConversationTurn = {
  message: string;
  /** `null` enquanto a IA ainda não tem o que propor; o chamador mantém o rascunho anterior. */
  draft: ConversationDraft | null;
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

// ---- Tickets relacionados (ADR 0052, item 2) -------------------------------------------------------------------

/** Um candidato da triagem por palavras, como o Jev o vê: título e trecho da descrição (o `id` não sai: o código liga a resposta de volta). */
export type RelatedCandidate = { id: string; title: string; excerpt: string };

export type RelatedInput = { draft: TicketDraft; candidates: readonly RelatedCandidate[] };

/** As duas respostas do Jev por candidato: `sameSubject` (trata do mesmo assunto?) e `sameRequest` (pede a mesma coisa?). */
export type RelatedJudgment = { sameSubject: number; sameRequest: number };

/** Jev: para cada candidato, duas perguntas de sim ou não numa requisição só. Devolve as duas probabilidades por id. Quem decide é o código. */
export interface RelatedJudge {
  judge(input: RelatedInput, options?: { signal?: AbortSignal }): Promise<Readonly<Record<string, RelatedJudgment>>>;
}

export const RELATED_JUDGE = Symbol("RELATED_JUDGE");

/** Prazos da procura em milissegundos (a descida, a proposta, os relacionados, a elaboração e a procura das tarefas sugeridas na árvore); sem valor, valem os da ADR (30 s, 20 s, 20 s e 20 s). Os testes trocam. */
export type PlacementTimeouts = { descentMs?: number; proposalMs?: number; relatedMs?: number; elaborationMs?: number; suggestedLookupMs?: number };
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

// ---- Chat de trabalho por ticket (ADR 0049) --------------------------------------------------------------------

/** Um ticket vizinho do ticket do chat: o rótulo (no campo `key`), o título e a situação. Nenhum id, nenhuma pessoa. */
export type ChatTicketRef = { key: string; title: string; status: string };

/**
 * O que o provedor do chat sabe do ticket, e NADA além disso (ADR 0049): título, descrição, situação, a prioridade que vale, o
 * caminho até a raiz (do topo até o pai), os filhos diretos e as dependências nos dois sentidos. Nunca comentários, histórico,
 * texto de áreas, nota do marcador de trabalho, nem nomes, e-mails ou identificadores de pessoas, nem threads.
 */
export type ChatTicketContext = {
  key: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  path: readonly { key: string; title: string }[];
  children: readonly ChatTicketRef[];
  dependsOn: readonly ChatTicketRef[];
  blocks: readonly ChatTicketRef[];
};

/**
 * O histórico termina na mensagem nova da pessoa e só tem a conversa DELA com o assistente, já com o teto de tamanho. `ticket` é nulo no
 * chat geral da pessoa (ADR 0055), que não trata de ticket. Com as chaves de verdade (decisão de Teodoro, TREEPM-406): `projects` são as chaves dos projetos
 * que a pessoa enxerga e não estão arquivados; nenhum texto leva id, nome de projeto nem dado de pessoa. `tools` consulta
 * esses projetos, só leitura.
 */
export type ChatTurnInput = {
  ticket: ChatTicketContext | null;
  history: readonly ConversationMessage[];
  projects: readonly string[];
  tools: ToolExecutor;
};

/** Claude: ajuda a pessoa a pensar e consulta tickets pelas ferramentas de leitura. Nunca altera nada. */
export interface ChatProvider {
  reply(input: ChatTurnInput): Promise<{ message: string; model: string }>;
}

export const CHAT_PROVIDER = Symbol("CHAT_PROVIDER");

// ---- Elaboração: ligações e tarefas sugeridas (ADR 0052, item 4; fatia 3) ----------------------------------------

/** Um relacionado como o Claude o vê na elaboração: chave, título, trecho da descrição e situação. Nenhum id, pessoa, comentário ou área. */
export type ElaborationRelated = { key: string; title: string; excerpt: string; status: string };

/** O rascunho (título, descrição e partes) e os relacionados (até oito). */
export type ElaborationInput = {
  draft: { title: string; description: string; parts: readonly DraftChild[] };
  related: readonly ElaborationRelated[];
};

/** Uma ligação "depende de" como o modelo a devolve: `de` é `"pai"` ou o índice (a partir de 0) da parte. O servidor valida tudo. */
export type ElaborationLink = { de: "pai" | number; dependeDe: string; motivo: string };
/** Uma tarefa que o pedido implica e a pessoa não disse, com a frase que diz por que é necessária. */
export type ElaborationSuggestion = { title: string; description: string; motivo: string };
export type ElaborationResult = { links: readonly ElaborationLink[]; suggested: readonly ElaborationSuggestion[]; model: string };

/** Um candidato da árvore para uma tarefa sugerida, como o Claude o vê na segunda chamada: chave, título, trecho e situação. Nenhum id. */
export type ExistingMatchCandidate = { key: string; title: string; excerpt: string; status: string };
/** Uma tarefa sugerida com os candidatos que a triagem por palavras achou para ELA. `index` é a posição na lista de sugeridas. */
export type ExistingMatchTask = { index: number; title: string; description: string; motivo: string; candidates: readonly ExistingMatchCandidate[] };
export type ExistingMatchInput = { tasks: readonly ExistingMatchTask[] };
/** Por sugerida (`index`): a chave de um candidato DAQUELA sugerida quando fazer aquele ticket já entrega o que ela precisa; `null` quando o trabalho não existe. */
export type ExistingMatchResult = { answers: readonly { index: number; existing: string | null }[]; model: string };

/** Claude, segunda chamada da elaboração: decide, por tarefa sugerida, se ela já existe na árvore. */
export interface ExistingMatcher {
  matchExisting(input: ExistingMatchInput, options?: { signal?: AbortSignal }): Promise<ExistingMatchResult>;
}

/** Claude: lê o rascunho e os relacionados e propõe ligações com tickets que existem e tarefas que o pedido implica. Só propõe. */
export interface TicketElaborator extends ExistingMatcher {
  elaborate(input: ElaborationInput, options?: { signal?: AbortSignal }): Promise<ElaborationResult>;
}

export const TICKET_ELABORATOR = Symbol("TICKET_ELABORATOR");

// ---- Busca por significado: um vetor por ticket (ADR 0053) -------------------------------------------------------

/** O modelo e o tamanho do vetor guardado; mudar qualquer um dos dois é reindexar (a linha de outro modelo ou tamanho conta como desatualizada). */
export const EMBEDDING_MODEL = "voyage-4-lite";
export const EMBEDDING_DIMENSIONS = 512;

/** `document`: o texto de um ticket guardado; `query`: o texto de uma consulta (rascunho ou tarefa sugerida). */
export type EmbeddingKind = "document" | "query";

/** Motivos curtos de falha do provedor de vetores: nunca levam texto enviado, corpo de resposta nem chave. */
export type EmbeddingFailure = "unauthorized" | "bad_request" | "rate_limited" | "server_error" | "timeout" | "network" | "malformed";

/** Falha do provedor de vetores: só um código curto (para o diagnóstico e a saída da ferramenta), nunca texto. */
export class EmbeddingError extends Error {
  constructor(readonly code: EmbeddingFailure) {
    super(`Falha no provedor de vetores: ${code}.`);
    this.name = "EmbeddingError";
  }
}

/** Voyage: um vetor de `EMBEDDING_DIMENSIONS` números por texto, na mesma ordem dos textos. Só texto de ticket chega aqui. */
export interface EmbeddingProvider {
  /** O modelo que gera os vetores; fica gravado em cada linha. O falso grava `fake`, que conta como desatualizado para o de verdade. */
  readonly model: string;
  embed(texts: readonly string[], kind: EmbeddingKind, options?: { signal?: AbortSignal }): Promise<number[][]>;
}

export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");

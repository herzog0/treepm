/** Token de injeção do cliente do Linear. */
export const LINEAR_CLIENT = Symbol("LINEAR_CLIENT");
/** Token do `fetch` que o cliente usa (só os testes o trocam). */
export const LINEAR_FETCH = Symbol("LINEAR_FETCH");
/** Token da cifra das credenciais; `null` quando a ligação com o Linear está desligada. */
export const CREDENTIAL_CIPHER = Symbol("CREDENTIAL_CIPHER");

/**
 * `linear_response_too_large` (corpo acima do teto de uma página da importação) e `linear_timeout` (prazo estourado numa página de
 * importação): a importação repete com página menor. E
 * `linear_email_unavailable` (o Linear recusou o campo `email`: a importação repete sem ele) e `linear_partial_response` (resposta 200
 * com `errors` na fase de relações, quando a chave não enxerga uma ponta: a importação reduz a página e, com uma issue só, pula as relações
 * dela) só existem entre o cliente e a importação; para o resto da aplicação valem `linear_unavailable`.
 */
export type LinearFailureCode = "linear_key_invalid" | "linear_rate_limited" | "linear_unavailable" | "linear_response_too_large" | "linear_timeout" | "linear_email_unavailable" | "linear_partial_response";

/**
 * Falha ao falar com o Linear: só um código e, no limite, o tempo de espera. A mensagem é fixa por código: a chave, o corpo da
 * resposta e a exceção original nunca entram (ADR 0060).
 */
export class LinearError extends Error {
  constructor(
    readonly code: LinearFailureCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Falha ao consultar o Linear: ${code}.`);
    this.name = "LinearError";
  }
}

export type LinearWorkspace = { id: string; name: string; urlKey: string };
export type LinearTeam = { id: string; key: string; name: string };

/** O que o Linear devolve sobre a chave: o workspace a que ela pertence e quem a criou. */
export type LinearIdentity = { workspace: LinearWorkspace; viewer: { id: string } };

/** Uma página de uma listagem do Linear: `nextCursor` é nulo na última; `skippedInvalid` conta os nós que não passaram na validação (pulados um a um). */
export type LinearPage<T> = { nodes: T[]; nextCursor: string | null; skippedInvalid: number };

/**
 * Um projeto do Linear que pertence ao time; `statusType` é o `status.type` do projeto (nulo se não veio). `description` é o resumo e
 * `content` o texto longo (nulo quando a leitura não o pediu); `lead.email` só serve para casar uma pessoa e nunca é guardado.
 */
export type LinearProjectNode = {
  id: string;
  name: string;
  url: string;
  statusType: string | null;
  description: string | null;
  content: string | null;
  priority: number;
  lead: { id: string; email: string | null } | null;
  /** O `targetDate` do projeto como prazo (ADR 0064): texto `AAAA-MM-DD`, nulo sem data; `undefined` = chave ausente, malformado ou fora da faixa: não lido (não toca o prazo). */
  dueDate?: string | null;
};

/** Opções da leitura de projetos: `first` itens (padrão 50), sem o conteúdo longo (corpo grande demais), sem o e-mail do líder (campo recusado). */
export type LinearProjectsOptions = { first?: number; withContent?: boolean; withEmail?: boolean };
/** `dueDatesInvalid`: nós cujo prazo veio malformado ou fora de 2000–2100 (o nó vale, sem o prazo). Chave ausente não conta. */
export type LinearProjectsPage = LinearPage<LinearProjectNode> & { dueDatesInvalid?: number };

/** Opções da leitura de issues: `first` itens (padrão 50), sem a descrição (issue enorme), sem o e-mail do responsável (campo recusado). */
export type LinearIssuesOptions = { first?: number; withDescription?: boolean; withEmail?: boolean };
/** `labelsInvalid`: nós de etiqueta malformados (pulados; a issue vale). */
export type LinearIssuesPage = LinearPage<LinearIssueNode> & { dueDatesInvalid?: number; labelsInvalid?: number };
/** Uma etiqueta do Linear lida na issue (ADR 0065): nome cru (quem grava limpa), cor como veio (hex; "" se malformada), grupo. */
export type LinearLabelNode = { id: string; name: string; color: string; parent: { id: string; name: string } | null };

/**
 * Uma issue como a importação a lê. O e-mail do responsável só serve para casar com uma pessoa do TreePM: quem recebe não o grava
 * nem o registra em lugar nenhum (ADR 0060).
 */
export type LinearIssueNode = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  priority: number;
  updatedAt: string;
  trashed: boolean;
  stateType: string;
  parentId: string | null;
  projectId: string | null;
  assignee: { id: string; email: string | null } | null;
  /** As datas do Linear (ADR 0061); nulas quando não há ou o servidor não as trouxe. */
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  /** Os identificadores que a issue já teve (trocou de time). */
  previousIdentifiers: string[];
  /** Quem criou no Linear; o e-mail só serve para casar uma pessoa e nunca é guardado. */
  creator: { id: string; name: string; email: string | null } | null;
  /** O prazo da issue (ADR 0064): texto `AAAA-MM-DD`, nulo sem data; `undefined` = chave ausente, malformado ou fora da faixa: não lido (não toca o prazo). */
  dueDate?: string | null;
  /** O conjunto COMPLETO de etiquetas da issue (ids de lá); `undefined` = ausente ou malformado: não lido (nada muda no ticket). */
  labelIds?: string[];
  /** Os nós das primeiras etiquetas (nome, cor, grupo); id em `labelIds` sem nó aqui resolve pela origem já gravada. */
  labels?: LinearLabelNode[];
};

/**
 * O autor de um comentário do Linear: o usuário (o e-mail só serve para casar uma pessoa e nunca é guardado), o usuário de fora sincronizado
 * (Slack e afins: só o nome), o robô de uma integração (só o nome), ou `null` (autor apagado no Linear).
 */
export type LinearCommentAuthor = { kind: "user"; id: string; name: string; email: string | null } | { kind: "external"; name: string } | { kind: "bot"; name: string | null } | null;

/** Um comentário de issue do time (ADR 0061, fatia 2). `body` é nulo quando a leitura não o pediu; `parent.body` também. */
export type LinearCommentNode = {
  id: string;
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  updatedAt: string;
  issueId: string;
  parent: { id: string; body: string | null } | null;
  author: LinearCommentAuthor;
};
/** Opções da leitura de comentários: `first` (padrão 50); sem o corpo do pai, sem o corpo (página enorme), sem o e-mail (campo recusado). */
export type LinearCommentsOptions = { first?: number; withParentBody?: boolean; withBody?: boolean; withEmail?: boolean };
export type LinearCommentsPage = LinearPage<LinearCommentNode>;

/** Uma relação de que a issue é a ORIGEM no Linear (ADR 0061, fatia 3): `type` cru (`blocks`, `related`, `duplicate`, `similar`...). */
export type LinearRelationNode = { id: string; type: string; relatedIssueId: string };
/** Uma issue do time com as relações de origem dela (até 20); `relationsNext` é o cursor da issue que tem mais. */
export type LinearRelationIssueNode = { id: string; relations: LinearRelationNode[]; relationsNext: string | null };
/** `withRelations: false`: só os ids e o cursor (para andar depois de uma issue cujas relações o Linear não devolve). */
export type LinearRelationsOptions = { first?: number; withRelations?: boolean };
export type LinearRelationsPage = LinearPage<LinearRelationIssueNode>;
/** As relações seguintes de uma issue; `skippedInvalid` conta também a issue que não veio (sumiu ou deixou de ser visível). */
export type LinearIssueRelationsPage = { relations: LinearRelationNode[]; nextCursor: string | null; skippedInvalid: number };

/** Um usuário do Linear no histórico; o e-mail (quando pedido) só serve para casar uma pessoa e nunca é guardado nem registrado. */
export type LinearHistoryUser = { id: string; name: string | null; email: string | null };
/**
 * Uma entrada do histórico de uma issue (`IssueHistory`; ADR 0061, fatia 4) com só os campos que a fase usa. Campo opcional malformado
 * vale como ausente (`null`). Cabe em `LinearHistoryEntryInput` do domínio (`linearHistoryChanges`, `linearHistoryAuthor`).
 */
export type LinearHistoryNode = {
  id: string;
  createdAt: string;
  actor: LinearHistoryUser | null;
  botActor: { name: string | null } | null;
  fromStateId: string | null;
  toStateId: string | null;
  fromState: { name: string | null; type: string | null } | null;
  toState: { name: string | null; type: string | null } | null;
  fromAssigneeId: string | null;
  toAssigneeId: string | null;
  fromAssignee: LinearHistoryUser | null;
  toAssignee: LinearHistoryUser | null;
  fromPriority: number | null;
  toPriority: number | null;
  fromTitle: string | null;
  toTitle: string | null;
  fromParentId: string | null;
  toParentId: string | null;
  fromProjectId: string | null;
  toProjectId: string | null;
  updatedDescription: boolean | null;
};
/** Uma issue do time com as entradas mais recentes do histórico (até 20); `historyNext` é o cursor da issue que tem mais. */
export type LinearHistoryIssueNode = { id: string; history: LinearHistoryNode[]; historyNext: string | null };
/**
 * `first` (padrão 10); `updatedSince`: só as issues alteradas depois (`updatedAt > ...`; nulo ou ausente = o time inteiro); `withHistory:
 * false`: só os ids e o cursor (para andar depois de uma issue ilegível); `withEmail: false`: sem o e-mail (campo recusado).
 */
export type LinearHistoryOptions = { first?: number; updatedSince?: string | null; withHistory?: boolean; withEmail?: boolean };
/**
 * `historyErrors`: issues da página cujo histórico veio, todo ou em parte, com `errors` (resposta 200 com `data` válido). A issue apontada
 * inteira não vem em `nodes`; o nó do histórico apontado não vem na issue. As duas seguram a marca d'água.
 */
export type LinearHistoryPage = LinearPage<LinearHistoryIssueNode> & { historyErrors: number };
/**
 * As entradas seguintes de uma issue. `incomplete`: a leitura não trouxe tudo o que devia por erro (a issue sumiu ou deixou de ser
 * visível, ou um nó veio com `errors` e foi descartado); segura a marca d'água.
 */
export type LinearIssueHistoryPage = { history: LinearHistoryNode[]; nextCursor: string | null; skippedInvalid: number; incomplete: boolean };

/** A porta do Linear desta fatia. A chave é sempre argumento: o cliente não guarda nada entre chamadas. */
export interface LinearClient {
  whoami(apiKey: string): Promise<LinearIdentity>;
  /** Os times que a chave enxerga agora, até o teto de 500. */
  listTeams(apiKey: string): Promise<LinearTeam[]>;
  /** Um time pelo id, sem listar todos; inexistente ou inacessível → `null`. */
  getTeam(apiKey: string, teamId: string): Promise<LinearTeam | null>;
  /** Quantas issues o time tem (sem arquivadas), numa chamada barata. */
  countTeamIssues(apiKey: string, teamId: string): Promise<number>;
  /** Uma página (50) dos projetos do time. */
  listTeamProjects(apiKey: string, teamId: string, after: string | null, options?: LinearProjectsOptions): Promise<LinearProjectsPage>;
  /** Uma página (50) das issues do time, sem arquivadas. */
  listTeamIssues(apiKey: string, teamId: string, after: string | null, options?: LinearIssuesOptions): Promise<LinearIssuesPage>;
  /** Uma página (50) dos comentários das issues do time, pela consulta de raiz `comments` (mais novos primeiro). */
  listTeamComments(apiKey: string, teamId: string, after: string | null, options?: LinearCommentsOptions): Promise<LinearCommentsPage>;
  /** Uma página (50) das issues do time com as relações de que cada uma é origem (até 20 por issue). */
  listTeamRelations(apiKey: string, teamId: string, after: string | null, options?: LinearRelationsOptions): Promise<LinearRelationsPage>;
  /** As relações seguintes (100 por vez) de uma issue que tem mais de 20. */
  listIssueRelations(apiKey: string, issueId: string, after: string): Promise<LinearIssueRelationsPage>;
  /** Uma página (10) das issues do time com as 20 entradas mais recentes do histórico de cada uma (fase `history`). */
  listTeamHistory(apiKey: string, teamId: string, after: string | null, options?: LinearHistoryOptions): Promise<LinearHistoryPage>;
  /** As entradas seguintes (180 por vez, ou `first` quando a importação reduz: completa as 200 por issue) de uma issue que tem mais de 20. */
  listIssueHistory(apiKey: string, issueId: string, after: string, options?: { withEmail?: boolean; first?: number }): Promise<LinearIssueHistoryPage>;
}

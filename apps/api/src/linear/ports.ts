/** Token de injeção do cliente do Linear. */
export const LINEAR_CLIENT = Symbol("LINEAR_CLIENT");
/** Token do `fetch` que o cliente usa (só os testes o trocam). */
export const LINEAR_FETCH = Symbol("LINEAR_FETCH");
/** Token da cifra das credenciais; `null` quando a ligação com o Linear está desligada. */
export const CREDENTIAL_CIPHER = Symbol("CREDENTIAL_CIPHER");

/**
 * `linear_response_too_large` (corpo acima do teto de uma página da importação) e `linear_timeout` (prazo estourado numa página de
 * importação): a importação repete com página menor. E
 * `linear_email_unavailable` (o Linear recusou o campo `email`: a importação repete sem ele) só existem entre o cliente e a
 * importação; para o resto da aplicação valem `linear_unavailable`.
 */
export type LinearFailureCode = "linear_key_invalid" | "linear_rate_limited" | "linear_unavailable" | "linear_response_too_large" | "linear_timeout" | "linear_email_unavailable";

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
};

/** Opções da leitura de projetos: `first` itens (padrão 50), sem o conteúdo longo (corpo grande demais), sem o e-mail do líder (campo recusado). */
export type LinearProjectsOptions = { first?: number; withContent?: boolean; withEmail?: boolean };
export type LinearProjectsPage = LinearPage<LinearProjectNode>;

/** Opções da leitura de issues: `first` itens (padrão 50), sem a descrição (issue enorme), sem o e-mail do responsável (campo recusado). */
export type LinearIssuesOptions = { first?: number; withDescription?: boolean; withEmail?: boolean };
export type LinearIssuesPage = LinearPage<LinearIssueNode>;

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
}

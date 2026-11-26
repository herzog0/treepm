import { parseDueDate } from "@treepm/domain";
import { z } from "zod";
import { LinearError } from "./ports.js";
import type { LinearClient, LinearCommentAuthor, LinearCommentsOptions, LinearCommentsPage, LinearFailureCode, LinearIdentity, LinearHistoryIssueNode, LinearHistoryNode, LinearHistoryOptions, LinearHistoryPage, LinearHistoryUser, LinearIssueHistoryPage, LinearIssueRelationsPage, LinearIssuesOptions, LinearIssuesPage, LinearProjectsOptions, LinearProjectsPage, LinearRelationNode, LinearRelationsOptions, LinearRelationsPage, LinearTeam } from "./ports.js";

export { LinearError } from "./ports.js";

/** Endpoint único do Linear (documentação lida em 2026-11-24). */
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
/** Prazo de cada chamada, em milissegundos. */
export const LINEAR_TIMEOUT_MS = 10_000;
/** Times por página e teto de times lidos (5 páginas). */
export const LINEAR_TEAM_PAGE_SIZE = 100;
export const LINEAR_TEAM_CEILING = 500;
/** Teto de páginas por listagem e prazo total dela: uma página vazia com `hasNextPage` conta e não gira para sempre. */
export const LINEAR_TEAM_MAX_PAGES = 5;
export const LINEAR_LIST_TIMEOUT_MS = 30_000;
/** Teto do corpo de cada resposta (acima disso → `linear_unavailable`) e do que se guarda do que o Linear diz. */
export const LINEAR_MAX_BODY_BYTES = 1_048_576;
/** Teto do corpo das páginas da importação (issues e projetos): uma página de 50 issues com descrições longas passa de 1 MB. */
export const LINEAR_IMPORT_MAX_BODY_BYTES = 4 * 1_048_576;
export const LINEAR_NAME_MAX = 200;
export const LINEAR_TEAM_KEY_MAX = 20;
/** Itens por página da importação (issues e projetos). */
export const LINEAR_IMPORT_PAGE_SIZE = 50;
/** Espera sugerida quando o Linear limita a taxa e não diz quanto. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export type HttpLinearClientOptions = {
  /** Prazo por chamada (ms); padrão 10 s. */
  timeoutMs?: number;
  /** Prazo total de uma listagem paginada (ms); padrão 30 s. */
  listTimeoutMs?: number;
  /** Só os testes trocam. */
  fetch?: typeof fetch;
};

const WHOAMI_QUERY = "query Whoami { viewer { id } organization { id name urlKey } }";
const TEAMS_QUERY = "query Teams($after: String) { teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }";

const TEAM_QUERY = "query Team($id: String!) { team(id: $id) { id key name } }";

const COUNT_QUERY = "query TeamIssueCount($id: String!) { team(id: $id) { issueCount(includeArchived: false) } }";
/** Projetos: resumo, conteúdo longo (some na repetição por corpo grande), prioridade e líder (o e-mail só para casar a pessoa). */
const projectsQuery = (withContent: boolean, withEmail: boolean): string =>
  `query TeamProjects($id: String!, $after: String, $first: Int!) { team(id: $id) { projects(first: $first, after: $after) { nodes { id name url description ${withContent ? "content " : ""}priority targetDate status { type } lead { id${withEmail ? " email" : ""} } } pageInfo { hasNextPage endCursor } } } }`;
/** Mais novas primeiro (`createdAt`, o padrão do Linear, dito aqui para a repescagem poder confiar). Sem `children` nem `labels`. */
const issuesQuery = (withDescription: boolean, withEmail: boolean): string =>
  `query TeamIssues($id: String!, $after: String, $first: Int!) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt) { nodes { id identifier url title ${withDescription ? "description " : ""}priority dueDate updatedAt createdAt startedAt completedAt canceledAt previousIdentifiers trashed state { type } parent { id } project { id } assignee { id${withEmail ? " email" : ""} } creator { id name${withEmail ? " email" : ""} } } pageInfo { hasNextPage endCursor } } } }`;

/**
 * Comentários: consulta de RAIZ filtrada pelas issues do time (`TeamFilter.id` é `IDComparator`, cujo `eq` é `ID`: por isso `$id: ID!`).
 * Mais novos primeiro (`createdAt`, o padrão). O corpo do pai vem junto, para a citação não depender da ordem das páginas.
 */
const commentsQuery = (withBody: boolean, withParentBody: boolean, withEmail: boolean): string =>
  `query TeamComments($id: ID!, $after: String, $first: Int!) { comments(first: $first, after: $after, filter: { issue: { team: { id: { eq: $id } } } }) { nodes { id ${withBody ? "body " : ""}createdAt editedAt updatedAt issue { id } parent { id${withParentBody ? " body" : ""} } user { id name${withEmail ? " email" : ""} } externalUser { name } botActor { name } } pageInfo { hasNextPage endCursor } } }`;

/** Relações de origem lidas por issue na página da fase `relations` (ADR 0061, fatia 3); a issue com mais pede as outras à parte. */
export const LINEAR_RELATIONS_PER_ISSUE = 20;
/** Relações por chamada quando uma issue tem mais de `LINEAR_RELATIONS_PER_ISSUE`. */
const ISSUE_RELATIONS_PAGE = 100;
const RELATION_FIELDS = "nodes { id type relatedIssue { id } } pageInfo { hasNextPage endCursor }";
/**
 * Relações: aninhadas na issue (a consulta de raiz `issueRelations` não aceita filtro). Relê as issues do time na ordem e com o filtro da
 * fase `issues`, pedindo só o id e as relações de que a issue é ORIGEM: toda relação entre duas issues do time aparece numa delas.
 */
const relationsQuery = (withRelations: boolean): string =>
  `query TeamRelations($id: String!, $after: String, $first: Int!) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt) { nodes { id${withRelations ? ` relations(first: ${LINEAR_RELATIONS_PER_ISSUE}) { ${RELATION_FIELDS} }` : ""} } pageInfo { hasNextPage endCursor } } } }`;
const ISSUE_RELATIONS_QUERY = `query IssueRelations($id: String!, $after: String) { issue(id: $id) { relations(first: ${ISSUE_RELATIONS_PAGE}, after: $after) { ${RELATION_FIELDS} } } }`;

/** Issues por página na fase `history` (ADR 0061, fatia 4): 10 × 20 entradas cabem com folga no teto de pontos (a conta no PROGRESSO-H1). */
export const LINEAR_HISTORY_PAGE_SIZE = 10;
/** Entradas lidas por issue na página do time (as mais recentes: `orderBy: createdAt` vem do mais novo para o mais velho). */
export const LINEAR_HISTORY_PER_ISSUE = 20;
/** Entradas da página extra de UMA issue: completa as 200 por issue numa chamada só. */
export const LINEAR_HISTORY_EXTRA_PAGE = 180;
/** Só os campos que a normalização usa (a mudança é detectada pelos `*Id`); o e-mail só quando pedido, para o casamento. */
const historyFields = (withEmail: boolean): string => {
  const person = `{ id name${withEmail ? " email" : ""} }`;
  return `nodes { id createdAt actor ${person} botActor { name } fromStateId toStateId fromState { name type } toState { name type } fromAssigneeId toAssigneeId fromAssignee ${person} toAssignee ${person} fromPriority toPriority fromTitle toTitle fromParentId toParentId fromProjectId toProjectId updatedDescription } pageInfo { hasNextPage endCursor }`;
};
/**
 * Histórico: aninhado na issue, como as relações. Relê as issues do time na ordem da fase `issues`, opcionalmente só as alteradas depois
 * da marca d'água (`updatedAt > $since`), pedindo só o id e as entradas mais recentes.
 */
const historyQuery = (withHistory: boolean, withEmail: boolean, filtered: boolean): string =>
  `query TeamHistory($id: String!, $after: String, $first: Int!${filtered ? ", $since: DateTimeOrDuration!" : ""}) { team(id: $id) { issues(first: $first, after: $after, includeArchived: false, orderBy: createdAt${filtered ? ", filter: { updatedAt: { gt: $since } }" : ""}) { nodes { id${withHistory ? ` history(first: ${LINEAR_HISTORY_PER_ISSUE}, orderBy: createdAt) { ${historyFields(withEmail)} }` : ""} } pageInfo { hasNextPage endCursor } } } }`;
/** A página extra de uma issue: `$first` é 180 (completa as 200), ou menos quando a importação a reduz depois de um estouro. */
const issueHistoryQuery = (withEmail: boolean): string =>
  `query IssueHistory($id: String!, $after: String, $first: Int!) { issue(id: $id) { history(first: $first, after: $after, orderBy: createdAt) { ${historyFields(withEmail)} } } }`;

const cut = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

const identitySchema = z.object({
  data: z.object({
    viewer: z.object({ id: z.string().min(1) }),
    organization: z.object({ id: z.string().min(1), name: z.string(), urlKey: z.string() }),
  }),
});
const teamNodeSchema = z.object({ id: z.string().min(1), key: z.string(), name: z.string() });
const teamSchema = z.object({ data: z.object({ team: teamNodeSchema.nullable() }) });
const teamsSchema = z.object({
  data: z.object({
    teams: z.object({
      nodes: z.array(teamNodeSchema),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const countSchema = z.object({ data: z.object({ team: z.object({ issueCount: z.number().int().min(0) }) }) });
const projectNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  url: z.string(),
  status: z.object({ type: z.string() }).nullable().optional(),
  // Os campos da sincronização (ADR 0061) NUNCA derrubam o nó: se vierem malformados, valem como ausentes (os antigos continuam estritos).
  description: z.string().nullable().optional().catch(null),
  content: z.string().nullable().optional().catch(null),
  priority: z.number().nullable().optional().catch(null),
  lead: z.object({ id: z.string().min(1), email: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
  // O prazo (ADR 0064) é lido à parte (`readDueDate`): malformado não derruba o nó nem vira nulo; vale como não lido e é contado.
  targetDate: z.unknown().optional(),
});
/**
 * O prazo como o Linear o manda (`TimelessDate`, `AAAA-MM-DD`): nulo vale nulo; uma data válida na faixa do TreePM vale o texto; chave
 * ausente vale `undefined` ("não lido nesta rodada": quem grava não toca o prazo nem o retrato dessa chave); qualquer outra coisa
 * (formato inválido ou data fora de 2000–2100) também vale `undefined` e é contada.
 */
function readDueDate(raw: unknown): { value: string | null | undefined; ignored: boolean } {
  if (raw === undefined) return { value: undefined, ignored: false };
  if (raw === null) return { value: null, ignored: false };
  const value = parseDueDate(raw);
  return value === null ? { value: undefined, ignored: true } : { value, ignored: false };
}
// Os nós são validados um a um (um nó ruim não derruba a página); só o envelope é exigido por inteiro.
const projectsSchema = z.object({ data: z.object({ team: z.object({ projects: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }) }) });
const issueNodeSchema = z.object({
  id: z.string().min(1),
  identifier: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number(),
  dueDate: z.unknown().optional(),
  updatedAt: z.string(),
  trashed: z.boolean().nullable().optional(),
  state: z.object({ type: z.string() }),
  parent: z.object({ id: z.string().min(1) }).nullable().optional(),
  project: z.object({ id: z.string().min(1) }).nullable().optional(),
  assignee: z.object({ id: z.string().min(1), email: z.string().nullable().optional() }).nullable().optional(),
  // Os campos da sincronização (ADR 0061) são opcionais: um nó de um servidor que não os traz continua valendo.
  // ...e, se vierem malformados, valem como ausentes: o nó entra sem eles.
  createdAt: z.string().nullable().optional().catch(null),
  startedAt: z.string().nullable().optional().catch(null),
  completedAt: z.string().nullable().optional().catch(null),
  canceledAt: z.string().nullable().optional().catch(null),
  previousIdentifiers: z.array(z.string()).nullable().optional().catch(null),
  creator: z.object({ id: z.string().min(1), name: z.string().nullable().optional().catch(null), email: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
});
const issuesSchema = z.object({ data: z.object({ team: z.object({ issues: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }) }) });

/**
 * Um id do Linear que vai para consulta, origem e `applied` (C2, item 5): UUID no Linear de verdade; aqui, tamanho razoável e só letras,
 * dígitos, `-` e `_` (nada de controle, nulo ou espaço). Fora disso o nó é pulado e contado, em vez de derrubar o passo inteiro.
 */
const linearId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
// Os nós de comentário: `id`, `issue` e o id do usuário obrigatórios e bem formados (senão o nó é pulado e contado em `commentsInvalid`);
// o resto que vier malformado vale como ausente (o pai inválido vira "sem pai": a resposta perde só a citação).
const commentNodeSchema = z.object({
  id: linearId,
  body: z.string().nullable().optional(),
  createdAt: z.string(),
  editedAt: z.string().nullable().optional().catch(null),
  updatedAt: z.string(),
  issue: z.object({ id: linearId }),
  parent: z.object({ id: linearId, body: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
  user: z.object({ id: linearId, name: z.string().nullable().optional().catch(null), email: z.string().nullable().optional().catch(null) }).nullable().optional(),
  externalUser: z.object({ name: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
  botActor: z.object({ name: z.string().nullable().optional().catch(null) }).nullable().optional().catch(null),
});
/**
 * Os ids da fase de relações: no máximo 64 caracteres (UUID no Linear de verdade). A origem guarda `<relação>:<d|r>:<issue>:<issue>`, que
 * assim cabe no CHECK de 200 de `external_id`; o nó que não cabe é pulado e contado (`relationsInvalid`), sem derrubar o passo.
 */
const relationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
// As relações: id, tipo e a outra ponta bem formados, um a um (uma relação ruim é pulada e contada; a issue continua).
const relationNodeSchema = z.object({ id: relationId, type: z.string().regex(/^[A-Za-z_]{1,40}$/), relatedIssue: z.object({ id: relationId }) });
const relationConnectionSchema = z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema });
const relationIssueSchema = z.object({ id: relationId, relations: relationConnectionSchema });
const relationIssueIdSchema = z.object({ id: relationId });
const relationsSchema = z.object({ data: z.object({ team: z.object({ issues: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }) }) });
const issueRelationsSchema = z.object({ data: z.object({ issue: z.object({ relations: relationConnectionSchema }).nullable() }) });
/** As relações válidas de uma conexão, o cursor seguinte e quantas foram puladas. */
function relationsOf(connection: z.output<typeof relationConnectionSchema>): { relations: LinearRelationNode[]; next: string | null; skipped: number } {
  const { valid, skipped } = validNodes(relationNodeSchema, connection.nodes);
  return { relations: valid.map((node) => ({ id: node.id, type: node.type, relatedIssueId: node.relatedIssue.id })), next: nextCursor(connection.pageInfo), skipped };
}
const commentsSchema = z.object({ data: z.object({ comments: z.object({ nodes: z.array(z.unknown()), pageInfo: pageInfoSchema }) }) });

/** Quem escreveu: o usuário vence; sem ele, o usuário de fora sincronizado; sem os dois, o robô; nada → autor apagado. */
function commentAuthor(node: z.output<typeof commentNodeSchema>): LinearCommentAuthor {
  if (node.user) return { kind: "user", id: node.user.id, name: node.user.name ?? "", email: node.user.email ?? null };
  if (node.externalUser && typeof node.externalUser.name === "string") return { kind: "external", name: node.externalUser.name };
  if (node.botActor) return { kind: "bot", name: node.botActor.name ?? null };
  return null;
}

/** Valida cada nó sozinho: devolve os válidos e quantos foram pulados. */
function validNodes<S extends z.ZodType>(schema: S, nodes: readonly unknown[]): { valid: z.output<S>[]; skipped: number } {
  const valid: z.output<S>[] = [];
  for (const node of nodes) {
    const parsed = schema.safeParse(node);
    if (parsed.success) valid.push(parsed.data);
  }
  return { valid, skipped: nodes.length - valid.length };
}

/** `hasNextPage` sem cursor é resposta defeituosa: falha em vez de parar no meio ou girar para sempre. */
function nextCursor(info: { hasNextPage: boolean; endCursor: string | null }): string | null {
  if (!info.hasNextPage) return null;
  if (info.endCursor === null) throw new LinearError("linear_unavailable");
  return info.endCursor;
}

/** O corpo traz `errors` (de qualquer tipo)? */
const hasErrors = (body: unknown): boolean => body !== null && typeof body === "object" && Array.isArray((body as { errors?: unknown }).errors);

/** Códigos de erro do Linear (`errors[].extensions.code`) que significam "chave recusada". */
const AUTH_CODES = new Set(["AUTHENTICATION_ERROR", "AUTHENTICATION_REQUIRED", "FORBIDDEN", "UNAUTHENTICATED"]);

/** A chave vai num cabeçalho: só ASCII imprimível, sem espaço. O resto nunca chega à rede (e a exceção do fetch poderia citá-la). */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

/** Os códigos de `errors[]` de um corpo qualquer (nada mais do corpo é lido). */
function errorCodes(body: unknown): string[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((item) => {
    const code = (item as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    return typeof code === "string" ? code : "";
  });
}

/**
 * Todos os erros da resposta trazem um caminho que termina em `email`? Então o campo foi recusado (permissão da chave). Só vale com
 * caminho: mensagem sem caminho que cita "email" não prova nada. Só a consulta de issues pergunta isso.
 */
// Histórico (fase `history`): `id` e `createdAt` obrigatórios e bem formados (senão a entrada é pulada e contada); o resto malformado vale
// como ausente. Os `*Id` passam pelo mesmo formato dos ids da fase de relações (vão para a origem e para o resolvedor).
const optionalId = relationId.nullable().optional().catch(null);
const optionalText = z.string().nullable().optional().catch(null);
const historyUserSchema = z.object({ id: relationId, name: optionalText, email: optionalText }).nullable().optional().catch(null);
const historyStateSchema = z.object({ name: optionalText, type: optionalText }).nullable().optional().catch(null);
const optionalNumber = z.number().finite().nullable().optional().catch(null);
const historyNodeSchema = z.object({
  id: relationId,
  createdAt: z.string().min(1).max(64),
  actor: historyUserSchema,
  botActor: z.object({ name: optionalText }).nullable().optional().catch(null),
  fromStateId: optionalId,
  toStateId: optionalId,
  fromState: historyStateSchema,
  toState: historyStateSchema,
  fromAssigneeId: optionalId,
  toAssigneeId: optionalId,
  fromAssignee: historyUserSchema,
  toAssignee: historyUserSchema,
  fromPriority: optionalNumber,
  toPriority: optionalNumber,
  fromTitle: optionalText,
  toTitle: optionalText,
  fromParentId: optionalId,
  toParentId: optionalId,
  fromProjectId: optionalId,
  toProjectId: optionalId,
  updatedDescription: z.boolean().nullable().optional().catch(null),
});
const historyIssueSchema = z.object({ id: relationId, history: relationConnectionSchema });
const historySchema = relationsSchema;
const issueHistorySchema = z.object({ data: z.object({ issue: z.object({ history: relationConnectionSchema }).nullable() }) });

const historyUser = (user: z.output<typeof historyUserSchema>): LinearHistoryUser | null => (user ? { id: user.id, name: user.name ?? null, email: user.email ?? null } : null);
const historyState = (state: z.output<typeof historyStateSchema>) => (state ? { name: state.name ?? null, type: state.type ?? null } : null);

/** Os `path` dos `errors` de uma resposta (nada mais do erro é lido: nem mensagem, nem código). `undefined` = erro sem caminho. */
function errorPaths(body: unknown): (readonly unknown[] | undefined)[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((item) => {
    const path = (item as { path?: unknown } | null)?.path;
    return Array.isArray(path) ? path : undefined;
  });
}
const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const startsWith = (path: readonly unknown[], prefix: readonly string[]): boolean => prefix.every((part, index) => path[index] === part);
const rawHistoryLength = (issue: unknown): number => {
  const nodes = (issue as { history?: { nodes?: unknown } } | null)?.history?.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
};

/**
 * Onde caem os `errors` de uma página do time que veio com `data` válido (revisão H1, item 3). Um campo anulável que falhou vem nulo, e a
 * linha do histórico é imutável: gravar o nó com o campo nulo seria gravar a mudança errada para sempre. Por issue (índice na resposta
 * CRUA): `"issue"` quando o erro aponta a issue mas não um nó do histórico dela (nada da issue é usado), ou os índices dos nós do
 * histórico a descartar. Erro sem caminho, ou que não aponta uma issue da página: `linear_partial_response` (a importação relê a página
 * menor, até uma issue só).
 */
function historyTaint(body: unknown, issues: readonly unknown[]): Map<number, "issue" | Set<number>> {
  const taint = new Map<number, "issue" | Set<number>>();
  for (const path of errorPaths(body)) {
    const issue = path?.[3];
    if (path === undefined || !startsWith(path, ["team", "issues", "nodes"]) || !isIndex(issue) || issue >= issues.length) throw new LinearError("linear_partial_response");
    const node = path[6];
    const current = taint.get(issue);
    if (current === "issue") continue;
    if (startsWith(path.slice(4), ["history", "nodes"]) && isIndex(node) && node < rawHistoryLength(issues[issue])) taint.set(issue, (current ?? new Set<number>()).add(node));
    else taint.set(issue, "issue");
  }
  return taint;
}

/** `drop`: os índices (na resposta crua) dos nós que vieram com erro; não são usados nem contados como fora do formato. */
function historyOf(connection: z.output<typeof relationConnectionSchema>, drop?: ReadonlySet<number>): { history: LinearHistoryNode[]; next: string | null; skipped: number } {
  const { valid, skipped } = validNodes(historyNodeSchema, drop === undefined ? connection.nodes : connection.nodes.filter((_, index) => !drop.has(index)));
  const history = valid.map(
    (node): LinearHistoryNode => ({
      id: node.id,
      createdAt: node.createdAt,
      actor: historyUser(node.actor),
      botActor: node.botActor ? { name: node.botActor.name ?? null } : null,
      fromStateId: node.fromStateId ?? null,
      toStateId: node.toStateId ?? null,
      fromState: historyState(node.fromState),
      toState: historyState(node.toState),
      fromAssigneeId: node.fromAssigneeId ?? null,
      toAssigneeId: node.toAssigneeId ?? null,
      fromAssignee: historyUser(node.fromAssignee),
      toAssignee: historyUser(node.toAssignee),
      fromPriority: node.fromPriority ?? null,
      toPriority: node.toPriority ?? null,
      fromTitle: node.fromTitle ?? null,
      toTitle: node.toTitle ?? null,
      fromParentId: node.fromParentId ?? null,
      toParentId: node.toParentId ?? null,
      fromProjectId: node.fromProjectId ?? null,
      toProjectId: node.toProjectId ?? null,
      updatedDescription: node.updatedDescription ?? null,
    }),
  );
  return { history, next: nextCursor(connection.pageInfo), skipped };
}

function emailFieldDenied(body: unknown, mode: "every" | "any"): boolean {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  const onEmail = (item: unknown): boolean => {
    const path = (item as { path?: unknown } | null)?.path;
    return Array.isArray(path) && path[path.length - 1] === "email";
  };
  return mode === "any" ? errors.some(onEmail) : errors.every(onEmail);
}

const toTeam = (node: { id: string; key: string; name: string }): LinearTeam => ({ id: node.id, key: cut(node.key, LINEAR_TEAM_KEY_MAX), name: cut(node.name, LINEAR_NAME_MAX) });

/** `INVALID_INPUT` com "Entity not found": é assim que o Linear diz que um id não existe ou não é visível. */
function entityNotFound(body: unknown): boolean {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((item) => {
      const e = item as { message?: unknown; extensions?: { code?: unknown; type?: unknown } } | null;
      return e?.extensions?.code === "INVALID_INPUT" && typeof e.message === "string" && /entity not found/i.test(e.message);
    })
  );
}

/** Lê o corpo até o teto, sob o mesmo prazo da chamada (um corpo lento não prende a requisição). */
async function readBody(response: Response, signal: AbortSignal, maxBytes: number, tooLarge: LinearFailureCode, onTimeout: LinearFailureCode): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new LinearError(tooLarge);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new LinearError(onTimeout)), { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new LinearError(tooLarge);
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error instanceof LinearError ? error : new LinearError(onTimeout);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * Cliente GraphQL do Linear com `fetch` injetável (ADR 0060). A chave pessoal vai em `Authorization` SEM `Bearer`. Toda falha vira
 * `LinearError` com um código curto; uma resposta HTTP 200 com `errors` no corpo também é falha (só na fase de relações o `data` que valida é usado; ver `request`). Nem a chave, nem o corpo, nem a
 * exceção original entram no erro.
 */
export class HttpLinearClient implements LinearClient {
  private readonly timeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: HttpLinearClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? LINEAR_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? LINEAR_LIST_TIMEOUT_MS;
    this.doFetch = options.fetch ?? fetch;
  }

  async whoami(apiKey: string): Promise<LinearIdentity> {
    const body = await this.request(apiKey, WHOAMI_QUERY, {}, this.timeoutMs);
    const parsed = identitySchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { viewer, organization } = parsed.data.data;
    return { workspace: { id: organization.id, name: cut(organization.name, LINEAR_NAME_MAX), urlKey: organization.urlKey }, viewer: { id: viewer.id } };
  }

  async listTeams(apiKey: string): Promise<LinearTeam[]> {
    const teams: LinearTeam[] = [];
    const deadline = Date.now() + this.listTimeoutMs;
    let after: string | null = null;
    for (let page = 0; page < LINEAR_TEAM_MAX_PAGES && teams.length < LINEAR_TEAM_CEILING; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LinearError("linear_unavailable");
      const body = await this.request(apiKey, TEAMS_QUERY, { after }, Math.min(this.timeoutMs, remaining));
      const parsed = teamsSchema.safeParse(body);
      if (!parsed.success) throw new LinearError("linear_unavailable");
      const result = parsed.data.data.teams;
      for (const node of result.nodes) teams.push(toTeam(node));
      if (!result.pageInfo.hasNextPage || result.pageInfo.endCursor === null) break;
      after = result.pageInfo.endCursor;
    }
    return teams.slice(0, LINEAR_TEAM_CEILING);
  }

  async getTeam(apiKey: string, teamId: string): Promise<LinearTeam | null> {
    const body = await this.request(apiKey, TEAM_QUERY, { id: teamId }, this.timeoutMs, true);
    if (body === null) return null;
    const parsed = teamSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    return parsed.data.data.team ? toTeam(parsed.data.data.team) : null;
  }

  async countTeamIssues(apiKey: string, teamId: string): Promise<number> {
    const body = await this.request(apiKey, COUNT_QUERY, { id: teamId }, this.timeoutMs);
    const parsed = countSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    return parsed.data.data.team.issueCount;
  }

  async listTeamProjects(apiKey: string, teamId: string, after: string | null, options: LinearProjectsOptions = {}): Promise<LinearProjectsPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_IMPORT_PAGE_SIZE), 1), 250);
    const withContent = options.withContent !== false;
    const withEmail = options.withEmail !== false;
    // O Linear recusou o `email` (permissão da chave) → `linear_email_unavailable`: quem chama repete sem ele, contando a chamada no
    // orçamento do passo, e grava a recusa na hora (C2, item 4).
    const body = await this.request(apiKey, projectsQuery(withContent, withEmail), { id: teamId, after, first }, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail);
    const parsed = projectsSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.team.projects;
    const { valid, skipped } = validNodes(projectNodeSchema, nodes);
    const dueDates = valid.map((node) => readDueDate(node.targetDate));
    return {
      nodes: valid.map((node, index) => ({
        id: node.id,
        name: node.name,
        url: node.url,
        statusType: node.status?.type ?? null,
        description: node.description ?? null,
        content: node.content ?? null,
        priority: Math.round(node.priority ?? 0),
        lead: node.lead ? { id: node.lead.id, email: node.lead.email ?? null } : null,
        dueDate: dueDates[index]!.value,
      })),
      nextCursor: nextCursor(pageInfo),
      skippedInvalid: skipped,
      dueDatesInvalid: dueDates.filter((entry) => entry.ignored).length,
    };
  }

  async listTeamIssues(apiKey: string, teamId: string, after: string | null, options: LinearIssuesOptions = {}): Promise<LinearIssuesPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_IMPORT_PAGE_SIZE), 1), 250);
    const withDescription = options.withDescription !== false;
    const withEmail = options.withEmail !== false;
    // O Linear recusou o `email` (permissão da chave) → `linear_email_unavailable`: quem chama repete sem ele, contando a chamada no
    // orçamento do passo, e grava a recusa na hora (C2, item 4).
    const body = await this.request(apiKey, issuesQuery(withDescription, withEmail), { id: teamId, after, first }, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail);
    const parsed = issuesSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.team.issues;
    const { valid, skipped } = validNodes(issueNodeSchema, nodes);
    const dueDates = valid.map((node) => readDueDate(node.dueDate));
    return {
      nodes: valid.map((node, index) => ({
        id: node.id,
        identifier: node.identifier,
        url: node.url,
        title: node.title,
        description: node.description ?? null,
        priority: Math.round(node.priority),
        updatedAt: node.updatedAt,
        trashed: node.trashed === true,
        stateType: node.state.type,
        parentId: node.parent?.id ?? null,
        projectId: node.project?.id ?? null,
        assignee: node.assignee ? { id: node.assignee.id, email: node.assignee.email ?? null } : null,
        createdAt: node.createdAt ?? null,
        startedAt: node.startedAt ?? null,
        completedAt: node.completedAt ?? null,
        canceledAt: node.canceledAt ?? null,
        previousIdentifiers: node.previousIdentifiers ?? [],
        creator: node.creator ? { id: node.creator.id, name: node.creator.name ?? "", email: node.creator.email ?? null } : null,
        dueDate: dueDates[index]!.value,
      })),
      nextCursor: nextCursor(pageInfo),
      skippedInvalid: skipped,
      dueDatesInvalid: dueDates.filter((entry) => entry.ignored).length,
    };
  }

  async listTeamComments(apiKey: string, teamId: string, after: string | null, options: LinearCommentsOptions = {}): Promise<LinearCommentsPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_IMPORT_PAGE_SIZE), 1), 250);
    const withBody = options.withBody !== false;
    const withParentBody = withBody && options.withParentBody !== false;
    const withEmail = options.withEmail !== false;
    // O Linear recusou o `email` (permissão da chave) → `linear_email_unavailable`: quem chama repete sem ele, contando a chamada no
    // orçamento do passo, e grava a recusa na hora (C2, item 4).
    const body = await this.request(apiKey, commentsQuery(withBody, withParentBody, withEmail), { id: teamId, after, first }, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail);
    const parsed = commentsSchema.safeParse(body);
    if (!parsed.success) throw new LinearError("linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.comments;
    const { valid, skipped } = validNodes(commentNodeSchema, nodes);
    return {
      nodes: valid.map((node) => ({
        id: node.id,
        body: node.body ?? null,
        createdAt: node.createdAt,
        editedAt: node.editedAt ?? null,
        updatedAt: node.updatedAt,
        issueId: node.issue.id,
        parent: node.parent ? { id: node.parent.id, body: node.parent.body ?? null } : null,
        author: commentAuthor(node),
      })),
      nextCursor: nextCursor(pageInfo),
      skippedInvalid: skipped,
    };
  }

  async listTeamRelations(apiKey: string, teamId: string, after: string | null, options: LinearRelationsOptions = {}): Promise<LinearRelationsPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_IMPORT_PAGE_SIZE), 1), 250);
    const withRelations = options.withRelations !== false;
    const body = await this.request(apiKey, relationsQuery(withRelations), { id: teamId, after, first }, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, false, true);
    const parsed = relationsSchema.safeParse(body);
    if (!parsed.success) throw new LinearError(hasErrors(body) ? "linear_partial_response" : "linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.team.issues;
    if (!withRelations) {
      const { valid, skipped } = validNodes(relationIssueIdSchema, nodes);
      return { nodes: valid.map((node) => ({ id: node.id, relations: [], relationsNext: null })), nextCursor: nextCursor(pageInfo), skippedInvalid: skipped };
    }
    const { valid, skipped } = validNodes(relationIssueSchema, nodes);
    let skippedInvalid = skipped;
    const issues = valid.map((node) => {
      const { relations, next, skipped: bad } = relationsOf(node.relations);
      skippedInvalid += bad;
      return { id: node.id, relations, relationsNext: next };
    });
    return { nodes: issues, nextCursor: nextCursor(pageInfo), skippedInvalid };
  }

  async listIssueRelations(apiKey: string, issueId: string, after: string): Promise<LinearIssueRelationsPage> {
    const body = await this.request(apiKey, ISSUE_RELATIONS_QUERY, { id: issueId, after }, this.timeoutMs, true, LINEAR_IMPORT_MAX_BODY_BYTES, false, true);
    // A issue sumiu ou deixou de ser visível entre as duas leituras: nada a mais, e a leitura não foi completa (conta como pulada).
    if (body === null) return { relations: [], nextCursor: null, skippedInvalid: 1 };
    const parsed = issueRelationsSchema.safeParse(body);
    if (!parsed.success) throw new LinearError(hasErrors(body) ? "linear_partial_response" : "linear_unavailable");
    if (parsed.data.data.issue === null) return { relations: [], nextCursor: null, skippedInvalid: 1 };
    const { relations, next, skipped } = relationsOf(parsed.data.data.issue.relations);
    return { relations, nextCursor: next, skippedInvalid: skipped };
  }

  /**
   * `notFoundIsNull`: um "Entity not found" do Linear devolve `null` em vez de erro (usado por `getTeam`). `detectEmail`: só a consulta de
   * issues. `partialIsReducible`: só a fase de relações; uma resposta 200 com `errors` (que não sejam limite nem chave) volta como veio,
   * e quem chama usa o `data` se ele valida no esquema (os nós nulos ou fora do formato contam como pulados); se não valida, é
   * `linear_partial_response`, que a importação trata reduzindo a página. Nada do texto dos erros é lido nem guardado.
   */
  async listTeamHistory(apiKey: string, teamId: string, after: string | null, options: LinearHistoryOptions = {}): Promise<LinearHistoryPage> {
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_HISTORY_PAGE_SIZE), 1), 250);
    const withHistory = options.withHistory !== false;
    const withEmail = withHistory && options.withEmail !== false;
    const since = options.updatedSince ?? null;
    const variables: Record<string, unknown> = { id: teamId, after, first };
    if (since !== null) variables.since = since;
    // Qualquer erro no `email` (não só quando todos são nele): o Linear zera o `actor` inteiro e rebaixaria um autor casado. Quem chama
    // repete sem o e-mail, como nas outras fases. `data` válido com outros `errors` é usado (como na fase de relações).
    const body = await this.request(apiKey, historyQuery(withHistory, withEmail, since !== null), variables, this.timeoutMs, false, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail ? "any" : false, true);
    const parsed = historySchema.safeParse(body);
    if (!parsed.success) throw new LinearError(hasErrors(body) ? "linear_partial_response" : "linear_unavailable");
    const { nodes, pageInfo } = parsed.data.data.team.issues;
    if (!withHistory) {
      const { valid, skipped } = validNodes(relationIssueIdSchema, nodes);
      return { nodes: valid.map((node) => ({ id: node.id, history: [], historyNext: null })), nextCursor: nextCursor(pageInfo), skippedInvalid: skipped, historyErrors: 0 };
    }
    const taint = hasErrors(body) ? historyTaint(body, nodes) : new Map<number, "issue" | Set<number>>();
    let skippedInvalid = 0;
    let historyErrors = 0;
    const result: LinearHistoryIssueNode[] = [];
    for (const [index, raw] of nodes.entries()) {
      const marks = taint.get(index);
      if (marks !== undefined) historyErrors += 1;
      if (marks === "issue") continue;
      const parsed = historyIssueSchema.safeParse(raw);
      if (!parsed.success) {
        skippedInvalid += 1;
        continue;
      }
      const { history, next, skipped: bad } = historyOf(parsed.data.history, marks);
      skippedInvalid += bad;
      result.push({ id: parsed.data.id, history, historyNext: next });
    }
    return { nodes: result, nextCursor: nextCursor(pageInfo), skippedInvalid, historyErrors };
  }

  /**
   * `first`: 180 por padrão (completa as 200), entre 1 e 180. A issue que sumiu ou deixou de ser visível entre as duas leituras não traz
   * nada a mais e a leitura fica INCOMPLETA (segura a marca d'água: a próxima sincronização relê). `errors` com `data` válido: o nó do
   * histórico apontado pelo `path` não vem e a leitura fica incompleta; erro que não aponta um nó do histórico é `linear_partial_response`.
   */
  async listIssueHistory(apiKey: string, issueId: string, after: string, options: { withEmail?: boolean; first?: number } = {}): Promise<LinearIssueHistoryPage> {
    const withEmail = options.withEmail !== false;
    const first = Math.min(Math.max(Math.trunc(options.first ?? LINEAR_HISTORY_EXTRA_PAGE), 1), LINEAR_HISTORY_EXTRA_PAGE);
    const body = await this.request(apiKey, issueHistoryQuery(withEmail), { id: issueId, after, first }, this.timeoutMs, true, LINEAR_IMPORT_MAX_BODY_BYTES, withEmail ? "any" : false, true);
    const gone = { history: [], nextCursor: null, skippedInvalid: 0, incomplete: true };
    if (body === null) return gone;
    const parsed = issueHistorySchema.safeParse(body);
    if (!parsed.success) throw new LinearError(hasErrors(body) ? "linear_partial_response" : "linear_unavailable");
    if (parsed.data.data.issue === null) return gone;
    const connection = parsed.data.data.issue.history;
    const drop = new Set<number>();
    for (const path of hasErrors(body) ? errorPaths(body) : []) {
      const node = path?.[3];
      if (path === undefined || !startsWith(path, ["issue", "history", "nodes"]) || !isIndex(node) || node >= connection.nodes.length) throw new LinearError("linear_partial_response");
      drop.add(node);
    }
    const { history, next, skipped } = historyOf(connection, drop);
    return { history, nextCursor: next, skippedInvalid: skipped, incomplete: drop.size > 0 };
  }

  private async request(apiKey: string, query: string, variables: Record<string, unknown>, timeoutMs: number, notFoundIsNull = false, maxBytes = LINEAR_MAX_BODY_BYTES, detectEmail: boolean | "any" = false, partialIsReducible = false): Promise<unknown> {
    if (!HEADER_SAFE.test(apiKey)) throw new LinearError("linear_key_invalid");
    const importPage = maxBytes !== LINEAR_MAX_BODY_BYTES;
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal,
        // Um redirecionamento reenviaria a chave a outro destino: recusado (vira `linear_unavailable`).
        redirect: "error",
      });
    } catch {
      // Nada da exceção original é guardado: ela pode citar o endereço ou a chave. Só nas páginas da importação o prazo estourado é
      // dito à parte (`linear_timeout`): a importação repete com página menor.
      throw new LinearError(importPage && signal.aborted ? "linear_timeout" : "linear_unavailable");
    }
    // Só as páginas da importação (teto maior) distinguem "grande demais" e "prazo" de "indisponível": a importação repete com página menor.
    const body = await readBody(response, signal, maxBytes, importPage ? "linear_response_too_large" : "linear_unavailable", importPage ? "linear_timeout" : "linear_unavailable");
    const codes = errorCodes(body);
    if (detectEmail !== false && response.status < 500 && emailFieldDenied(body, detectEmail === "any" ? "any" : "every")) throw new LinearError("linear_email_unavailable");
    if (notFoundIsNull && response.status < 500 && entityNotFound(body)) return null;
    if (response.status === 429 || codes.includes("RATELIMITED")) throw new LinearError("linear_rate_limited", retryAfter(response));
    if (response.status === 401 || response.status === 403 || codes.some((code) => AUTH_CODES.has(code))) throw new LinearError("linear_key_invalid");
    if (partialIsReducible && response.status === 200 && hasErrors(body)) return body;
    if (!response.ok || body === null || codes.length > 0 || Array.isArray((body as { errors?: unknown }).errors)) throw new LinearError("linear_unavailable");
    return body;
  }
}

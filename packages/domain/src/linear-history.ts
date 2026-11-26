/**
 * Histórico das issues do Linear (ADR 0061, "Decisão da fatia 4"; TREEPM-482): a normalização pura de uma `IssueHistory` na lista
 * `changes` que `external_history_entries` guarda, e o autor pela regra dos comentários. Sem banco nem rede; o e-mail nunca chega aqui
 * (o casamento de pessoas é do resolvedor injetado, no serviço).
 *
 * Só entram as mudanças da lista da ADR: situação, responsável, prioridade, título, pai, projeto e "alterou a descrição". A mudança é
 * detectada pelos `*Id` (o objeto vem nulo também quando o recurso sumiu no Linear). Nomes de coluna, títulos antigos e nomes de pessoa
 * são texto do Linear: limpos, numa linha, cortados e neutralizados como a descrição (nada vira menção de pessoa nem de ticket do projeto).
 */
import { linearCommentAuthor, linearCommentAuthorName } from "./linear-comments.js";
import { cleanLinearText, mapLinearMarkdown, mapLinearPriority } from "./linear-import.js";

/** Teto dos títulos antigos (o mesmo do título do ticket importado). */
export const LINEAR_HISTORY_TITLE_MAX = 200;
/** Teto de nomes: coluna, responsável, autor (o mesmo do autor de comentário). */
export const LINEAR_HISTORY_NAME_MAX = 120;

/** Os tipos de coluna do Linear (`WorkflowState.type`); outro valor vira `null`. */
const STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);

/** Um usuário do Linear como a consulta o traz (o e-mail, quando pedido, fica no serviço). */
export type LinearHistoryUser = { id: string; name: string | null };
export type LinearHistoryState = { name: string | null; type: string | null };

/** Uma `IssueHistory` com só os campos que a consulta pede. */
export type LinearHistoryEntryInput = {
  id: string;
  createdAt: string;
  actor: LinearHistoryUser | null;
  botActor: { name: string | null } | null;
  fromStateId: string | null;
  toStateId: string | null;
  fromState: LinearHistoryState | null;
  toState: LinearHistoryState | null;
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

/**
 * O que o serviço sabe resolver. `person`: a pessoa do TreePM casada com o usuário do Linear (pela regra dos comentários, com o e-mail
 * que só o serviço vê), ou `null`. `ticket`: o ticket local importado daquela issue (`parent`) ou daquele projeto do Linear (`project`),
 * ou `null` quando não foi importado aqui.
 */
export type LinearHistoryResolver = {
  person(user: LinearHistoryUser): string | null;
  ticket(field: "parent" | "project", linearId: string): string | null;
};

/** Um lado do responsável: a pessoa do TreePM, o nome de exibição do Linear (`null` = apagado ou só e-mail), ou ninguém (`null`). */
export type LinearHistoryAssigneeSide = { personId: string } | { name: string | null } | null;
/** Um lado do pai ou do projeto: o ticket local (`ticketId: null` = existe no Linear mas não aqui) ou nenhum (`null`). */
export type LinearHistoryTicketSide = { ticketId: string | null } | null;
export type LinearHistoryStatusSide = { name: string; type: string | null } | null;

/** Uma mudança como `changes` a guarda (prioridade já na escala do TreePM: 0, 100…400). */
export type LinearHistoryChange =
  | { field: "status"; from: LinearHistoryStatusSide; to: LinearHistoryStatusSide }
  | { field: "assignee"; from: LinearHistoryAssigneeSide; to: LinearHistoryAssigneeSide }
  | { field: "priority"; from: number; to: number }
  | { field: "title"; from: string; to: string }
  | { field: "parent" | "project"; from: LinearHistoryTicketSide; to: LinearHistoryTicketSide }
  | { field: "description" };

/**
 * Texto curto do Linear numa linha: limpo (sem nulo nem controles), cortado ANTES do trabalho (o custo fica limitado em texto enorme),
 * espaços juntados, neutralizado como a descrição (menção de pessoa e chave do projeto) e cortado no teto.
 */
function shortText(raw: string, max: number, projectKey: string): string {
  const line = cleanLinearText(raw.length > max * 4 ? raw.slice(0, max * 4) : raw)
    .replace(/\s+/g, " ")
    .trim();
  return mapLinearMarkdown(line, projectKey, max).trim();
}

/**
 * O nome que o CHECK de `external_history_entries.external_actor_name` (migration 0046: `NOT LIKE '%@%.%'`) recusaria: um `@` seguido, a
 * qualquer distância, de um `.`. Mais largo que `looksLikeEmail` ("Ana @ Acme Inc." passa lá e não aqui). O domínio decide com ESTE
 * predicado e o banco é só a rede de segurança: uma recusa do banco prenderia a rodada inteira. Amarrado ao CHECK pela lista
 * `LINEAR_HISTORY_NAME_CASES`, conferida contra os dois.
 */
export function linearHistoryNameRefused(name: string): boolean {
  const at = name.indexOf("@");
  return at !== -1 && name.indexOf(".", at + 1) !== -1;
}

/**
 * Nome de pessoa ou robô do Linear: a regra dos comentários (nunca forma de e-mail; até 120) e sem menção de pessoa. O nome GUARDADO que o
 * banco recusaria (`linearHistoryNameRefused`) também vira sem nome (a tela mostra "Pessoa do Linear").
 */
export function linearHistoryName(raw: string | null | undefined, projectKey = ""): string | null {
  const name = linearCommentAuthorName(raw);
  if (name === null) return null;
  const safe = mapLinearMarkdown(name, projectKey, LINEAR_HISTORY_NAME_MAX).trim();
  return safe === "" || linearHistoryNameRefused(safe) ? null : safe;
}

const changed = (from: string | null, to: string | null): boolean => (from !== null || to !== null) && from !== to;

function stateSide(state: LinearHistoryState | null, projectKey: string): LinearHistoryStatusSide {
  if (state === null) return null;
  const name = state.name === null ? "" : shortText(state.name, LINEAR_HISTORY_NAME_MAX, projectKey);
  return { name, type: state.type !== null && STATE_TYPES.has(state.type) ? state.type : null };
}

function assigneeSide(id: string | null, user: LinearHistoryUser | null, resolver: LinearHistoryResolver, projectKey: string): LinearHistoryAssigneeSide {
  if (id === null) return null;
  if (user === null) return { name: null };
  const personId = resolver.person(user);
  return personId !== null ? { personId } : { name: linearHistoryName(user.name, projectKey) };
}

const ticketSide = (field: "parent" | "project", id: string | null, resolver: LinearHistoryResolver): LinearHistoryTicketSide =>
  id === null ? null : { ticketId: resolver.ticket(field, id) };

/**
 * As mudanças da lista da ADR numa entrada do histórico, na ordem fixa (situação, responsável, prioridade, título, pai, projeto,
 * descrição). Lista vazia: a entrada não é gravada (`historyIgnored`). `projectKey`: a chave do projeto do TreePM de destino.
 */
export function linearHistoryChanges(entry: LinearHistoryEntryInput, resolver: LinearHistoryResolver, projectKey = ""): LinearHistoryChange[] {
  const result: LinearHistoryChange[] = [];
  if (changed(entry.fromStateId, entry.toStateId)) {
    result.push({ field: "status", from: stateSide(entry.fromState, projectKey), to: stateSide(entry.toState, projectKey) });
  }
  if (changed(entry.fromAssigneeId, entry.toAssigneeId)) {
    result.push({
      field: "assignee",
      from: assigneeSide(entry.fromAssigneeId, entry.fromAssignee, resolver, projectKey),
      to: assigneeSide(entry.toAssigneeId, entry.toAssignee, resolver, projectKey),
    });
  }
  if (entry.toPriority !== null) {
    const from = mapLinearPriority(entry.fromPriority ?? 0);
    const to = mapLinearPriority(entry.toPriority);
    if (from !== to) result.push({ field: "priority", from, to });
  }
  if (entry.toTitle !== null) {
    const from = shortText(entry.fromTitle ?? "", LINEAR_HISTORY_TITLE_MAX, projectKey);
    const to = shortText(entry.toTitle, LINEAR_HISTORY_TITLE_MAX, projectKey);
    if (from !== to) result.push({ field: "title", from, to });
  }
  if (changed(entry.fromParentId, entry.toParentId)) {
    result.push({ field: "parent", from: ticketSide("parent", entry.fromParentId, resolver), to: ticketSide("parent", entry.toParentId, resolver) });
  }
  if (changed(entry.fromProjectId, entry.toProjectId)) {
    result.push({ field: "project", from: ticketSide("project", entry.fromProjectId, resolver), to: ticketSide("project", entry.toProjectId, resolver) });
  }
  if (entry.updatedDescription === true) result.push({ field: "description" });
  return result;
}

/** Quem fez a mudança no Linear: usuário (com o id, para o casamento), robô (só o nome) ou ninguém (apagado ou desconhecido). */
export type LinearHistoryAuthor = { kind: "user"; id: string; name: string | null } | { kind: "bot"; id: null; name: string | null };

export function linearHistoryAuthor(entry: Pick<LinearHistoryEntryInput, "actor" | "botActor">, projectKey = ""): LinearHistoryAuthor | null {
  if (entry.actor !== null) return { kind: "user", id: entry.actor.id, name: linearHistoryName(entry.actor.name, projectKey) };
  if (entry.botActor !== null) return { kind: "bot", id: null, name: linearHistoryName(entry.botActor.name, projectKey) };
  return null;
}

export type LinearHistoryActorColumns = { actorPersonId: string | null; externalActorName: string | null };

/**
 * As colunas do autor, pela regra dos comentários (`linearCommentAuthor`): pessoa casada quando o e-mail foi lido; sem e-mail legível,
 * o autor já gravado (`current`) não muda; robô sempre o nome; autor nulo → os dois nulos. Nunca quem sincroniza (o serviço não casa).
 */
export function linearHistoryActor(input: {
  author: LinearHistoryAuthor | null;
  emailReadable: boolean;
  matchedPersonId: string | null;
  current: LinearHistoryActorColumns | null;
}): LinearHistoryActorColumns {
  const columns = linearCommentAuthor({
    author: input.author === null ? null : { kind: input.author.kind, name: input.author.name },
    emailReadable: input.emailReadable,
    matchedPersonId: input.matchedPersonId,
    current: input.current === null ? null : { authorPersonId: input.current.actorPersonId, externalAuthorName: input.current.externalActorName },
  });
  return { actorPersonId: columns.authorPersonId, externalActorName: columns.externalAuthorName };
}

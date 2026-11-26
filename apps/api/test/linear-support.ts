import type pg from "pg";
import { expect } from "vitest";
import { useHarness } from "./harness.js";
import { LINEAR_CONFIG } from "./helpers.js";
import { teamsBody, whoamiBody } from "./linear-fake-fetch.js";
import type { LinearCall, LinearReply } from "./linear-fake-fetch.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

export const KEY = "lin_api_SEGREDO_A_1111aaaa";
export const KEY_B = "lin_api_SEGREDO_B_2222bbbb";
export const TEAM_ENG = { id: "team-eng", key: "ENG", name: "Engenharia" };
export const TEAM_OPS = { id: "team-ops", key: "OPS", name: "Operações" };
export const WORKSPACE = { id: "ws-1", name: "Acme", urlKey: "acme" };

/** Responde pela consulta: `Whoami` e `Teams` com os dados dados; a chave decide qual workspace e quais times a pessoa enxerga. */
export type LinearWorld = Record<string, { workspace: typeof WORKSPACE; teams: { id: string; key: string; name: string }[]; viewer?: string } | "invalid" | "rate" | "down">;

export function linearWorld(world: LinearWorld): (call: LinearCall) => LinearReply {
  return (call) => {
    const entry = world[call.headers["authorization"] ?? ""];
    if (entry === undefined || entry === "invalid") return { status: 400, body: { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] } };
    if (entry === "rate") return { status: 429, headers: { "Retry-After": "42" }, body: {} };
    if (entry === "down") return { status: 503, body: {} };
    if (call.query.includes("team(id")) return { body: { data: { team: entry.teams.find((team) => team.id === call.variables["id"]) ?? null } } };
    return call.query.includes("viewer") ? { body: whoamiBody(entry.workspace, entry.viewer ?? "viewer-1") } : { body: teamsBody(entry.teams) };
  };
}

export function useLinearHarness(config = LINEAR_CONFIG) {
  const h = useHarness(config);
  const put = (who: Who, apiKey: string = KEY) => h.call("PUT", "/api/linear/connection", as(who), { apiKey });
  return { h, put };
}

// ---- importação (ADR 0060, fatia 2) ----

export type FakeIssue = {
  id: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  priority?: number;
  state?: string;
  parent?: string | null;
  project?: string | null;
  assignee?: { id: string; email: string } | null;
  trashed?: boolean;
  updatedAt?: string;
  url?: string;
  /** Os campos da sincronização (ADR 0061). */
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  previousIdentifiers?: string[];
  creator?: { id: string; name: string; email: string } | null;
  /** O prazo (ADR 0064): só vai no nó quando dado (ausente = o Linear não mandou a chave). */
  dueDate?: unknown;
};
export type FakeProject = { id: string; name: string; url?: string; status?: string; description?: string; content?: string | null; priority?: number; lead?: { id: string; email: string } | null; targetDate?: unknown };
/** O que a consulta de issues pediu (lido do texto e das variáveis da chamada). */
export type FakeIssueAsk = { first: number; after: string | null; withDescription: boolean; withEmail: boolean };
export type FakeTeamData = {
  projects: FakeProject[];
  issues: FakeIssue[];
  /** Responde no lugar do mundo (corpo enorme, erro de campo, limite...); `undefined` deixa o mundo responder. Só para issues. */
  override?: (call: LinearCall, ask: FakeIssueAsk) => LinearReply | undefined;
  /** Responde no lugar do mundo para projetos (corpo enorme, erro de campo...); `undefined` deixa o mundo responder. */
  projectsOverride?: (call: LinearCall, ask: FakeProjectAsk) => LinearReply | undefined;
  /** Chamado antes de cada resposta de issues (para mexer no mundo ENTRE páginas). */
  onIssuesPage?: (ask: FakeIssueAsk) => void;
  /** Comentários das issues do time (ADR 0061, fatia 2), já na ordem do Linear (mais novos primeiro); ausente = nenhum. */
  comments?: FakeComment[];
  /** Responde no lugar do mundo para comentários (limite, corpo enorme...); `undefined` deixa o mundo responder. */
  commentsOverride?: (call: LinearCall, ask: FakeCommentAsk) => LinearReply | undefined;
  /** Relações (ADR 0061, fatia 3): cada uma aparece em `relations` da issue de ORIGEM (`from`), na ordem da lista. */
  relations?: FakeRelation[];
  /** Responde no lugar do mundo para a página de relações do time (limite, prazo...); `undefined` deixa o mundo responder. */
  relationsOverride?: (call: LinearCall, ask: FakeRelationAsk) => LinearReply | undefined;
  /**
   * Issues "envenenadas": a página de relações que as inclui responde 200 com `data: null` e `errors` (como o Linear quando a chave não
   * enxerga a outra ponta de um `relatedIssue: Issue!`). A releitura só com os ids (sem `relations`) passa.
   */
  poisoned?: string[];
  /** Issues cuja página EXTRA de relações (`issue(id){relations}`) responde 200 com `errors`. */
  poisonedExtra?: string[];
  /** Histórico (ADR 0061, fatia 4) por id de issue, já na ordem do Linear (mais recentes primeiro); ausente = nenhuma entrada. */
  history?: Record<string, FakeHistoryEntry[]>;
  /** Responde no lugar do mundo para o histórico (página do time ou extra de uma issue); `undefined` deixa o mundo responder. */
  historyOverride?: (call: LinearCall, ask: FakeHistoryAsk) => LinearReply | undefined;
  /** Issues cuja presença na página de histórico do time faz a resposta vir com `data: null` e `errors` (a releitura só dos ids passa). */
  poisonedHistory?: string[];
  /** Issues cuja página EXTRA de histórico responde 200 com `errors` e `data: null`. */
  poisonedHistoryExtra?: string[];
};
/**
 * Uma entrada do histórico como o Linear a devolve (`IssueHistory`). Os campos ausentes vêm nulos; `actor` com e-mail (o mundo o tira
 * quando a consulta não pede), `bot` vira `botActor`. Os `*Id` de situação, responsável, pai e projeto são preenchidos a partir dos objetos
 * quando não dados (`fromStateId` pode ser dado sem `fromState` para simular o recurso apagado).
 */
export type FakeHistoryUser = { id: string; name: string | null; email: string | null };
export type FakeHistoryEntry = {
  id: string;
  createdAt?: string;
  actor?: FakeHistoryUser | null;
  bot?: string;
  fromState?: { id: string; name: string; type: string } | null;
  toState?: { id: string; name: string; type: string } | null;
  fromStateId?: string | null;
  toStateId?: string | null;
  fromAssignee?: FakeHistoryUser | null;
  toAssignee?: FakeHistoryUser | null;
  fromAssigneeId?: string | null;
  toAssigneeId?: string | null;
  fromPriority?: number | null;
  toPriority?: number | null;
  fromTitle?: string | null;
  toTitle?: string | null;
  fromParentId?: string | null;
  toParentId?: string | null;
  fromProjectId?: string | null;
  toProjectId?: string | null;
  updatedDescription?: boolean | null;
};
/** O que a consulta de histórico pediu. `issueId`: a página extra de uma issue (nulo = a página do time). */
export type FakeHistoryAsk = { first: number; after: string | null; since: string | null; withHistory: boolean; withEmail: boolean; issueId: string | null };
/** Entradas por issue na página do time (a do cliente) e na página extra de uma issue. */
const FAKE_HISTORY_FIRST = 20;
const FAKE_ISSUE_HISTORY_PAGE = 180;
export const fakeHistoryNode = (e: FakeHistoryEntry, withEmail: boolean): Record<string, unknown> => {
  const user = (u: FakeHistoryUser | null | undefined) => (u ? (withEmail ? { id: u.id, name: u.name, email: u.email } : { id: u.id, name: u.name }) : null);
  const state = (s: { name: string; type: string } | null | undefined) => (s ? { name: s.name, type: s.type } : null);
  return {
    id: e.id,
    createdAt: e.createdAt ?? "2026-04-01T10:00:00.000Z",
    actor: user(e.actor),
    botActor: e.bot ? { name: e.bot } : null,
    fromStateId: e.fromStateId !== undefined ? e.fromStateId : (e.fromState?.id ?? null),
    toStateId: e.toStateId !== undefined ? e.toStateId : (e.toState?.id ?? null),
    fromState: state(e.fromState),
    toState: state(e.toState),
    fromAssigneeId: e.fromAssigneeId !== undefined ? e.fromAssigneeId : (e.fromAssignee?.id ?? null),
    toAssigneeId: e.toAssigneeId !== undefined ? e.toAssigneeId : (e.toAssignee?.id ?? null),
    fromAssignee: user(e.fromAssignee),
    toAssignee: user(e.toAssignee),
    fromPriority: e.fromPriority ?? null,
    toPriority: e.toPriority ?? null,
    fromTitle: e.fromTitle ?? null,
    toTitle: e.toTitle ?? null,
    fromParentId: e.fromParentId ?? null,
    toParentId: e.toParentId ?? null,
    fromProjectId: e.fromProjectId ?? null,
    toProjectId: e.toProjectId ?? null,
    updatedDescription: e.updatedDescription ?? null,
  };
};
/** A conexão `history` de uma issue a partir de `start` (cursor = deslocamento). */
const fakeHistoryConnection = (all: FakeHistoryEntry[], start: number, size: number, withEmail: boolean) => {
  const end = start + size;
  return { nodes: all.slice(start, end).map((e) => fakeHistoryNode(e, withEmail)), pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null } };
};
const poisonedHistoryReply = (): LinearReply => ({
  body: { data: null, errors: [{ message: `Entity not found ${LINEAR_ERROR_SENTINEL}`, path: ["team", "issues", "nodes", 0, "history", "nodes", 0, "actor"], extensions: { code: "INPUT_ERROR", userPresentableMessage: LINEAR_ERROR_SENTINEL } }] },
});
/** As issues do time que a fase `history` lê: fora da lixeira e, com o filtro, só as alteradas depois de `since`. */
export const historyIssues = (team: FakeTeamData, since: string | null): FakeIssue[] =>
  team.issues.filter((issue) => !issue.trashed && (since === null || Date.parse(issue.updatedAt ?? "2026-11-01T10:00:00.000Z") > Date.parse(since)));
/** O texto do erro do Linear nas respostas envenenadas: nunca pode aparecer em log, resposta ou evento. */
export const LINEAR_ERROR_SENTINEL = "SEGREDO-DO-ERRO-DO-LINEAR-7d1f";
const poisonedReply = (): LinearReply => ({
  body: { data: null, errors: [{ message: `Entity not found: Issue ${LINEAR_ERROR_SENTINEL}`, path: ["team", "issues", "nodes", 0, "relations", "nodes", 0, "relatedIssue"], extensions: { code: "INPUT_ERROR", userPresentableMessage: LINEAR_ERROR_SENTINEL } }] },
});
/** Uma relação do Linear: `from` é a issue de origem (`issue`), `to` a outra ponta (`relatedIssue`). */
export type FakeRelation = { id: string; type: string; from: string; to: string };
export type FakeRelationAsk = { first: number; after: string | null };
/** Relações por issue na página do time (a do cliente) e na página seguinte de uma issue. */
const FAKE_RELATIONS_FIRST = 20;
const FAKE_ISSUE_RELATIONS_PAGE = 100;
const fakeRelationNode = (r: FakeRelation) => ({ id: r.id, type: r.type, relatedIssue: { id: r.to } });
/** A conexão `relations` de uma issue a partir de `start` (cursor = deslocamento). */
const fakeRelationConnection = (all: FakeRelation[], start: number, size: number) => {
  const end = start + size;
  return { nodes: all.slice(start, end).map(fakeRelationNode), pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null } };
};
/** Um comentário do Linear: `user` com e-mail (o mundo o tira quando a consulta não pede), robô, usuário de fora, ou nenhum (apagado). */
export type FakeComment = {
  id: string;
  issue: string;
  body?: string;
  createdAt?: string;
  editedAt?: string | null;
  updatedAt?: string;
  parent?: { id: string; body: string } | null;
  user?: { id: string; name: string; email: string | null } | null;
  bot?: string;
  external?: string;
};
export type FakeCommentAsk = { first: number; after: string | null; withEmail: boolean; withBody: boolean; withParentBody: boolean };
export const fakeCommentNode = (c: FakeComment, ask: Pick<FakeCommentAsk, "withEmail" | "withBody" | "withParentBody">): Record<string, unknown> => {
  const node: Record<string, unknown> = {
    id: c.id,
    createdAt: c.createdAt ?? "2026-03-05T10:00:00.000Z",
    editedAt: c.editedAt ?? null,
    updatedAt: c.updatedAt ?? c.editedAt ?? c.createdAt ?? "2026-03-05T10:00:00.000Z",
    issue: { id: c.issue },
    parent: c.parent ? (ask.withParentBody ? c.parent : { id: c.parent.id }) : null,
    user: c.user ? (ask.withEmail ? c.user : { id: c.user.id, name: c.user.name }) : null,
    externalUser: c.external ? { name: c.external } : null,
    botActor: c.bot ? { name: c.bot } : null,
  };
  if (ask.withBody) node["body"] = c.body ?? `Comentário ${c.id}`;
  return node;
};
export const PAGE = 50;
/** O que a consulta de projetos pediu: o tamanho da página, o que ela traria (ids) e se pediu o conteúdo longo e o e-mail do líder. */
export type FakeProjectAsk = { first: number; ids: string[]; withContent: boolean; withEmail: boolean };

export const fakeIssueNode = (issue: FakeIssue, index = 0) => ({
  id: issue.id,
  identifier: issue.identifier ?? `ENG-${index + 1}`,
  url: issue.url ?? `https://linear.app/acme/issue/${issue.identifier ?? `ENG-${index + 1}`}`,
  title: issue.title ?? `Issue ${issue.id}`,
  description: issue.description === undefined ? `Descrição de ${issue.id}` : issue.description,
  priority: issue.priority ?? 0,
  updatedAt: issue.updatedAt ?? "2026-11-01T10:00:00.000Z",
  trashed: issue.trashed ?? false,
  state: { type: issue.state ?? "unstarted" },
  parent: issue.parent ? { id: issue.parent } : null,
  project: issue.project ? { id: issue.project } : null,
  assignee: issue.assignee ?? null,
  createdAt: issue.createdAt === undefined ? "2026-03-03T10:00:00.000Z" : issue.createdAt,
  startedAt: issue.startedAt ?? null,
  completedAt: issue.completedAt ?? null,
  canceledAt: issue.canceledAt ?? null,
  previousIdentifiers: issue.previousIdentifiers ?? [],
  creator: issue.creator ?? null,
  ...("dueDate" in issue ? { dueDate: issue.dueDate } : {}),
});

export const fakeProjectNode = (p: FakeProject, withContent: boolean, withEmail: boolean): Record<string, unknown> => {
  const node: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    url: p.url ?? `https://linear.app/acme/project/${p.id}`,
    status: { type: p.status ?? "backlog" },
    description: p.description ?? "",
    priority: p.priority ?? 0,
    lead: p.lead ? (withEmail ? p.lead : { id: p.lead.id }) : null,
    ...("targetDate" in p ? { targetDate: p.targetDate } : {}),
  };
  if (withContent) node["content"] = p.content ?? null;
  return node;
};

const pageOf = <T>(items: T[], after: unknown, key: "projects" | "issues", size = PAGE) => {
  const start = typeof after === "string" ? Number(after) : 0;
  const nodes = items.slice(start, start + size);
  const end = start + size;
  return { data: { team: { [key]: { nodes, pageInfo: { hasNextPage: end < items.length, endCursor: end < items.length ? String(end) : null } } } } };
};

/** O mundo do Linear com os dados de importação por time (id do time → projetos e issues). Cursor = deslocamento. */
export function linearImportWorld(world: LinearWorld, data: Record<string, FakeTeamData>): (call: LinearCall) => LinearReply {
  const base = linearWorld(world);
  return (call) => {
    const entry = world[call.headers["authorization"] ?? ""];
    const id = String(call.variables["id"] ?? "");
    // As relações seguintes de UMA issue: a variável é o id da issue, não o do time.
    if (entry !== undefined && typeof entry !== "string" && call.query.includes("IssueRelations")) {
      const owner = Object.values(data).find((candidate) => candidate.issues.some((issue) => issue.id === id));
      if (owner === undefined) return { body: { data: { issue: null } } };
      if (owner.poisonedExtra?.includes(id) === true) return poisonedReply();
      const all = (owner.relations ?? []).filter((r) => r.from === id);
      return { body: { data: { issue: { relations: fakeRelationConnection(all, Number(call.variables["after"] ?? 0), FAKE_ISSUE_RELATIONS_PAGE) } } } };
    }
    // O histórico seguinte de UMA issue (fase `history`): a variável é o id da issue.
    if (entry !== undefined && typeof entry !== "string" && call.query.includes("IssueHistory")) {
      const owner = Object.values(data).find((candidate) => candidate.issues.some((issue) => issue.id === id));
      if (owner === undefined) return { body: { data: { issue: null } } };
      const ask: FakeHistoryAsk = { first: Number(call.variables["first"] ?? FAKE_ISSUE_HISTORY_PAGE), after: typeof call.variables["after"] === "string" ? call.variables["after"] : null, since: null, withHistory: true, withEmail: /actor \{ id name email \}/.test(call.query), issueId: id };
      const custom = owner.historyOverride?.(call, ask);
      if (custom !== undefined) return custom;
      if (owner.poisonedHistoryExtra?.includes(id) === true) return poisonedHistoryReply();
      return { body: { data: { issue: { history: fakeHistoryConnection(owner.history?.[id] ?? [], Number(ask.after ?? 0), ask.first, ask.withEmail) } } } };
    }
    const team = data[id];
    if (entry !== undefined && typeof entry !== "string" && team !== undefined && call.query.includes("TeamHistory")) {
      const ask: FakeHistoryAsk = {
        first: Number(call.variables["first"] ?? 10),
        after: typeof call.variables["after"] === "string" ? call.variables["after"] : null,
        since: typeof call.variables["since"] === "string" ? call.variables["since"] : null,
        withHistory: call.query.includes("history(first"),
        withEmail: /actor \{ id name email \}/.test(call.query),
        issueId: null,
      };
      const custom = team.historyOverride?.(call, ask);
      if (custom !== undefined) return custom;
      const live = historyIssues(team, ask.since);
      if (!ask.withHistory) return { body: pageOf(live.map((issue) => ({ id: issue.id })), ask.after, "issues", ask.first) };
      const start = ask.after === null ? 0 : Number(ask.after);
      if (live.slice(start, start + ask.first).some((issue) => team.poisonedHistory?.includes(issue.id) === true)) return poisonedHistoryReply();
      const nodes = live.map((issue) => ({ id: issue.id, history: fakeHistoryConnection(team.history?.[issue.id] ?? [], 0, FAKE_HISTORY_FIRST, ask.withEmail) }));
      return { body: pageOf(nodes, ask.after, "issues", ask.first) };
    }
    if (entry !== undefined && typeof entry !== "string" && team !== undefined) {
      if (call.query.includes("TeamRelations")) {
        const ask: FakeRelationAsk = { first: Number(call.variables["first"] ?? PAGE), after: typeof call.variables["after"] === "string" ? call.variables["after"] : null };
        const custom = team.relationsOverride?.(call, ask);
        if (custom !== undefined) return custom;
        const live = team.issues.filter((issue) => !issue.trashed);
        // Releitura só com os ids (para andar o cursor depois de uma issue envenenada).
        if (!call.query.includes("relations(first")) return { body: pageOf(live.map((issue) => ({ id: issue.id })), ask.after, "issues", ask.first) };
        const start = ask.after === null ? 0 : Number(ask.after);
        if (live.slice(start, start + ask.first).some((issue) => team.poisoned?.includes(issue.id) === true)) return poisonedReply();
        const nodes = live.map((issue) => ({ id: issue.id, relations: fakeRelationConnection((team.relations ?? []).filter((r) => r.from === issue.id), 0, FAKE_RELATIONS_FIRST) }));
        return { body: pageOf(nodes, ask.after, "issues", ask.first) };
      }
      if (call.query.includes("issueCount")) return { body: { data: { team: { issueCount: team.issues.filter((issue) => !issue.trashed).length } } } };
      if (call.query.includes("projects(")) {
        const first = Number(call.variables["first"] ?? PAGE);
        const start = typeof call.variables["after"] === "string" ? Number(call.variables["after"]) : 0;
        const ask: FakeProjectAsk = { first, ids: team.projects.slice(start, start + first).map((p) => p.id), withContent: /\bcontent\b/.test(call.query), withEmail: /lead \{ id email \}/.test(call.query) };
        const custom = team.projectsOverride?.(call, ask);
        if (custom !== undefined) return custom;
        return { body: pageOf(team.projects.map((p) => fakeProjectNode(p, ask.withContent, ask.withEmail)), call.variables["after"], "projects", first) };
      }
      if (call.query.includes("comments(")) {
        const ask: FakeCommentAsk = {
          first: Number(call.variables["first"] ?? PAGE),
          after: typeof call.variables["after"] === "string" ? call.variables["after"] : null,
          withEmail: /user \{ id name email \}/.test(call.query),
          withBody: /\bid body createdAt\b/.test(call.query),
          withParentBody: /parent \{ id body \}/.test(call.query),
        };
        const custom = team.commentsOverride?.(call, ask);
        if (custom !== undefined) return custom;
        const all = (team.comments ?? []).map((c) => fakeCommentNode(c, ask));
        const start = ask.after === null ? 0 : Number(ask.after);
        const end = start + ask.first;
        return { body: { data: { comments: { nodes: all.slice(start, end), pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null } } } } };
      }
      if (call.query.includes("issues(")) {
        const ask: FakeIssueAsk = {
          first: Number(call.variables["first"] ?? PAGE),
          after: typeof call.variables["after"] === "string" ? call.variables["after"] : null,
          withDescription: /\bdescription\b/.test(call.query),
          withEmail: /assignee \{ id email \}/.test(call.query),
        };
        team.onIssuesPage?.(ask);
        const custom = team.override?.(call, ask);
        if (custom !== undefined) return custom;
        // A ordem é a do Linear: mais novas primeiro (o fim da lista de teste é o mais velho; o teste decide o que isso significa).
        const nodes = team.issues.map((issue, index) => {
          const node: Record<string, unknown> = fakeIssueNode(issue, index);
          if (!ask.withDescription) delete node["description"];
          if (!ask.withEmail && node["assignee"]) node["assignee"] = { id: (node["assignee"] as { id: string }).id };
          if (!ask.withEmail && node["creator"]) node["creator"] = { id: (node["creator"] as { id: string }).id, name: (node["creator"] as { name: string }).name };
          return node;
        });
        return { body: pageOf(nodes, call.variables["after"], "issues", ask.first) };
      }
    }
    return base(call);
  };
}

/** Liga o projeto ao time como administrador (chave KEY no mundo dado) e deixa o mundo do Linear programado com os dados. */
export async function linkWithData(
  h: Pick<ReturnType<typeof useLinearHarness>["h"], "linear" | "call">,
  put: ReturnType<typeof useLinearHarness>["put"],
  projectId: string,
  data: Record<string, FakeTeamData>,
  extra: LinearWorld = {},
  team = TEAM_ENG,
): Promise<void> {
  const world: LinearWorld = { [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG, TEAM_OPS] }, ...extra };
  h.linear().use(linearImportWorld(world, data));
  const connected = await put("admin");
  if (connected.status !== 200) throw new Error(`conectar falhou: ${connected.status}`);
  const res = await h.call("POST", `/api/projects/${projectId}/linear`, as("admin"), { teamId: team.id, confirmTeamKey: team.key });
  if (res.status !== 201) throw new Error(`ligar falhou: ${res.status} ${JSON.stringify(res.body)}`);
}

/**
 * Relações do Linear (R3, item 5): o estado das origens é coerente. Nenhuma "removida aqui" nem forma antiga (`superseded`) com linha, e
 * toda origem com linha aponta para uma linha que existe.
 */
export async function expectRelationOriginsCoherent(pool: pg.Pool): Promise<void> {
  const bad = await pool.query(`select o.external_id, o.removed_here_at is not null as removed, o.applied->>'superseded' as superseded, r.id is not null as line
    from external_item_refs o left join ticket_relations r on r.id = o.local_id
    where o.kind = 'relation' and o.local_id is not null and (o.removed_here_at is not null or o.applied->>'superseded' = 'true' or r.id is null)`);
  expect(bad.rows, "origem de relação incoerente").toEqual([]);
}

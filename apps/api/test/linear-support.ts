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
};
/** O que a consulta de issues pediu (lido do texto e das variáveis da chamada). */
export type FakeIssueAsk = { first: number; after: string | null; withDescription: boolean; withEmail: boolean };
export type FakeTeamData = {
  projects: { id: string; name: string; url?: string; status?: string }[];
  issues: FakeIssue[];
  /** Responde no lugar do mundo (corpo enorme, erro de campo, limite...); `undefined` deixa o mundo responder. Só para issues. */
  override?: (call: LinearCall, ask: FakeIssueAsk) => LinearReply | undefined;
  /** Chamado antes de cada resposta de issues (para mexer no mundo ENTRE páginas). */
  onIssuesPage?: (ask: FakeIssueAsk) => void;
};
export const PAGE = 50;

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
});

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
    const team = data[id];
    if (entry !== undefined && typeof entry !== "string" && team !== undefined) {
      if (call.query.includes("issueCount")) return { body: { data: { team: { issueCount: team.issues.filter((issue) => !issue.trashed).length } } } };
      if (call.query.includes("projects(")) return { body: pageOf(team.projects.map((p) => ({ id: p.id, name: p.name, url: p.url ?? `https://linear.app/acme/project/${p.id}`, status: { type: p.status ?? "backlog" } })), call.variables["after"], "projects") };
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
  h: ReturnType<typeof useLinearHarness>["h"],
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

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

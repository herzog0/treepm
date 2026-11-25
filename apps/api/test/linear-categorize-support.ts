import { AI_CONFIG, LINEAR_CONFIG } from "./helpers.js";
import { TEAM_ENG, linkWithData } from "./linear-support.js";
import type { FakeIssue, FakeTeamData, useLinearHarness } from "./linear-support.js";
import { as } from "./world.js";
import type { Who } from "./world.js";
import type { BranchJudgment } from "../src/assistant/ports.js";

/** Linear e IA ligados ao mesmo tempo (a categorização precisa dos dois). */
export const CATEGORIZE_CONFIG = { ...AI_CONFIG, CREDENTIALS_ENCRYPTION_KEY: LINEAR_CONFIG.CREDENTIALS_ENCRYPTION_KEY };

export const LP = { alfa: "lp-alfa", beta: "lp-beta", gama: "lp-gama" };

type Support = ReturnType<typeof useLinearHarness>;
export type Row = Record<string, unknown>;

/** O time do Linear de teste: 3 projetos e 5 issues soltas (e 4 issues dentro dos projetos). Os textos não trazem nenhum identificador do Linear. */
export const linearTeam = (): FakeTeamData => ({
  projects: [
    { id: LP.alfa, name: "Alfa" },
    { id: LP.beta, name: "Beta" },
    { id: LP.gama, name: "Gama" },
  ],
  issues: [
    { id: "a1", identifier: "ENG-1", title: "Alfa um", description: "Texto do primeiro item do Alfa", project: LP.alfa },
    { id: "a2", identifier: "ENG-2", title: "Alfa dois", description: "Texto do segundo item do Alfa", project: LP.alfa },
    { id: "b1", identifier: "ENG-3", title: "Beta um", description: "Texto do item do Beta", project: LP.beta },
    { id: "g1", identifier: "ENG-4", title: "Gama um", description: "Texto do item do Gama", project: LP.gama },
    ...[1, 2, 3, 4, 5].map((n): FakeIssue => ({ id: `s${n}`, identifier: `ENG-${4 + n}`, title: `Solta ${n}`, description: `Texto da solta ${n}` })),
  ],
});

/** A árvore que já existia no projeto: Auth (Login, Senhas, SSO > SAML), Billing (Invoices), Docs (Guias). */
export async function seedExisting(s: Support, projectId: string): Promise<Record<string, string>> {
  const { h } = s;
  const creator = h.world().people.manager;
  const ids: Record<string, string> = {};
  let number = 0;
  const add = async (title: string, parent: string | null, description = ""): Promise<void> => {
    number += 1;
    const r = await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5,$6) returning id", [projectId, number, parent, title, description, creator]);
    ids[title] = r.rows[0]?.id ?? "";
  };
  await add("Auth", null, "Tudo sobre entrar no sistema");
  await add("Login", ids["Auth"] ?? null);
  await add("Senhas", ids["Auth"] ?? null);
  await add("SSO", ids["Auth"] ?? null);
  await add("SAML", ids["SSO"] ?? null);
  await add("Billing", null, "Cobrança");
  await add("Invoices", ids["Billing"] ?? null);
  await add("Docs", null, "Documentação");
  await add("Guias", ids["Docs"] ?? null);
  await h.pool.query("update projects set next_ticket_number = $2 where id = $1", [projectId, number + 1]);
  return ids;
}

/**
 * O juiz de ramo roteirizado pelo título do pedido: cada título tem o caminho (por títulos) em que o juiz o encaixa; sem caminho,
 * "não cabe em nenhum" (a procura termina na raiz). `Solta 2` cai na faixa do meio; `Solta 3` não decide entre os ramos.
 */
const PATHS: Record<string, string[]> = { Alfa: ["Billing"], Beta: ["Auth", "SSO"], Gama: ["Docs"], "Solta 1": ["Docs"], "Solta 4": ["Auth"] };
export function scriptedJudge(input: { draft: { title: string }; current: { title: string } | null; candidates: readonly { id: string; title: string }[] }): BranchJudgment {
  const titles = input.candidates.map((candidate) => candidate.title);
  const even = (): Record<string, number> => Object.fromEntries(input.candidates.map((candidate) => [candidate.id, 1 / input.candidates.length]));
  const title = input.draft.title;
  if (title === "Solta 2") return { belongs: 0.5, choice: even() };
  if (title === "Solta 3") return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((candidate, index) => [candidate.id, index === 0 ? 0.4 : 0.6 / Math.max(1, input.candidates.length - 1)])) };
  const path = PATHS[title];
  const want = path?.[input.current === null ? 0 : path.indexOf(input.current.title) + 1];
  if (want !== undefined && titles.includes(want)) {
    const rest = input.candidates.length > 1 ? 0.1 / (input.candidates.length - 1) : 0;
    return { belongs: 0.95, choice: Object.fromEntries(input.candidates.map((candidate) => [candidate.id, input.candidates.length === 1 ? 1 : candidate.title === want ? 0.9 : rest])) };
  }
  return { belongs: 0.05, choice: even() };
}

/** Roteiro: só o `Solta 4` tem afinidade com um dos tickets soltos do destino (o Login), o que gera a proposta de agrupador novo. */
export function wireFakes(s: Support): void {
  s.h.judge().verdict = scriptedJudge;
  s.h.affinity().verdict = (input) => Object.fromEntries(input.tickets.map((ticket) => [ticket.id, input.draft.title === "Solta 4" && ticket.title === "Login" ? 0.95 : 0.1]));
}

export type ImportedWorld = { data: FakeTeamData; tree: Record<string, string> };

/** Existente + time ligado + importação concluída, para o destino dado (nulo = raiz). Devolve a árvore semeada e o mundo do Linear (mutável). */
export async function importedProject(s: Support, projectId: string, over: { destination?: string | null; destinationTitle?: string; data?: FakeTeamData } = {}): Promise<ImportedWorld> {
  const tree = await seedExisting(s, projectId);
  const data = over.data ?? linearTeam();
  await linkWithData(s.h, s.put, projectId, { [TEAM_ENG.id]: data });
  const destination = over.destinationTitle !== undefined ? (tree[over.destinationTitle] ?? null) : over.destination;
  await runImport(s, projectId, destination === undefined ? {} : { destinationTicketId: destination });
  return { data, tree };
}

/** Abre uma rodada de importação (primeira ou reimportação) e a conduz até o fim. */
export async function runImport(s: Support, projectId: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const opened = await s.h.call("POST", `/api/projects/${projectId}/linear/runs`, as("admin"), body);
  if (opened.status !== 201) throw new Error(`abrir importação: ${opened.status} ${JSON.stringify(opened.body)}`);
  let last = opened.body as Record<string, unknown>;
  for (let i = 0; i < 60 && last["done"] !== true; i += 1) {
    const res = await s.h.call("POST", `/api/projects/${projectId}/linear/runs/${opened.body.id}/step`, as("admin"));
    if (res.status !== 200) throw new Error(`passo da importação: ${res.status} ${JSON.stringify(res.body)}`);
    last = res.body;
  }
  return last;
}

export const categorizePath = (projectId: string, tail = ""): string => `/api/projects/${projectId}/linear/categorize${tail}`;

export type CategorizeView = {
  id: string;
  phase: string;
  finished: boolean;
  total: number;
  done: number;
  placed: number;
  toCheck: number;
  kept: number;
  skipped: number;
  failed: number;
  waitUntil: string | null;
  errorStreak: number;
  lastErrorCode: string | null;
  sourceRunId: string | null;
};

export const BATCH_LIMIT = 200;

/** Abre a rodada de categorização e dá passos até terminar. */
export async function categorizeAll(s: Support, projectId: string, who: Who = "admin"): Promise<CategorizeView> {
  const opened = await s.h.call("POST", categorizePath(projectId), as(who));
  if (opened.status !== 201) throw new Error(`abrir categorização: ${opened.status} ${JSON.stringify(opened.body)}`);
  let view = opened.body as CategorizeView;
  for (let i = 0; i < 40 && !view.finished; i += 1) {
    const res = await s.h.call("POST", categorizePath(projectId, `/${view.id}/step`), as(who));
    if (res.status !== 200) throw new Error(`passo da categorização: ${res.status} ${JSON.stringify(res.body)}`);
    view = res.body as CategorizeView;
  }
  return view;
}

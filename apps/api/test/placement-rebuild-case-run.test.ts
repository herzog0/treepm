import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { CaseError, caseRunCommand, parseCase, withoutOmitted } from "../scripts/placement-rebuild/case-run.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import type { ApiResponse } from "../scripts/placement-rebuild/client.js";
import type { Context } from "../scripts/placement-rebuild/commands.js";
import type { Gabarito, GabaritoTicket } from "../scripts/placement-rebuild/core.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

// Árvore inventada do caso: Pagamentos (1) › Cobrança mensal (2) › Faturas recorrentes (3); Acesso (4) › Login (5);
// Pagamentos legados (6) › Boletos antigos (7) (o ramo que o caso omite, com descendente).
const node = (number: number, title: string, parent: number | null, depth: number): GabaritoTicket => ({
  id: `old-${number}`, number, kind: "ticket", key: `TST-${number}`, title, description: "", status: "todo", parentId: parent === null ? null : `old-${parent}`, assigneeIds: [], depth,
});
const tickets = [node(1, "Pagamentos", null, 0), node(2, "Cobrança mensal", 1, 1), node(3, "Faturas recorrentes", 2, 2), node(4, "Acesso", null, 0), node(5, "Login", 4, 1), node(6, "Pagamentos legados", null, 0), node(7, "Boletos antigos", 6, 1)];

let booted: Booted;
let dir: string;
let lines: string[];
let failPlacement = false;
let client: ApiClient;
const owner = ownerPoolWithCleanup();

const guarded = {
  request: async (method: string, path: string, body?: unknown): Promise<ApiResponse> =>
    failPlacement && path.endsWith("/placement") ? ({ status: 500, body: {} } as ApiResponse) : client.request(method, path, body),
} as unknown as ApiClient;
const ctx = (): Context => ({ client: guarded, recorder: booted.recorder, dir, project: "", log: (line) => lines.push(line), sleep: () => Promise.resolve() });
const writeCase = (value: unknown): string => {
  const path = join(dir, `caso-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const base = { name: "pagamentos", request: "Cobrar pagamentos\n\nCobrança mensal dos pagamentos", expectParentKey: "TST-2" };
const measurementProjects = async () => (await owner.query<{ id: string; archived_at: Date | null }>("select id, archived_at from projects where name like 'Caso pagamentos%' order by created_at")).rows;

beforeAll(async () => {
  await owner.query("insert into organizations (org_id, name, slug) values ('org_case', 'Case', 'org_case') on conflict do nothing");
  await owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_case', 'user_case', 'Admin', 'a@case.test', 'admin') on conflict do nothing");
  const person = (await owner.query<{ id: string }>("select id from people where org_id = 'org_case' and clerk_user_id = 'user_case'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_case', 'assistant', 'rascunho-2', $1)", [person]);
  booted = await bootApp({ org: "org_case", user: "user_case", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true });
  client = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "case-run-"));
  const gabarito: Gabarito = { exportedAt: "2026-11-23T00:00:00Z", project: { id: "p", key: "TST", name: "Inventado" }, tickets };
  writeFileSync(join(dir, "gabarito.json"), JSON.stringify(gabarito));
});
afterAll(async () => {
  await booted.close();
  await owner.end();
});
beforeEach(async () => {
  lines = [];
  failPlacement = false;
  await owner.query("delete from projects where name like 'Caso pagamentos%'");
});

describe("case-run: o arquivo de caso", () => {
  it("valida os campos e as listas", () => {
    expect(() => parseCase("não é json")).toThrow(CaseError);
    expect(() => parseCase(JSON.stringify({ request: "x" }))).toThrow(/expectParentKey/);
    expect(() => parseCase(JSON.stringify({ ...base, omit: "TST-6" }))).toThrow(/omit/);
    expect(parseCase(JSON.stringify(base))).toMatchObject({ acceptKeys: [], omit: [], expectRelatedKeys: [], expectDuplicateKey: null });
    expect(parseCase(JSON.stringify({ ...base, expectRelatedKeys: ["TST-3"], expectDuplicateKey: "TST-3" }))).toMatchObject({ expectRelatedKeys: ["TST-3"], expectDuplicateKey: "TST-3" });
    expect(parseCase(JSON.stringify(base))).toMatchObject({ expectLinkKeys: [] });
    expect(parseCase(JSON.stringify({ ...base, expectLinkKeys: ["TST-3"] }))).toMatchObject({ expectLinkKeys: ["TST-3"] });
    expect(() => parseCase(JSON.stringify({ ...base, expectLinkKeys: "TST-3" }))).toThrow(/expectLinkKeys/);
    expect(() => parseCase(JSON.stringify({ ...base, expectRelatedKeys: "TST-3" }))).toThrow(/expectRelatedKeys/);
    expect(() => parseCase(JSON.stringify({ ...base, expectDuplicateKey: 3 }))).toThrow(/expectDuplicateKey/);
  });

  it("omit tira o ticket e os descendentes dele; chave inexistente é erro", () => {
    expect(withoutOmitted(tickets, ["TST-6"]).map((t) => t.key)).toEqual(["TST-1", "TST-2", "TST-3", "TST-4", "TST-5"]);
    expect(() => withoutOmitted(tickets, ["TST-99"])).toThrow(/TST-99/);
  });
});

describe("case-run: a medição", () => {
  it("roda o pedido N vezes, imprime um JSON por repetição e o resumo, e arquiva o projeto no fim", async () => {
    const ok = await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, omit: ["TST-6"] }), repeats: 2 });
    const records = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ repeat: 1, destinationKey: "TST-2", hit: true });
    expect(records[1]).toMatchObject({ repeat: 2, hit: true });
    expect(records[2]).toMatchObject({ summary: true, hits: 2, repeats: 2, distinctDestinations: [{ key: "TST-2", count: 2 }] });
    expect(ok).toBe(true);
    expect((records[0] as { probabilities: { levels: unknown[] } }).probabilities.levels.length).toBeGreaterThan(0);
    const [project] = await measurementProjects();
    expect(project?.archived_at).not.toBeNull();
    // O projeto de medição não tem o ramo omitido nem o descendente dele.
    const titles = (await owner.query<{ title: string }>("select title from tickets where project_id = $1 order by number", [project?.id])).rows.map((r) => r.title);
    expect(titles).toEqual(["Pagamentos", "Cobrança mensal", "Faturas recorrentes", "Acesso", "Login"]);
  });

  it("pedido sem relação com a árvore: a procura pergunta, o respondedor pelo gabarito responde e o registro traz as perguntas (ADR 0054)", async () => {
    const ok = await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, request: "Zebras voadoras\n\nUm texto sem relação alguma com nada", omit: ["TST-6"] }), repeats: 1 });
    const record = JSON.parse(lines.find((l) => l.includes('"repeat"')) as string) as { destinationKey: string | null; finalDestinationKey: string | null; finalHit: boolean; destinationHit: boolean; hit: boolean; doubt: { questions: { kind: string; answer: string; expectedInBranch: boolean }[]; result: string; first: { group: string }; final: { group: string } } | null };
    expect(record.doubt).not.toBeNull();
    expect(record.doubt?.questions.length).toBeGreaterThan(0);
    expect(record.doubt?.questions[0]).toMatchObject({ kind: "fit", answer: "branch", expectedInBranch: true });
    expect(record.doubt?.result).toBe("right_after_question");
    expect(record.doubt?.first.group).toBeDefined();
    expect(record.doubt?.final.group).toBe("same_parent");
    // O acerto é da PRIMEIRA procura; o resultado depois das perguntas vai à parte (ADR 0054).
    expect(record.finalDestinationKey).toBe("TST-2");
    expect(record.finalHit).toBe(true);
    // O palpite da primeira procura foi a raiz (pergunta `root`): não é acerto, mesmo que a pergunta tenha levado ao lugar certo.
    expect(record.destinationKey).toBeNull();
    expect(record.destinationHit).toBe(false);
    expect(record.hit).toBe(false);
    expect(ok).toBe(false);
    const summary = JSON.parse(lines.find((l) => l.includes('"summary"')) as string) as { finalHits: number; destinationHits: number };
    expect(summary.finalHits).toBe(1);
    expect(summary.destinationHits).toBe(0);
  });

  it("destino fora do esperado e dos aceitos não é acerto; aceitar um descendente o torna", async () => {
    const miss = await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectParentKey: "TST-4" }), repeats: 1 });
    expect(miss).toBe(false);
    expect(JSON.parse(lines.find((l) => l.includes('"repeat"')) as string)).toMatchObject({ destinationKey: "TST-2", hit: false });
    lines.length = 0;
    const accepted = await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectParentKey: "TST-4", acceptKeys: ["TST-2"] }), repeats: 1 });
    expect(accepted).toBe(true);
  });

  it("imprime os relacionados e o duplicado com as chaves do projeto original", async () => {
    await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, omit: ["TST-6"] }), repeats: 1 });
    const record = JSON.parse(lines.find((l) => l.includes('"repeat"')) as string) as { related: string[]; duplicate: string | null; probabilities: { related: { key: string }[] } };
    expect(record.related).toEqual(expect.arrayContaining(["TST-1", "TST-2"]));
    expect(record.related.every((key) => key.startsWith("TST-"))).toBe(true);
    expect(record.duplicate).toBeNull();
    expect(record.probabilities.related.map((r) => r.key).sort()).toEqual([...record.related].sort());
  });

  it("expectRelatedKeys: passa se todos aparecem entre os relacionados; um que falta reprova", async () => {
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectRelatedKeys: ["TST-1", "TST-2"] }), repeats: 1 })).toBe(true);
    lines.length = 0;
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectRelatedKeys: ["TST-1", "TST-5"] }), repeats: 1 })).toBe(false);
    const record = JSON.parse(lines.find((l) => l.includes('"repeat"')) as string) as { hit: boolean; destinationHit: boolean; relatedHit: boolean };
    expect(record).toMatchObject({ destinationHit: true, relatedHit: false, hit: false });
  });

  it("imprime a elaboração com as chaves do projeto original; o destino e os ancestrais (TST-1, TST-2) não viram ligação (R6)", async () => {
    await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, omit: ["TST-6"] }), repeats: 1 });
    const record = JSON.parse(lines.find((l) => l.includes('"repeat"')) as string) as { links: unknown[]; suggested: unknown[]; elaborationUnavailable: string | null; diagnostics: { dropped: { links: { ancestor: number } } } };
    expect(record.links).toEqual([]);
    expect(record.diagnostics.dropped.links.ancestor).toBe(2);
    expect(record.suggested).toEqual([]);
    expect(record.elaborationUnavailable).toBeNull();
  });

  it("sem relacionados o ensaio sugere uma tarefa e não liga nada", async () => {
    await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, request: "Zzzz\n\nqqqq wwww", expectParentKey: "TST-1", acceptKeys: ["TST-4"] }), repeats: 1 });
    const record = JSON.parse(lines.find((l) => l.includes('"repeat"')) as string) as { links: unknown[]; suggested: { title: string; motivo: string }[] };
    expect(record.links).toEqual([]);
    expect(record.suggested).toHaveLength(1);
  });

  it("expectLinkKeys: ligação a ancestral do destino não conta (R6); sem chaves esperadas, passa", async () => {
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectLinkKeys: ["TST-1"] }), repeats: 1 })).toBe(false);
    const record = JSON.parse(lines.find((l) => l.includes('"repeat"')) as string) as { hit: boolean; destinationHit: boolean; linkHit: boolean };
    expect(record).toMatchObject({ destinationHit: true, linkHit: false, hit: false });
    lines.length = 0;
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectLinkKeys: [] }), repeats: 1 })).toBe(true);
  });

  it("expectLinkKeys com chave que o caso omite é erro claro, antes de criar projeto", async () => {
    await expect(caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectLinkKeys: ["TST-7"], omit: ["TST-6"] }), repeats: 1 })).rejects.toThrow(/TST-7/);
    expect(await measurementProjects()).toHaveLength(0);
  });

  it("expectDuplicateKey: o duplicado esperado confere com o apontado", async () => {
    const duplicateRequest = { ...base, expectParentKey: "TST-1", request: "Cobrança mensal\n\nCobrar todo mês" };
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...duplicateRequest, expectDuplicateKey: "TST-2" }), repeats: 1 })).toBe(true);
    lines.length = 0;
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...duplicateRequest, expectDuplicateKey: "TST-3" }), repeats: 1 })).toBe(false);
    lines.length = 0;
    expect(await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectDuplicateKey: "TST-2" }), repeats: 1 })).toBe(false);
  });

  it("erro no meio: o projeto de medição é arquivado mesmo assim e o erro chega a quem chamou", async () => {
    failPlacement = true;
    await expect(caseRunCommand(ctx(), { caseFile: writeCase(base), repeats: 1 })).rejects.toThrow();
    const projects = await measurementProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.archived_at).not.toBeNull();
  });

  it("chave do pai esperado que o caso omite é erro claro, antes de criar projeto", async () => {
    await expect(caseRunCommand(ctx(), { caseFile: writeCase({ ...base, expectParentKey: "TST-7", omit: ["TST-6"] }), repeats: 1 })).rejects.toThrow(/TST-7/);
    expect(await measurementProjects()).toHaveLength(0);
  });
});

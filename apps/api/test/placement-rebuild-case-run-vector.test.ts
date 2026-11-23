import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { caseRunCommand, CaseError, parseCase } from "../scripts/placement-rebuild/case-run.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import type { Context } from "../scripts/placement-rebuild/commands.js";
import type { Gabarito, GabaritoTicket } from "../scripts/placement-rebuild/core.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];
delete process.env["VOYAGE_API_KEY"];

// ADR 0053, fatia 2: o ticket certo ("Identidade federada") NÃO tem palavra em comum com o pedido; só os "conceitos" do falso o aproximam.
const node = (number: number, title: string, parent: number | null, depth: number): GabaritoTicket => ({
  id: `old-${number}`, number, kind: "ticket", key: `TST-${number}`, title, description: "", status: "todo", parentId: parent === null ? null : `old-${parent}`, assigneeIds: [], depth,
});
const tickets = [node(1, "Acesso", null, 0), node(2, "Login", 1, 1), node(3, "Identidade federada", 1, 1), node(4, "Cobrança", null, 0)];
const REQUEST = "Entrar pela conta da empresa, sem criar outra senha.";
const CONCEPTS = { entrar: "acesso-federado", empresa: "acesso-federado", senha: "acesso-federado", identidade: "acesso-federado", federada: "acesso-federado" };

let booted: Booted;
let dir: string;
let lines: string[];
let client: ApiClient;
const owner = ownerPoolWithCleanup();
const ctx = (): Context => ({ client, recorder: booted.recorder, dir, project: "", log: (line) => lines.push(line), sleep: () => Promise.resolve(), ...(booted.setConcepts ? { setConcepts: booted.setConcepts } : {}) });
const writeCase = (value: unknown): string => {
  const path = join(dir, `caso-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
const base = { name: "vetor", request: REQUEST, expectParentKey: "TST-1", expectRelatedKeys: ["TST-3"] };
const repeatsOf = () => lines.filter((l) => l.startsWith("{") && !l.includes('"summary"')).map((l) => JSON.parse(l));

beforeAll(async () => {
  await owner.query("insert into organizations (org_id, name, slug) values ('org_vec', 'Vec', 'org_vec') on conflict do nothing");
  await owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_vec', 'user_vec', 'Admin', 'a@vec.test', 'admin') on conflict do nothing");
  const person = (await owner.query<{ id: string }>("select id from people where org_id = 'org_vec' and clerk_user_id = 'user_vec'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_vec', 'assistant', 'rascunho-2', $1)", [person]);
  booted = await bootApp({ org: "org_vec", user: "user_vec", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true });
  client = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "case-run-vec-"));
  const gabarito: Gabarito = { exportedAt: "2026-11-23T00:00:00Z", project: { id: "p", key: "TST", name: "Inventado" }, tickets };
  writeFileSync(join(dir, "gabarito.json"), JSON.stringify(gabarito));
});
afterAll(async () => {
  await booted.close();
  await owner.end();
});

describe("caso de medição com vetores (provedores falsos)", () => {
  it("com os conceitos, o ticket sem palavra em comum entra só pelos vizinhos por vetor e vira relacionado; a saída traz os números de triagem", async () => {
    lines = [];
    await caseRunCommand(ctx(), { caseFile: writeCase({ ...base, concepts: CONCEPTS }), repeats: 1 });
    const [repeat] = repeatsOf();
    expect(repeat.relatedHit).toBe(true);
    expect(repeat.related).toContain("TST-3");
    expect(repeat.triage).toMatchObject({ words: 0, onlyVector: expect.any(Number), semantic: { embedded: 4 } });
    expect(repeat.triage.onlyVector).toBeGreaterThan(0);
    expect(repeat.triage.semantic.failure).toBeUndefined();
    const summary = JSON.parse(lines.find((l) => l.includes('"summary"')) as string);
    expect(summary.diagnostics.repeatsWithVectorOnlyCandidate).toBe(1);
    // Só números e códigos: nada do pedido nem de títulos na triagem impressa.
    expect(JSON.stringify(repeat.triage)).not.toMatch(/Identidade|federada|empresa/);
  });

  it("controle: sem os conceitos o mesmo caso NÃO acha o ticket (o falso só aproxima o que o caso declara)", async () => {
    lines = [];
    await caseRunCommand(ctx(), { caseFile: writeCase(base), repeats: 1 });
    const [repeat] = repeatsOf();
    expect(repeat.relatedHit).toBe(false);
  });

  it("`concepts` é validado", () => {
    expect(parseCase(JSON.stringify({ ...base, concepts: { Entrar: "x" } })).concepts).toEqual({ entrar: "x" });
    expect(() => parseCase(JSON.stringify({ ...base, concepts: { a: 1 } }))).toThrow(CaseError);
    expect(parseCase(JSON.stringify(base)).concepts).toEqual({});
  });
});

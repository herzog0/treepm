import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { caseRunCommand, translateLinks } from "../scripts/placement-rebuild/case-run.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import type { Context } from "../scripts/placement-rebuild/commands.js";
import type { Gabarito, GabaritoTicket } from "../scripts/placement-rebuild/core.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

// TREEPM-329: a ligação convertida de uma sugerida aponta para um ticket que NÃO está entre os relacionados; a ferramenta tem de traduzir a chave dele.
const node = (number: number, title: string, parent: number | null, depth: number): GabaritoTicket => ({
  id: `old-${number}`, number, kind: "ticket", key: `TST-${number}`, title, description: "", status: "todo", parentId: parent === null ? null : `old-${parent}`, assigneeIds: [], depth,
});
const tickets = [node(1, "Pagamentos", null, 0), node(2, "Tarefa implicada (ensaio)", 1, 1)];
const request = "Zzzz\n\nqqqq wwww";

let booted: Booted;
let dir: string;
let lines: string[];
let client: ApiClient;
const owner = ownerPoolWithCleanup();
const ctx = (): Context => ({ client, recorder: booted.recorder, dir, project: "", log: (line) => lines.push(line), sleep: () => Promise.resolve() });
const writeCase = (value: unknown): string => {
  const path = join(dir, `caso-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
type Line = { related: unknown[]; links: { de: string; dependeDe: string; translated: boolean }[]; linkHit: boolean; diagnostics: Record<string, unknown> };
const json = () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Line);

beforeAll(async () => {
  await owner.query("insert into organizations (org_id, name, slug) values ('org_case2', 'Case2', 'org_case2') on conflict do nothing");
  await owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_case2', 'user_case2', 'Admin', 'a@case2.test', 'admin') on conflict do nothing");
  const person = (await owner.query<{ id: string }>("select id from people where org_id = 'org_case2' and clerk_user_id = 'user_case2'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_case2', 'assistant', 'rascunho-2', $1)", [person]);
  booted = await bootApp({ org: "org_case2", user: "user_case2", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true });
  client = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "case-run-diag-"));
  const gabarito: Gabarito = { exportedAt: "2026-11-23T00:00:00Z", project: { id: "p", key: "TST", name: "Inventado" }, tickets };
  writeFileSync(join(dir, "gabarito.json"), JSON.stringify(gabarito));
});
afterAll(async () => {
  await owner.query("delete from projects where name like 'Caso conv%'");
  await booted.close();
  await owner.end();
});
beforeEach(async () => {
  lines = [];
  await owner.query("delete from projects where name like 'Caso conv%'");
});
const spec = { name: "conv", request, expectParentKey: "TST-1", acceptKeys: ["TST-2"] };

describe("case-run: chave da ligação convertida", () => {
  it("traduz a chave de um ticket que não estava entre os relacionados (antes imprimia null)", async () => {
    await caseRunCommand(ctx(), { caseFile: writeCase({ ...spec, expectLinkKeys: ["TST-2"] }), repeats: 1 });
    const record = json()[0]!;
    expect(record.related).toEqual([]);
    expect(record.links).toHaveLength(1);
    expect(record.links[0]).toMatchObject({ de: "pai", dependeDe: "TST-2", translated: true });
    expect(record.linkHit).toBe(true);
  });

  it("imprime diagnostics em cada repetição e soma os desfechos no resumo", async () => {
    await caseRunCommand(ctx(), { caseFile: writeCase({ ...spec, expectLinkKeys: ["TST-2"] }), repeats: 2 });
    const [first, , summary] = json();
    expect(first!.diagnostics).toMatchObject({ model: { links: 0, suggested: 1 }, lookups: [{ outcome: "converted" }] });
    expect(summary!.diagnostics).toMatchObject({
      repeatsWithExpectedLink: 2,
      repeatsWithSuggestedKept: 0,
      repeatsModelProposedNothing: 0,
      lookupOutcomes: { converted: 2 },
    });
  });

  it("chave sem correspondência: fica a chave do projeto de medição e translated:false, nunca null", () => {
    const out = translateLinks([{ dependeDe: "CSABCD-1" }, { dependeDe: "CSABCD-9" }], new Map([["CSABCD-1", "TST-1"]]));
    expect(out).toEqual([{ dependeDe: "TST-1", translated: true }, { dependeDe: "CSABCD-9", translated: false }]);
  });
});

import { AI_CONSENT_VERSION } from "@treepm/domain";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { leaveOneOutCommand, looPath } from "../scripts/placement-rebuild/commands.js";
import type { Context } from "../scripts/placement-rebuild/commands.js";
import type { Gabarito, GabaritoTicket, RunRecord } from "../scripts/placement-rebuild/core.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

// Pagamentos (1) › Cobrança mensal (2) › Zebra voadora (3, sem relação com nada: o juiz falso duvida) e Imposto anual (6); Acesso (4) › Login (5).
// Cobrança mensal precisa de um filho que fica (o outro é o medido): só agrupador com filhos é candidato (ADR 0034).
const node = (number: number, title: string, parent: number | null, depth: number, description = ""): GabaritoTicket => ({
  id: `old-${number}`, number, kind: "ticket", key: `LOO-${number}`, title, description, status: "todo", parentId: parent === null ? null : `old-${parent}`, assigneeIds: [], depth,
});
const tickets = [node(1, "Pagamentos", null, 0), node(2, "Cobrança mensal", 1, 1), node(3, "Zebra voadora", 2, 2, "Um texto sem relação alguma com nada"), node(4, "Acesso", null, 0), node(5, "Login", 4, 1), node(6, "Imposto anual", 2, 2, "Outro texto sem relação alguma")];

let booted: Booted;
let dir: string;
let lines: string[];
const owner = ownerPoolWithCleanup();

beforeAll(async () => {
  await owner.query("insert into organizations (org_id, name, slug) values ('org_loo', 'Loo', 'org_loo') on conflict do nothing");
  await owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_loo', 'user_loo', 'Admin', 'a@loo.test', 'admin') on conflict do nothing");
  const person = (await owner.query<{ id: string }>("select id from people where org_id = 'org_loo' and clerk_user_id = 'user_loo'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_loo', 'assistant', $2, $1)", [person, AI_CONSENT_VERSION]);
  booted = await bootApp({ org: "org_loo", user: "user_loo", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true });
  dir = mkdtempSync(join(tmpdir(), "loo-question-"));
  const gabarito: Gabarito = { exportedAt: "2026-11-23T00:00:00Z", project: { id: "p", key: "LOO", name: "Inventado" }, tickets };
  writeFileSync(join(dir, "gabarito.json"), JSON.stringify(gabarito));
  lines = [];
});
afterAll(async () => {
  await owner.query("delete from projects where name = 'Loo pergunta'");
  await booted.close();
  await owner.end();
});

describe("leave-one-out de ponta a ponta com --fake-providers, passando por uma pergunta (ADR 0054, item 9)", () => {
  it("o respondedor pelo gabarito responde; o registro guarda a primeira procura à parte do resultado final; a curva sai ao fim e a árvore volta inteira", async () => {
    const client = new ApiClient(booted.baseUrl, booted.token);
    const project = (await client.request("POST", "/projects", { key: "LOOQ", name: "Loo pergunta" })).body as { id: string };
    const ctx: Context = { client, recorder: booted.recorder, dir, project: project.id, log: (line) => lines.push(line), sleep: () => Promise.resolve() };
    expect(await leaveOneOutCommand(ctx, undefined)).toBe(true);

    const records = readFileSync(looPath(dir, project.id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
    const zebra = records.find((r) => r.title === "Zebra voadora") as RunRecord;
    expect(zebra.doubt?.questions.length).toBeGreaterThan(0);
    expect(zebra.doubt?.questions[0]).toMatchObject({ kind: "fit", answer: "branch", expectedInBranch: true });
    // O grupo do registro é o do palpite sem ajuda (a primeira procura); o resultado final fica em `doubt.final`.
    expect(zebra.group).toBe(zebra.doubt?.first.group);
    expect(zebra.doubt?.final.group).toBe("same_parent");
    expect(zebra.doubt?.result).toBe("right_after_question");
    // Nenhuma procura recusada (um 400 faria o comando falhar) e os rótulos somam o total.
    expect(records.every((r) => r.doubt !== undefined)).toBe(true);
    expect(records.map((r) => r.doubt?.result).filter(Boolean)).toHaveLength(records.length);
    const text = lines.join("\n");
    expect(text).toContain("Resultado da rodada com o respondedor pelo gabarito");
    expect(text).toContain("3 colocações");
    expect(text).toContain("Curva da dúvida");
    expect(text).toContain("Leave-one-out: o projeto tem os mesmos tickets");
  });
});

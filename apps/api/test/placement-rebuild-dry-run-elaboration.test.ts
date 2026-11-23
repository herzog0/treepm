import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { conversationDryRunCommand } from "../scripts/placement-rebuild/conversation-dry-run.js";
import type { TicketContext } from "../scripts/placement-rebuild/ticket-commands.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

// ADR 0052, fatia 3: `conversation-dry-run` também chama a elaboração e imprime `links` e `suggested`.
let booted: Booted;
let client: ApiClient;
let dir: string;
const owner = ownerPoolWithCleanup();

beforeAll(async () => {
  await owner.query("insert into organizations (org_id, name, slug) values ('org_dr', 'Dry', 'org_dr') on conflict do nothing");
  await owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_dr', 'user_dr', 'Admin', 'a@dr.test', 'admin') on conflict do nothing");
  const person = (await owner.query<{ id: string }>("select id from people where org_id = 'org_dr' and clerk_user_id = 'user_dr'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_dr', 'assistant', 'rascunho-2', $1)", [person]);
  booted = await bootApp({ org: "org_dr", user: "user_dr", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true });
  client = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "dry-run-"));
});
afterAll(async () => {
  await booted.close();
  await owner.end();
});

describe("conversation-dry-run: a elaboração", () => {
  it("imprime links e suggested; o ensaio liga o pedido ao relacionado e a conversa é descartada", async () => {
    const project = (await client.request("POST", "/projects", { key: "DRY", name: "Dry" })).body as { id: string };
    await client.request("POST", `/projects/${project.id}/tickets`, { title: "Cobrança mensal", status: "todo" });
    const textFile = join(dir, "pedido.txt");
    writeFileSync(textFile, "Cobrar mensalmente\n\nCobrança mensal de todos os clientes");
    const lines: string[] = [];
    const ctx: TicketContext = { client, project: project.id, log: (line) => lines.push(line) };
    await conversationDryRunCommand(ctx, { textFile });
    const out = JSON.parse(lines[0] as string) as { links: { de: string; dependeDe: string; dependeDeTitle: string; motivo: string }[]; suggested: unknown[]; elaborationUnavailable: string | null; conversationDiscarded: boolean };
    expect(out.links).toEqual([{ de: "pai", dependeDe: "DRY-1", dependeDeTitle: "Cobrança mensal", motivo: expect.any(String) }]);
    expect(out.suggested).toEqual([]);
    expect(out.elaborationUnavailable).toBeNull();
    expect((JSON.parse(lines[0] as string) as { diagnostics: { model: { links: number } } }).diagnostics.model.links).toBeGreaterThan(0);
    expect(out.conversationDiscarded).toBe(true);
  });
});

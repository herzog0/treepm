import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { importGabarito } from "../scripts/placement-rebuild/commands.js";
import type { Context } from "../scripts/placement-rebuild/commands.js";
import type { Gabarito, GabaritoTicket } from "../scripts/placement-rebuild/core.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

// Um gabarito grande: 600+ tickets com descrição de 2.000 caracteres (mais de 1 MB de corpo; a API recusa corpo acima de 100 KB)
// e uma cadeia funda de 25 níveis (a rota aceita 20).
let n = 0;
const make = (parent: GabaritoTicket | null, title: string): GabaritoTicket => {
  n += 1;
  return { id: `old-${n}`, number: n, kind: "ticket", key: `BIG-${n}`, title, description: "x".repeat(2000), status: "todo", parentId: parent?.id ?? null, assigneeIds: [], depth: parent ? parent.depth + 1 : 0 };
};
const tickets: GabaritoTicket[] = [];
for (let r = 0; r < 5; r++) {
  const root = make(null, `Raiz ${r}`);
  tickets.push(root);
  for (let k = 0; k < 120; k++) tickets.push(make(root, `Filho ${r}.${k}`));
}
let chain = tickets[0] as GabaritoTicket;
for (let d = 0; d < 25; d++) {
  chain = make(chain, `Cadeia ${d}`);
  tickets.push(chain);
}

let booted: Booted;
const owner = ownerPoolWithCleanup();
beforeAll(async () => {
  await owner.query("insert into organizations (org_id, name, slug) values ('org_imp', 'Imp', 'org_imp') on conflict do nothing");
  await owner.query("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_imp', 'user_imp', 'Admin', 'a@imp.test', 'admin') on conflict do nothing");
  booted = await bootApp({ org: "org_imp", user: "user_imp", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: false });
});
afterAll(async () => {
  await booted.close();
  await owner.end();
});

describe("importGabarito com um gabarito maior que o corpo da API", () => {
  it("importa em partes (pais antes de filhos, por bytes) e devolve na ordem do gabarito", async () => {
    const client = new ApiClient(booted.baseUrl, booted.token);
    const project = ((await client.request("POST", "/projects", { key: "BIGX", name: "Grande" })).body as { id: string }).id;
    const ctx: Context = { client, recorder: booted.recorder, dir: mkdtempSync(join(tmpdir(), "import-")), project, log: () => undefined, sleep: () => Promise.resolve() };
    const gabarito: Gabarito = { exportedAt: "2026-11-23T00:00:00Z", project: { id: "p", key: "BIG", name: "Grande" }, tickets };
    expect(tickets.length).toBeGreaterThanOrEqual(600);

    const { created, order } = await importGabarito(ctx, gabarito);
    expect(created).toHaveLength(tickets.length);
    expect(order).toHaveLength(tickets.length);
    const byOld = new Map(tickets.map((t) => [t.id, t]));
    const idOf = new Map(order.map((oldId, i) => [oldId, (created[i] as { id: string }).id]));
    const all = (await client.request("GET", `/projects/${project}/tickets`)).body as { id: string; title: string; parentId: string | null }[];
    expect(all).toHaveLength(tickets.length);
    const byNew = new Map(all.map((t) => [t.id, t]));
    for (const [oldId, newId] of idOf) {
      const old = byOld.get(oldId) as GabaritoTicket;
      const now = byNew.get(newId);
      expect(now?.title, oldId).toBe(old.title);
      expect(now?.parentId ?? null, oldId).toBe(old.parentId === null ? null : idOf.get(old.parentId));
    }
  }, 120_000);
});

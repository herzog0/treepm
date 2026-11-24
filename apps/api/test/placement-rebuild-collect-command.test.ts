import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted, CollectKit } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { collectCommand, collectPath, collectMapPath } from "../scripts/placement-rebuild/collect.js";
import type { CollectRecord } from "../scripts/placement-rebuild/collect-core.js";
import type { Context } from "../scripts/placement-rebuild/commands.js";
import type { Gabarito, GabaritoTicket } from "../scripts/placement-rebuild/core.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

const node = (id: string, number: number, parentId: string | null, kind: "ticket" | "group", description: string): GabaritoTicket => ({
  id,
  number,
  kind,
  key: `CMD-${number}`,
  title: `Título ${id}`,
  description,
  status: kind === "group" ? null : "todo",
  parentId,
  assigneeIds: [],
  depth: parentId === null ? 0 : 1,
});
const tickets = [
  node("ga", 1, null, "group", "Cobrança e pagamentos"),
  node("gb", 2, null, "group", "Acesso e login"),
  node("t1", 3, "ga", "ticket", "Cobrar no cartão de pagamentos"),
  node("t2", 4, "ga", "ticket", "Estornar pagamentos cobrados"),
  node("t3", 5, "gb", "ticket", "Entrar com senha de acesso"),
  node("t4", 6, "gb", "ticket", "Recuperar acesso esquecido"),
];

let booted: Booted;
let projectId: string;
let dir: string;
let claudeMessages: string[];
let judgeDrafts: { title: string; description: string }[];
let claudeOverride: ((message: string) => unknown) | null;

beforeAll(async () => {
  // A ferramenta só roda numa organização que já aceitou o assistente (ADR 0039): semente com o papel dono.
  const owner = ownerPoolWithCleanup();
  await owner.query("insert into organizations (org_id, name, slug) values ('org_cmd', 'Cmd', 'org_cmd') on conflict do nothing");
  const person = await owner.query<{ id: string }>(
    "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_cmd', 'user_cmd', 'Admin', 'a@x.test', 'admin') on conflict do nothing returning id",
  );
  const personId = person.rows[0]?.id ?? (await owner.query<{ id: string }>("select id from people where org_id = 'org_cmd' and clerk_user_id = 'user_cmd'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_cmd', 'assistant', 'rascunho-3', $1)", [personId]);
  await owner.end();
  booted = await bootApp({ org: "org_cmd", user: "user_cmd", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true, collect: true });
  const client = new ApiClient(booted.baseUrl, booted.token);
  const created = await client.request("POST", "/projects", { key: "CMD", name: "Comando" });
  projectId = (created.body as { id: string }).id;
  dir = mkdtempSync(join(tmpdir(), "collect-cmd-"));
  const gabarito: Gabarito = { exportedAt: "2026-11-21T00:00:00Z", project: { id: projectId, key: "CMD", name: "Comando" }, tickets };
  writeFileSync(join(dir, "gabarito.json"), JSON.stringify(gabarito));
});
afterAll(async () => {
  await booted.close();
});

function kitWithSpies(): CollectKit {
  const real = booted.collectKit as CollectKit;
  claudeMessages = [];
  judgeDrafts = [];
  return {
    ...real,
    judge: {
      judge: (input, options) => {
        judgeDrafts.push({ ...input.draft });
        return real.judge.judge(input, options);
      },
    },
    claude: (params, options) => {
      const content = (params.messages[0] as { content: string }).content;
      claudeMessages.push(content);
      if (claudeOverride) {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if ("group" in parsed) return Promise.resolve({ stop_reason: "end_turn", parsed_output: claudeOverride(content), model: "fake" });
      }
      return real.claude(params, options);
    },
  };
}

const context = (extra: Partial<Context> = {}): Context => ({
  client: new ApiClient(booted.baseUrl, booted.token),
  recorder: booted.recorder,
  dir,
  project: projectId,
  log: () => undefined,
  sleep: () => Promise.resolve(),
  retryDelaysMs: [0],
  collectKit: kitWithSpies(),
  repeats: 1,
  ...extra,
});

const records = (variant: string): CollectRecord[] =>
  readFileSync(collectPath(dir, projectId, variant), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CollectRecord);

describe("collect — D só por opção e variantes", () => {
  it("sem --claude-outline: nenhuma chamada do Claude, e o registro não traz os campos de D", async () => {
    claudeOverride = null;
    expect(await collectCommand(context(), undefined)).toBe(true);
    expect(claudeMessages).toHaveLength(0);
    const recs = records("base");
    expect(recs).toHaveLength(4);
    for (const r of recs) {
      expect("d" in r).toBe(false);
      expect("dNeg" in r).toBe(false);
    }
    expect(recs[0]?.groupText).toBe("summary");
    expect(recs[0]?.draftDescription).toBe("Cobrar no cartão de pagamentos");
    expect(Object.keys(recs[0]?.texts ?? {})).toEqual(["ga", "gb"]);
    expect(Object.keys(recs[0]?.textsNeg ?? {})).toEqual(["gb"]);
  });

  it("os arquivos levam a variante no nome e o mapa do projeto é um só", () => {
    expect(collectPath(dir, projectId, "base")).toMatch(/collect-.*-base\.jsonl$/);
    expect(existsSync(collectPath(dir, projectId, "base"))).toBe(true);
    expect(existsSync(collectMapPath(dir, projectId))).toBe(true);
  });

  it("com --claude-outline o registro traz D positivo e negativo", async () => {
    claudeOverride = null;
    expect(await collectCommand(context({ variant: "outline", claudeOutline: true }), 1)).toBe(true);
    const [rec] = records("outline");
    expect(rec?.d?.ranking).not.toBeNull();
    expect(rec?.dNeg).not.toBeUndefined();
    expect(claudeMessages).toHaveLength(2);
  });
});

describe("collect — --ticket-descriptions", () => {
  it("o rascunho usa a descrição nova e o ticket volta com a original", async () => {
    claudeOverride = null;
    writeFileSync(join(dir, "desc.json"), JSON.stringify({ "3": "Descrição nova do primeiro ticket" }));
    expect(await collectCommand(context({ variant: "desc", ticketDescriptionsPath: join(dir, "desc.json") }), 2)).toBe(true);
    const recs = records("desc");
    expect(recs[0]?.draftDescription).toBe("Descrição nova do primeiro ticket");
    expect(recs[1]?.draftDescription).toBe("Estornar pagamentos cobrados");
    expect(judgeDrafts.some((d) => d.description === "Descrição nova do primeiro ticket")).toBe(true);
    const client = new ApiClient(booted.baseUrl, booted.token);
    const list = (await client.request("GET", `/projects/${projectId}/tickets`)).body as { id: string; title: string }[];
    const first = list.find((t) => t.title === "Título t1") as { id: string };
    const detail = (await client.request("GET", `/tickets/${first.id}`)).body as { description: string };
    expect(detail.description).toBe("Cobrar no cartão de pagamentos");
  });

  it("número inexistente ou de agrupador é erro antes de começar, sem mexer no projeto", async () => {
    const client = new ApiClient(booted.baseUrl, booted.token);
    const before = JSON.stringify((await client.request("GET", `/projects/${projectId}/tickets`)).body);
    for (const bad of [{ "999": "x" }, { "1": "x" }]) {
      writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
      await expect(collectCommand(context({ variant: "bad", ticketDescriptionsPath: join(dir, "bad.json") }), undefined)).rejects.toThrow(/número/);
    }
    expect(existsSync(collectPath(dir, projectId, "bad"))).toBe(false);
    expect(JSON.stringify((await client.request("GET", `/projects/${projectId}/tickets`)).body)).toBe(before);
  });
});

describe("collect — --group-text definition", () => {
  it("escreve as definições sem vazamento e usa B com os textos do negativo", async () => {
    claudeOverride = null;
    expect(await collectCommand(context({ variant: "def", groupText: "definition" }), 1)).toBe(true);
    const [rec] = records("def") as [CollectRecord];
    expect(rec.groupText).toBe("definition");
    // Ticket 3 (t1) está em ga: a definição de ga foi escrita sem ele, e a do negativo sem ga nos irmãos.
    const inputs = claudeMessages.map((m) => JSON.parse(m) as { group: { title: string; items: string[] }; siblings: string[] });
    const own = inputs.find((i) => i.group.title === "Título ga") as (typeof inputs)[number];
    expect(own.group.items).toEqual(["Título t2"]);
    expect(JSON.stringify(own)).not.toContain("Título t1");
    const negativeGb = inputs.filter((i) => i.group.title === "Título gb" && i.siblings.length === 0);
    expect(negativeGb).toHaveLength(1);
    expect(rec.textsNeg?.["gb"]).toContain("0 irmão");
    expect(rec.texts?.["gb"]).toContain("1 irmão");
    expect(rec.texts?.["ga"]).not.toBe(rec.textsNeg?.["gb"]);
    expect(rec.bNeg).toHaveLength(1);
    expect(rec.definitionCalls).toBe(3);
    expect(rec.definitionCached).toBe(0);
  });

  it("repetir a rodada não chama o Claude de novo (cache em disco, valendo entre variantes)", async () => {
    expect(existsSync(join(dir, `definitions-${projectId}.json`))).toBe(true);
    expect(await collectCommand(context({ variant: "def-b", groupText: "definition" }), 1)).toBe(true);
    expect(claudeMessages).toHaveLength(0);
    const [rec] = records("def-b") as [CollectRecord];
    expect(rec.definitionCalls).toBe(0);
    expect(rec.definitionCached).toBe(3);
  });

  it("definição inválida usa o resumo do produto e fica marcada", async () => {
    claudeOverride = () => ({ definition: "curta demais" });
    // Entradas novas (ticket 4 muda os itens de ga), então não vêm do cache.
    expect(await collectCommand(context({ variant: "def-bad", groupText: "definition" }), 2)).toBe(true);
    const recs = records("def-bad");
    const second = recs[1] as CollectRecord;
    expect(second.definitionFallbacks?.length).toBeGreaterThan(0);
    for (const id of second.definitionFallbacks ?? []) expect(second.texts?.[id]).not.toContain("Entra aqui:");
    claudeOverride = null;
  });
});

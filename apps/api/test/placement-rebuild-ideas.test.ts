import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import { ticketCreateCommand, ticketListCommand, ticketUpdateCommand } from "../scripts/placement-rebuild/ticket-commands.js";
import type { TicketContext } from "../scripts/placement-rebuild/ticket-commands.js";

// ADR 0042, fatia 1: a linha de comando sabe criar ideia, mudar o estágio e mostrar ideias. Aceitar e descartar não entram.
process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

type Row = { id: string; number: number; key: string; parentId: string | null; title: string; status: string; idea: unknown };

let booted: Booted;
let client: ApiClient;
let keyCounter = 0;
let lines: string[];
let ctx: TicketContext;
let project: string;
let dir: string;

async function newProject(): Promise<string> {
  const key = `ID${String.fromCharCode(65 + Math.floor(keyCounter / 26))}${String.fromCharCode(65 + (keyCounter++ % 26))}`;
  const created = await client.request("POST", "/projects", { key, name: `Projeto ${key}` });
  return (created.body as { id: string }).id;
}
async function rows(): Promise<Row[]> {
  return (await client.request("GET", `/projects/${project}/tickets`)).body as Row[];
}
const byNumber = async (number: number): Promise<Row> => (await rows()).find((r) => r.number === number) as Row;

beforeAll(async () => {
  booted = await bootApp({ org: "org_id", user: "user_id", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: false });
  client = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "idea-cmd-"));
  writeFileSync(join(dir, "d.md"), "texto");
});
afterAll(async () => {
  await booted.close();
});
beforeEach(async () => {
  project = await newProject();
  lines = [];
  ctx = { client, project, log: (line) => lines.push(line) };
});

describe("argumentos", () => {
  const base = ["--org", "o", "--user", "u", "--project", "p"];
  it("ticket-create aceita --idea; ticket-update aceita --idea-stage com os três estágios", () => {
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--idea"])).toMatchObject({ ok: true, options: { title: "T", idea: true } });
    for (const stage of ["new", "refining", "ready"]) {
      expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--idea-stage", stage])).toMatchObject({ ok: true, options: { number: 1, ideaStage: stage } });
    }
  });
  it("estágio inválido (inclusive discarded), --idea fora do ticket-create e --idea com --status são recusados", () => {
    for (const stage of ["discarded", "accepted", "x"]) expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--idea-stage", stage]).ok).toBe(false);
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--idea"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-list", ...base, "--idea"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--idea-stage", "new"]).ok).toBe(false);
    const both = parseCliArgs(["ticket-create", ...base, "--title", "T", "--idea", "--status", "done"]);
    expect(both.ok).toBe(false);
  });
  it("não há comando nem opção de aceitar ou descartar", () => {
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--accept"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--discard"]).ok).toBe(false);
    expect(parseCliArgs(["idea-accept", ...base]).ok).toBe(false);
  });
  it("--idea-stage conta como mudança do ticket-update", () => {
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--idea-stage", "ready"]).ok).toBe(true);
  });
});

describe("ticket-create --idea", () => {
  it("cria a ideia no estágio new, dentro do pai indicado, e diz isso", async () => {
    await ticketCreateCommand(ctx, { title: "Pai" });
    await ticketCreateCommand(ctx, { title: "Ideia", parent: 1, idea: true });
    const row = await byNumber(2);
    expect(row).toMatchObject({ parentId: (await byNumber(1)).id, status: "todo", idea: { root: true, stage: "new" } });
    expect(lines.at(-1)).toBe(`${row.key}: ideia (estágio new)`);
    expect(lines.at(-2)).toBe(`Criado: ${row.key}  ${row.id}`);
  });

  it("--idea junto com --status é erro e nada é criado", async () => {
    await expect(ticketCreateCommand(ctx, { title: "X", idea: true, status: "done" })).rejects.toThrow(/--idea/);
    expect(await rows()).toEqual([]);
  });

  it("criar uma ideia dentro de um ticket concluído não o reabre e não imprime reabertura", async () => {
    await ticketCreateCommand(ctx, { title: "Pai" });
    await ticketUpdateCommand(ctx, { number: 1, status: "done" });
    lines.length = 0;
    await ticketCreateCommand(ctx, { title: "Ideia", parent: 1, idea: true });
    expect((await byNumber(1)).status).toBe("done");
    expect(lines.join("\n")).not.toContain("Reabertos");
  });
});

describe("ticket-update --idea-stage", () => {
  it("muda o estágio e imprime antes → depois", async () => {
    await ticketCreateCommand(ctx, { title: "I", idea: true });
    lines.length = 0;
    await ticketUpdateCommand(ctx, { number: 1, ideaStage: "refining" });
    expect((await byNumber(1)).idea).toEqual({ root: true, stage: "refining" });
    expect(lines).toEqual([`${(await byNumber(1)).key}: estágio da ideia new → refining`]);
  });

  it("combina com outras mudanças, que valem como sempre", async () => {
    await ticketCreateCommand(ctx, { title: "I", idea: true });
    await ticketUpdateCommand(ctx, { number: 1, ideaStage: "ready", title: "Novo título" });
    expect(await byNumber(1)).toMatchObject({ title: "Novo título", idea: { root: true, stage: "ready" } });
  });

  it("em ticket comum é erro claro com o código da API", async () => {
    await ticketCreateCommand(ctx, { title: "Comum" });
    await expect(ticketUpdateCommand(ctx, { number: 1, ideaStage: "ready" })).rejects.toThrow(/ticket_not_idea_root/);
  });

  it("mudar a situação de um ticket dentro de uma ideia mostra o ticket_in_idea da API", async () => {
    await ticketCreateCommand(ctx, { title: "I", idea: true });
    await ticketCreateCommand(ctx, { title: "Filho", parent: 1 });
    await expect(ticketUpdateCommand(ctx, { number: 2, status: "done" })).rejects.toThrow(/ticket_in_idea/);
  });
});

describe("ticket-list com ideias", () => {
  it("a raiz mostra [ideia: estágio] no lugar da situação; o que está dentro leva (ideia); o pai conta as ideias à parte", async () => {
    await ticketCreateCommand(ctx, { title: "Pai" });
    await ticketCreateCommand(ctx, { title: "Comum", parent: 1 });
    await ticketCreateCommand(ctx, { title: "Ideia", parent: 1, idea: true });
    await ticketCreateCommand(ctx, { title: "Dentro", parent: 3 });
    await ticketUpdateCommand(ctx, { number: 3, ideaStage: "refining" });
    lines.length = 0;
    await ticketListCommand(ctx, false);
    const key = (await byNumber(1)).key.split("-")[0] as string;
    expect(lines).toEqual([
      `${key}-1  [todo]  Pai  (0 de 1; 1 ideia)`,
      `  ${key}-2  [todo]  Comum`,
      `  ${key}-3  [ideia: refining]  Ideia`,
      `    ${key}-4  [todo]  Dentro  (ideia)`,
    ]);
  });

  it("sem ideia nenhuma a saída é a de sempre", async () => {
    await ticketCreateCommand(ctx, { title: "Pai" });
    await ticketCreateCommand(ctx, { title: "Filho", parent: 1 });
    lines.length = 0;
    await ticketListCommand(ctx, false);
    const key = (await byNumber(1)).key.split("-")[0] as string;
    expect(lines).toEqual([`${key}-1  [todo]  Pai  (0 de 1)`, `  ${key}-2  [todo]  Filho`]);
  });

  it("--json traz idea (a forma da API) em cada ticket", async () => {
    await ticketCreateCommand(ctx, { title: "I", idea: true });
    await ticketCreateCommand(ctx, { title: "F", parent: 1 });
    await ticketCreateCommand(ctx, { title: "C" });
    lines.length = 0;
    await ticketListCommand(ctx, true);
    const parsed = JSON.parse(lines[0] as string) as { number: number; idea: unknown }[];
    const idea = (n: number) => parsed.find((r) => r.number === n)?.idea;
    expect(idea(1)).toEqual({ root: true, stage: "new" });
    expect(idea(2)).toMatchObject({ root: false });
    expect(idea(3)).toBeNull();
  });
});

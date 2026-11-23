import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { ownerPoolWithCleanup } from "./helpers.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { relationsRebuildCommand, ticketCreateCommand, ticketListCommand, ticketUpdateCommand } from "../scripts/placement-rebuild/ticket-commands.js";
import type { TicketContext } from "../scripts/placement-rebuild/ticket-commands.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

type Row = { id: string; number: number; key: string; parentId: string | null; title: string; status: string; descriptionExcerpt: string };

let booted: Booted;
let client: ApiClient;
let keyCounter = 0;
let lines: string[];
let ctx: TicketContext;
let dir: string;

async function newProject(): Promise<string> {
  const key = `TK${String.fromCharCode(65 + Math.floor(keyCounter / 26))}${String.fromCharCode(65 + (keyCounter++ % 26))}`;
  const created = await client.request("POST", "/projects", { key, name: `Projeto ${key}` });
  return (created.body as { id: string }).id;
}
async function add(projectId: string, title: string, parentId: string | null = null, status = "todo"): Promise<string> {
  const response = await client.request("POST", `/projects/${projectId}/tickets`, { title, parentId, status });
  expect(response.status).toBe(201);
  return (response.body as { id: string }).id;
}
async function rows(projectId: string): Promise<Row[]> {
  return (await client.request("GET", `/projects/${projectId}/tickets`)).body as Row[];
}
async function detail(id: string): Promise<Row & { description: string }> {
  return (await client.request("GET", `/tickets/${id}`)).body as Row & { description: string };
}
const file = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

beforeAll(async () => {
  booted = await bootApp({ org: "org_tk", user: "user_tk", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: false });
  client = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "ticket-cmd-"));
});
afterAll(async () => {
  await booted.close();
});

let project: string;
beforeEach(async () => {
  project = await newProject();
  lines = [];
  ctx = { client, project, log: (line) => lines.push(line) };
});

describe("ticket-list", () => {
  async function tree(): Promise<{ a: string; b: string; c: string; d: string; e: string }> {
    const a = await add(project, "Alfa");
    const b = await add(project, "Beta", a);
    const c = await add(project, "Gama", b, "done");
    const d = await add(project, "Delta");
    const e = await add(project, "Épsilon", a, "in_progress");
    return { a, b, c, d, e };
  }

  it("imprime a árvore em pré-ordem, com recuo de dois espaços por nível, situação e progresso", async () => {
    await tree();
    const key = (await rows(project))[0]?.key.split("-")[0] as string;
    await ticketListCommand(ctx, false);
    expect(lines).toEqual([
      `${key}-1  [todo]  Alfa  (1 de 3)`,
      `  ${key}-2  [todo]  Beta  (1 de 1)`,
      `    ${key}-3  [done]  Gama`,
      `  ${key}-5  [in_progress]  Épsilon`,
      `${key}-4  [todo]  Delta`,
    ]);
  });

  it("com --json imprime um único JSON com key, number, id, parentNumber, status, title e progress", async () => {
    const ids = await tree();
    await ticketListCommand(ctx, true);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>[];
    const key = (await rows(project))[0]?.key.split("-")[0] as string;
    expect(parsed.map((r) => r["number"])).toEqual([1, 2, 3, 5, 4]);
    expect(parsed[0]).toEqual({ key: `${key}-1`, number: 1, id: ids.a, parentNumber: null, status: "todo", title: "Alfa", progress: { done: 1, total: 3, excluded: 0, ideas: 0 }, idea: null });
    expect(parsed[2]).toEqual({ key: `${key}-3`, number: 3, id: ids.c, parentNumber: 2, status: "done", title: "Gama", progress: null, idea: null });
    expect(Object.keys(parsed[0] as object).sort()).toEqual(["id", "idea", "key", "number", "parentNumber", "progress", "status", "title"]);
  });

  it("projeto vazio não imprime nada", async () => {
    await ticketListCommand(ctx, false);
    expect(lines).toEqual([]);
  });
});

describe("ticket-create", () => {
  it("cria na raiz e imprime a chave e o id", async () => {
    await ticketCreateCommand(ctx, { title: "Primeiro" });
    const [only] = await rows(project);
    expect(only).toMatchObject({ number: 1, title: "Primeiro", parentId: null, status: "todo" });
    expect(lines).toEqual([`Criado: ${only?.key}  ${only?.id}`]);
  });

  it("cria dentro de um pai identificado pelo número", async () => {
    const a = await add(project, "Pai");
    await ticketCreateCommand(ctx, { title: "Filho", parent: 1 });
    const all = await rows(project);
    expect(all.find((r) => r.title === "Filho")?.parentId).toBe(a);
  });

  it("usa o conteúdo do arquivo como descrição e aceita a situação", async () => {
    const path = file("desc.md", "Linha 1\nLinha 2 — ação\n");
    await ticketCreateCommand(ctx, { title: "Com descrição", descriptionFile: path, status: "in_progress" });
    const [only] = await rows(project);
    const full = await detail(only?.id as string);
    expect(full.description).toBe("Linha 1\nLinha 2 — ação\n");
    expect(full.status).toBe("in_progress");
    expect(lines.join("\n")).not.toContain("Linha 1");
  });

  it("pai inexistente é erro claro e nada é criado", async () => {
    await expect(ticketCreateCommand(ctx, { title: "Órfão", parent: 99 })).rejects.toThrow(/99 não existe neste projeto/);
    expect(await rows(project)).toEqual([]);
  });

  it("arquivo de descrição inexistente é erro antes de qualquer chamada", async () => {
    await expect(ticketCreateCommand(ctx, { title: "X", descriptionFile: join(dir, "nao-existe.md") })).rejects.toThrow(/nao-existe\.md/);
    expect(await rows(project)).toEqual([]);
  });

  it("criar dentro de pai concluído informa a reabertura dos ancestrais", async () => {
    const a = await add(project, "Avô", null, "done");
    const b = await add(project, "Pai", a, "done");
    expect((await detail(a)).status).toBe("done");
    await ticketCreateCommand(ctx, { title: "Novo aberto", parent: 2 });
    expect((await detail(b)).status).not.toBe("done");
    const key = (await rows(project))[0]?.key.split("-")[0] as string;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Criado: /);
    expect(lines[1]).toContain(`${key}-1`);
    expect(lines[1]).toContain(`${key}-2`);
    expect(lines[1]).toMatch(/reaberto/i);
  });

  it("sem reabertura não imprime a segunda linha", async () => {
    await add(project, "Pai");
    await ticketCreateCommand(ctx, { title: "Filho", parent: 1 });
    expect(lines).toHaveLength(1);
  });
});

describe("ticket-update", () => {
  it("muda a situação", async () => {
    await add(project, "A");
    await ticketUpdateCommand(ctx, { number: 1, status: "in_progress" });
    expect((await rows(project))[0]?.status).toBe("in_progress");
    expect(lines.join("\n")).toMatch(/situação.*todo.*in_progress/);
  });

  it("muda o título", async () => {
    await add(project, "Velho");
    await ticketUpdateCommand(ctx, { number: 1, title: "Novo" });
    expect((await rows(project))[0]?.title).toBe("Novo");
    expect(lines.join("\n")).toMatch(/título/);
  });

  it("troca a descrição pelo arquivo sem imprimir o texto", async () => {
    const id = await add(project, "A");
    await ticketUpdateCommand(ctx, { number: 1, descriptionFile: file("nova.md", "Texto secreto") });
    expect((await detail(id)).description).toBe("Texto secreto");
    expect(lines.join("\n")).toMatch(/descrição/);
    expect(lines.join("\n")).not.toContain("Texto secreto");
  });

  it("move para outro pai e depois para a raiz", async () => {
    await add(project, "A");
    const b = await add(project, "B");
    const c = await add(project, "C", b);
    await ticketUpdateCommand(ctx, { number: 3, parent: 1 });
    expect((await detail(c)).parentId).toBe((await rows(project))[0]?.id);
    await ticketUpdateCommand(ctx, { number: 3, root: true });
    expect((await detail(c)).parentId).toBeNull();
    expect(lines.join("\n")).toMatch(/pai/);
  });

  it("concluir com filho aberto mostra o código da API e falha", async () => {
    const a = await add(project, "A");
    await add(project, "B", a);
    await expect(ticketUpdateCommand(ctx, { number: 1, status: "done" })).rejects.toThrow(/ticket_has_open_children/);
    expect((await detail(a)).status).toBe("todo");
  });

  it("a mensagem da recusa traz a mensagem da API e não tem rastro de pilha", async () => {
    const a = await add(project, "A");
    await add(project, "B", a);
    const error = (await ticketUpdateCommand(ctx, { number: 1, status: "done" }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/Conclua ou cancele/);
    expect(error.name).toBe("TicketCommandError");
  });

  it("número inexistente é erro claro", async () => {
    const key = await add(project, "A").then(async () => (await rows(project))[0]?.key.split("-")[0] as string);
    await expect(ticketUpdateCommand(ctx, { number: 99, status: "done" })).rejects.toThrow(`${key}-99 não existe neste projeto`);
  });

  it("pai inexistente é erro claro", async () => {
    await add(project, "A");
    await expect(ticketUpdateCommand(ctx, { number: 1, parent: 77 })).rejects.toThrow(/77 não existe neste projeto/);
  });

  it("nenhum campo informado é erro", async () => {
    await add(project, "A");
    await expect(ticketUpdateCommand(ctx, { number: 1 })).rejects.toThrow(/ao menos um/i);
  });

  it("projeto arquivado aparece com o código da API", async () => {
    await add(project, "A");
    await client.request("PATCH", `/projects/${project}`, { archived: true });
    await expect(ticketUpdateCommand(ctx, { number: 1, title: "B" })).rejects.toThrow(/project_archived/);
    await expect(ticketCreateCommand(ctx, { title: "B" })).rejects.toThrow(/project_archived/);
  });

  it("mover um ticket aberto para dentro de pai concluído informa a reabertura", async () => {
    const a = await add(project, "Pai", null, "done");
    await add(project, "Solto");
    await ticketUpdateCommand(ctx, { number: 2, parent: 1 });
    expect((await detail(a)).status).not.toBe("done");
    expect(lines.join("\n")).toMatch(/reaberto/i);
  });
});

describe("relations-rebuild", () => {
  const owner = ownerPoolWithCleanup();
  const withDescription = async (title: string, description: string): Promise<string> => {
    const response = await client.request("POST", `/projects/${project}/tickets`, { title, description });
    expect(response.status).toBe(201);
    return (response.body as { id: string }).id;
  };
  const mentionedBy = async (id: string): Promise<string[]> =>
    ((await client.request("GET", `/tickets/${id}`)).body as { mentionedBy: { key: string }[] }).mentionedBy.map((row) => row.key);
  const countRelations = async (): Promise<number> =>
    Number((await owner.query("select count(*) from ticket_relations where project_id = $1", [project])).rows[0].count);

  it("refaz as ligações do projeto, imprime as contagens e na segunda vez não muda nada", async () => {
    const a = await add(project, "Alvo");
    const prefix = (await rows(project))[0]?.key.replace(/-\d+$/, "") as string;
    await withDescription("Cita", `ver ${prefix}-1`);
    expect(await countRelations()).toBe(1);
    // Como num projeto cujas descrições já existiam antes da ligação ser gravada: sem ligações.
    await owner.query("delete from ticket_relations where project_id = $1", [project]);
    expect(await mentionedBy(a)).toEqual([]);
    lines = [];
    await relationsRebuildCommand(ctx);
    expect(lines).toEqual(["Tickets lidos: 2; ligações criadas: 1; ligações removidas: 0"]);
    expect(await mentionedBy(a)).toEqual([`${prefix}-2`]);
    lines = [];
    await relationsRebuildCommand(ctx);
    expect(lines).toEqual(["Tickets lidos: 2; ligações criadas: 0; ligações removidas: 0"]);
    expect(await countRelations()).toBe(1);
  });
});

describe("prioridade (ADR 0047)", () => {
  it("ticket-update --priority muda o número (negativo também) e imprime de → para", async () => {
    const id = await add(project, "A");
    await ticketUpdateCommand(ctx, { number: 1, priority: 5 });
    expect(((await detail(id)) as unknown as { priority: number }).priority).toBe(5);
    expect(lines.join("\n")).toMatch(/prioridade 0 → 5/);
    lines = [];
    await ticketUpdateCommand(ctx, { number: 1, priority: -4 });
    expect(((await detail(id)) as unknown as { priority: number }).priority).toBe(-4);
    expect(lines.join("\n")).toMatch(/prioridade 5 → -4/);
  });

  it("combina com outras mudanças no mesmo pedido", async () => {
    const id = await add(project, "A");
    await ticketUpdateCommand(ctx, { number: 1, priority: 2, title: "Novo" });
    expect(await detail(id)).toMatchObject({ title: "Novo", priority: 2 });
  });

  it("ticket-list mostra a prioridade só quando diferente de 0, no texto e no JSON", async () => {
    await add(project, "Zero");
    await add(project, "Alta");
    await add(project, "Baixa");
    await ticketUpdateCommand(ctx, { number: 2, priority: 7 });
    await ticketUpdateCommand(ctx, { number: 3, priority: -1 });
    lines = [];
    await ticketListCommand(ctx, false);
    const key = (await rows(project))[0]?.key.split("-")[0] as string;
    expect(lines).toEqual([`${key}-1  [todo]  Zero`, `${key}-2  [todo]  Alta  {prioridade 7}`, `${key}-3  [todo]  Baixa  {prioridade -1}`]);
    lines = [];
    await ticketListCommand(ctx, true);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>[];
    expect(parsed.map((entry) => entry["priority"])).toEqual([undefined, 7, -1]);
  });
});

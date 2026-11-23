import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ownerPoolWithCleanup } from "./helpers.js";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import type { ApiResponse } from "../scripts/placement-rebuild/client.js";
import { conversationDryRunCommand } from "../scripts/placement-rebuild/conversation-dry-run.js";
import { summaryRegenerateCommand, summaryShowCommand } from "../scripts/placement-rebuild/summary-commands.js";
import type { SummaryContext } from "../scripts/placement-rebuild/summary-commands.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

let booted: Booted;
let real: ApiClient;
let keyCounter = 0;
let lines: string[];
let sleeps: number[];
let calls: string[];
let intercept: ((method: string, path: string) => ApiResponse | null) | null;
let dir: string;
let project: string;
let prefix: string;
const ids = new Map<number, string>();

/** O cliente de verdade, com um gancho que registra as chamadas de regenerar e pode responder no lugar da API. */
const client = {
  request: async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
    const fake = intercept?.(method, path) ?? null;
    if (path.endsWith("/summary/regenerate")) calls.push(path.split("/")[2] as string);
    return fake ?? real.request(method, path, body);
  },
} as unknown as ApiClient;

async function newProject(): Promise<string> {
  const key = `RS${String.fromCharCode(65 + Math.floor(keyCounter / 26))}${String.fromCharCode(65 + (keyCounter++ % 26))}`;
  prefix = key;
  const created = await real.request("POST", "/projects", { key, name: `Projeto ${key}` });
  return (created.body as { id: string }).id;
}
async function add(number: number, title: string, parent: number | null = null): Promise<void> {
  const response = await real.request("POST", `/projects/${project}/tickets`, { title, parentId: parent === null ? null : (ids.get(parent) as string) });
  expect(response.status).toBe(201);
  ids.set(number, (response.body as { id: string }).id);
}
const keyOf = (id: string): string => `${prefix}-${[...ids.entries()].find(([, v]) => v === id)?.[0]}`;
const calledKeys = (): string[] => calls.map(keyOf);

beforeAll(async () => {
  const owner = ownerPoolWithCleanup();
  await owner.query("insert into organizations (org_id, name, slug) values ('org_t1', 'T1', 'org_t1') on conflict do nothing");
  const person = await owner.query<{ id: string }>(
    "insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ('org_t1', 'user_t1', 'Admin', 'a@x.test', 'admin') on conflict do nothing returning id",
  );
  const personId = person.rows[0]?.id ?? (await owner.query<{ id: string }>("select id from people where org_id = 'org_t1' and clerk_user_id = 'user_t1'")).rows[0]?.id;
  await owner.query("insert into organization_consents (org_id, kind, document_version, accepted_by_person_id) values ('org_t1', 'assistant', 'rascunho-1', $1)", [personId]);
  await owner.end();
  booted = await bootApp({ org: "org_t1", user: "user_t1", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: true });
  real = new ApiClient(booted.baseUrl, booted.token);
  dir = mkdtempSync(join(tmpdir(), "summary-cmd-"));
});
afterAll(async () => {
  await booted.close();
});

let ctx: SummaryContext;
beforeEach(async () => {
  project = await newProject();
  ids.clear();
  lines = [];
  sleeps = [];
  calls = [];
  intercept = null;
  ctx = { client, project, log: (line) => lines.push(line), sleep: (ms) => (sleeps.push(ms), Promise.resolve()), dir };
  // 1 ─ 2 ─ 3 ─ 4 (folha); 1 ─ 5 ─ 6 (folha); 7 ─ 8 (folha), fora da subárvore de 1
  await add(1, "Raiz A");
  await add(2, "B", 1);
  await add(3, "C", 2);
  await add(4, "Folha C", 3);
  await add(5, "D", 1);
  await add(6, "Folha D", 5);
  await add(7, "Raiz E");
  await add(8, "Folha E", 7);
});

describe("summary-show", () => {
  it("diz que não existe resumo guardado", async () => {
    await summaryShowCommand(ctx, 2);
    expect(lines).toEqual([`${prefix}-2: sem resumo guardado`]);
  });

  it("mostra o texto guardado, a origem e quando foi atualizado", async () => {
    await real.request("PUT", `/tickets/${ids.get(2)}/summary`, { text: "O que entra aqui: tudo de B." });
    await summaryShowCommand(ctx, 2);
    expect(lines[0]).toMatch(new RegExp(`^${prefix}-2: resumo escrito por pessoa, atualizado em \\d{4}-\\d{2}-\\d{2}T`));
    expect(lines.slice(1)).toEqual(["O que entra aqui: tudo de B."]);
  });

  it("ticket inexistente é erro claro", async () => {
    await expect(summaryShowCommand(ctx, 99)).rejects.toThrow(/99 não existe neste projeto/);
  });
});

describe("summary-regenerate --number", () => {
  it("chama a rota de regenerar do ticket e imprime o resultado", async () => {
    await summaryRegenerateCommand(ctx, { number: 2 });
    expect(calledKeys()).toEqual([`${prefix}-2`]);
    expect(lines).toEqual([`${prefix}-2: resumo regenerado (assistente)`]);
    await summaryShowCommand(ctx, 2);
    expect(lines.at(-1)).toBe("Resumo de B");
  });

  it("ticket sem filhos sai com o código da API", async () => {
    await expect(summaryRegenerateCommand(ctx, { number: 4 })).rejects.toThrow(/ticket_has_no_items/);
  });
});

describe("summary-regenerate --subtree e --all", () => {
  it("--dry-run só lista a ordem (das folhas para o topo) e não chama a rota", async () => {
    await summaryRegenerateCommand(ctx, { subtree: 1, dryRun: true });
    expect(calls).toEqual([]);
    expect(lines).toEqual([`${prefix}-3 (nível 2)`, `${prefix}-2 (nível 1)`, `${prefix}-5 (nível 1)`, `${prefix}-1 (nível 0)`, "4 tickets, nada foi regenerado (--dry-run)."]);
  });

  it("regenera só os que têm filhos dentro de N, em profundidade decrescente, um por vez, imprimindo o progresso", async () => {
    await summaryRegenerateCommand(ctx, { subtree: 1 });
    expect(calledKeys()).toEqual([`${prefix}-3`, `${prefix}-2`, `${prefix}-5`, `${prefix}-1`]);
    expect(lines).toEqual([
      `[1/4] ${prefix}-3 regenerado`,
      `[2/4] ${prefix}-2 regenerado`,
      `[3/4] ${prefix}-5 regenerado`,
      `[4/4] ${prefix}-1 regenerado`,
      "Concluído: 4 resumos regenerados.",
    ]);
    // o resumo do pai já nasce depois dos dos filhos: o de B foi escrito antes do de 1
    expect(existsSync(join(dir, `summary-regenerate-${project}-subtree-1.json`))).toBe(false);
  });

  it("subárvore de um ticket do meio inclui o próprio ticket e deixa o resto de fora", async () => {
    await summaryRegenerateCommand(ctx, { subtree: 2 });
    expect(calledKeys()).toEqual([`${prefix}-3`, `${prefix}-2`]);
  });

  it("subárvore de uma folha não tem o que regenerar", async () => {
    await summaryRegenerateCommand(ctx, { subtree: 4 });
    expect(calls).toEqual([]);
    expect(lines).toEqual([`${prefix}-4 não tem filhos: nada a regenerar.`]);
  });

  it("--all faz o projeto inteiro", async () => {
    await summaryRegenerateCommand(ctx, { all: true });
    expect(calledKeys()).toEqual([`${prefix}-3`, `${prefix}-2`, `${prefix}-5`, `${prefix}-1`, `${prefix}-7`]);
  });

  it("para no primeiro erro com mensagem clara e --resume continua de onde parou, sem repetir os já feitos", async () => {
    intercept = (method, path) =>
      method === "POST" && path === `/tickets/${ids.get(5)}/summary/regenerate`
        ? { status: 503, body: { error: { code: "assistant_unavailable", message: "Assistente indisponível." } } }
        : null;
    await expect(summaryRegenerateCommand(ctx, { subtree: 1 })).rejects.toThrow(
      new RegExp(`${prefix}-5.*assistant_unavailable.*Assistente indisponível\\..*--resume`),
    );
    expect(calledKeys()).toEqual([`${prefix}-3`, `${prefix}-2`, `${prefix}-5`]); // parou: o topo nem foi tentado
    const state = JSON.parse(readFileSync(join(dir, `summary-regenerate-${project}-subtree-1.json`), "utf8")) as { done: number[] };
    expect(state.done).toEqual([3, 2]);

    intercept = null;
    calls = [];
    lines.length = 0;
    await summaryRegenerateCommand(ctx, { subtree: 1, resume: true });
    expect(calledKeys()).toEqual([`${prefix}-5`, `${prefix}-1`]);
    expect(lines).toEqual([`Retomando: 2 de 4 já feitos.`, `[3/4] ${prefix}-5 regenerado`, `[4/4] ${prefix}-1 regenerado`, "Concluído: 4 resumos regenerados."]);
    expect(existsSync(join(dir, `summary-regenerate-${project}-subtree-1.json`))).toBe(false);
  });

  it("--resume sem andamento guardado é erro claro", async () => {
    await expect(summaryRegenerateCommand(ctx, { subtree: 1, resume: true })).rejects.toThrow(/Não há andamento guardado/);
  });

  it("respeita o Retry-After de um 429 e tenta de novo o mesmo ticket", async () => {
    let first = true;
    intercept = (method, path) => {
      if (method === "POST" && path === `/tickets/${ids.get(3)}/summary/regenerate` && first) {
        first = false;
        return { status: 429, body: { error: { code: "rate_limited", message: "Muitas chamadas." } }, retryAfterMs: 2000 };
      }
      return null;
    };
    await summaryRegenerateCommand(ctx, { subtree: 2 });
    expect(sleeps).toEqual([2000]);
    expect(calledKeys()).toEqual([`${prefix}-3`, `${prefix}-3`, `${prefix}-2`]);
    expect(lines.some((line) => line.includes("aguardando 2 s"))).toBe(true);
  });
});

describe("conversation-dry-run", () => {
  const textFile = (text: string): string => {
    const path = join(dir, "pedido.md");
    writeFileSync(path, text);
    return path;
  };
  async function pagamentosTree(): Promise<void> {
    // O beforeEach já criou 1..8; esta árvore usa um projeto próprio para os grupos terem palavras em comum com o pedido.
    project = await newProject();
    ids.clear();
    ctx = { ...ctx, project };
    await add(1, "Pagamentos");
    await add(2, "Cobrar no cartão", 1);
    await add(3, "Estornar pagamentos", 1);
    await add(4, "Acesso e login");
    await add(5, "Entrar com senha", 4);
    await add(6, "Recuperar acesso", 4);
  }
  const tickets = async (): Promise<number> => ((await real.request("GET", `/projects/${project}/tickets`)).body as unknown[]).length;
  const conversations = async (): Promise<number> => ((await real.request("GET", `/ticket-conversations?projectId=${project}`)).body as unknown[]).length;
  type Step = { key: string | null; title: string };
  type DryRun = { draft: unknown; destination: { parentKey: string | null; path: Step[] }; alternatives: unknown[]; decision: Record<string, unknown> & { scope?: { title: string } }; summariesCreated: string[]; conversationDiscarded: boolean; conversationId?: string };
  const run = async (input: { textFile: string; scope?: number }): Promise<DryRun> => {
    lines.length = 0;
    await conversationDryRunCommand(ctx, input);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] as string) as DryRun;
  };

  it("faz o que a tela faz para um pedido novo e não cria ticket nenhum", async () => {
    await pagamentosTree();
    const before = await tickets();
    const out = await run({ textFile: textFile("Cobrar pagamentos recorrentes\n\nCobrança mensal dos pagamentos dos clientes") });
    expect(out.draft).toMatchObject({ title: "Cobrar pagamentos recorrentes", description: "Cobrança mensal dos pagamentos dos clientes", children: [] });
    expect(out.destination.path.map((p) => p.title)).toEqual(["Pagamentos"]);
    expect(out.destination.path[0]?.key).toBe(`${prefix}-1`);
    expect(out.destination.parentKey).toBe(`${prefix}-1`);
    expect(out.alternatives).toBeInstanceOf(Array);
    expect(out.decision).toHaveProperty("uncertain");
    expect(out.decision).toHaveProperty("groupProposal");
    expect(await tickets()).toBe(before);
  });

  it("descarta a própria conversa: nada dela sobra no banco", async () => {
    await pagamentosTree();
    await run({ textFile: textFile("Cobrar pagamentos\n\nCobrança mensal") });
    expect(await conversations()).toBe(0);
    const owner = ownerPoolWithCleanup();
    const left = await owner.query<{ c: string }>("select (select count(*) from ticket_conversations where project_id = $1) + (select count(*) from ticket_conversation_messages where org_id = 'org_t1' and conversation_id not in (select id from ticket_conversations)) as c", [project]);
    await owner.end();
    expect(Number(left.rows[0]?.c)).toBe(0);
  });

  it("a procura grava o resumo dos agrupadores que ainda não tinham e o comando diz quais", async () => {
    await pagamentosTree();
    const before = (await real.request("GET", `/tickets/${ids.get(1)}/summary`)).body as { summary: unknown };
    expect(before.summary).toBeNull();
    const out = await run({ textFile: textFile("Cobrar pagamentos\n\nCobrança mensal") });
    expect(out.summariesCreated).toEqual(expect.arrayContaining([`${prefix}-1`]));
    const after = (await real.request("GET", `/tickets/${ids.get(1)}/summary`)).body as { summary: unknown };
    expect(after.summary).not.toBeNull();
  });

  it("--scope procura dentro do ticket indicado", async () => {
    await pagamentosTree();
    const out = await run({ textFile: textFile("Cobrar pagamentos\n\nCobrança mensal"), scope: 1 });
    expect(out.decision.scope).toMatchObject({ title: "Pagamentos" });
  });

  it("escopo inexistente é erro claro, antes de abrir conversa", async () => {
    await pagamentosTree();
    await expect(conversationDryRunCommand(ctx, { textFile: textFile("x"), scope: 99 })).rejects.toThrow(/99 não existe neste projeto/);
    expect(await conversations()).toBe(0);
  });

  it("se a procura falha, a conversa aberta é descartada mesmo assim e o erro sai com o código da API", async () => {
    await pagamentosTree();
    intercept = (method, path) =>
      method === "POST" && path.endsWith("/placement") ? { status: 503, body: { error: { code: "assistant_unavailable", message: "Indisponível." } } } : null;
    await expect(conversationDryRunCommand(ctx, { textFile: textFile("Cobrar pagamentos") })).rejects.toThrow(/assistant_unavailable/);
    expect(await conversations()).toBe(0);
  });

  it("se não conseguir descartar a conversa, diz isso e traz o id para apagar à mão", async () => {
    await pagamentosTree();
    intercept = (method) => (method === "DELETE" ? { status: 500, body: null } : null);
    const out = await run({ textFile: textFile("Cobrar pagamentos\n\nCobrança mensal") });
    expect(out.conversationDiscarded).toBe(false);
    expect(out.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    intercept = null;
    await real.request("DELETE", `/ticket-conversations/${out.conversationId}`);
  });

  it("arquivo de texto inexistente é erro antes de qualquer chamada", async () => {
    await pagamentosTree();
    await expect(conversationDryRunCommand(ctx, { textFile: join(dir, "nao-existe.md") })).rejects.toThrow(/nao-existe\.md/);
  });
});

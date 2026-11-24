import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_CONFIG, TEST_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { openTicket } from "./chat-support.js";
import { useHarness } from "./harness.js";
import { as, giveConsent } from "./world.js";

const UNKNOWN_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;

type Route = { name: string; method: string; path: (ctx: { project: string; ticket: string; conversation: string }) => string; body?: unknown };
/** Toda rota da API que usa um provedor de IA (ou serve só ao assistente, como o texto do agrupador). */
const AI_ROUTES: Route[] = [
  { name: "abrir conversa", method: "POST", path: ({ project }) => `/api/projects/${project}/ticket-conversations`, body: { message: "Preciso de login" } },
  { name: "mensagem na conversa", method: "POST", path: () => `/api/ticket-conversations/${UNKNOWN_ID}/messages`, body: { message: "Mais uma" } },
  { name: "procurar o lugar", method: "POST", path: () => `/api/ticket-conversations/${UNKNOWN_ID}/placement`, body: {} },
  { name: "ler o texto do agrupador", method: "GET", path: ({ ticket }) => `/api/tickets/${ticket}/summary` },
  { name: "escrever o texto do agrupador", method: "PUT", path: ({ ticket }) => `/api/tickets/${ticket}/summary`, body: { text: "Texto" } },
  { name: "reescrever o texto do agrupador", method: "POST", path: ({ ticket }) => `/api/tickets/${ticket}/summary/regenerate` },
  { name: "escrever na descrição", method: "POST", path: ({ ticket }) => `/api/tickets/${ticket}/description/draft`, body: { request: "Critérios", description: "" } },
  { name: "mensagem no chat do ticket", method: "POST", path: ({ conversation }) => `/api/conversations/${conversation}/messages`, body: { body: "Me ajuda a pensar" } },
  { name: "perguntar sobre o projeto", method: "POST", path: ({ project }) => `/api/projects/${project}/assistant/ask`, body: { question: "Quantos?", history: [] } },
];

describe("sem o aceite do assistente, nenhuma rota de IA chega a um provedor", () => {
  const h = useHarness(AI_CONFIG, { consent: false });
  const ctx = async () => {
    const tree = await seedTree(h.pool, h.world());
    return { project: h.world().projects.priv, ticket: tree.auth, conversation: await openTicket(h, "contributor", tree.auth) };
  };
  const providerCalls = () =>
    h.conversation().calls.length + h.judge().calls.length + h.summarizer().calls.length + h.affinity().calls.length + h.namer().calls.length + h.writer().calls.length + h.answerer().calls.length + h.chat().calls.length + h.elaborator().calls.length;

  it.each(AI_ROUTES)("$name: 403 assistant_consent_required e nenhuma chamada", async (route) => {
    const c = await ctx();
    const res = await h.call(route.method, route.path(c), as("contributor"), route.body);
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe("assistant_consent_required");
    expect(providerCalls()).toBe(0);
  });

  it("o aceite vale para a organização que o deu e não para a outra", async () => {
    const c = await ctx();
    await giveConsent(h.pool, "org_B", h.world().other.person);
    const own = await h.call("POST", `/api/projects/${c.project}/assistant/ask`, as("contributor"), { question: "Quantos?", history: [] });
    expect(errorOf(own)).toBe("assistant_consent_required");
    expect(h.answerer().calls).toHaveLength(0);
  });

  it("retirado com a tela aberta: a próxima requisição já recusa", async () => {
    const c = await ctx();
    await giveConsent(h.pool, "org_A", h.world().people.admin);
    const ok = await h.call("POST", `/api/projects/${c.project}/assistant/ask`, as("contributor"), { question: "Quantos?", history: [] });
    expect(ok.status).toBe(200);
    expect(h.answerer().calls).toHaveLength(1);
    await h.pool.query("update organization_consents set withdrawn_at = now(), withdrawn_by_person_id = $1", [h.world().people.admin]);
    const after = await h.call("POST", `/api/projects/${c.project}/assistant/ask`, as("contributor"), { question: "E agora?", history: [] });
    expect(errorOf(after)).toBe("assistant_consent_required");
    expect(h.answerer().calls).toHaveLength(1);
  });

  it("aceite de versão antiga não vale", async () => {
    const c = await ctx();
    await giveConsent(h.pool, "org_A", h.world().people.admin, "assistant", "rascunho-0");
    const res = await h.call("POST", `/api/projects/${c.project}/assistant/ask`, as("contributor"), { question: "Quantos?", history: [] });
    expect(errorOf(res)).toBe("assistant_consent_required");
  });

  it("o aceite de code_reading sozinho não liga o assistente", async () => {
    const c = await ctx();
    await giveConsent(h.pool, "org_A", h.world().people.admin, "code_reading");
    const res = await h.call("POST", `/api/projects/${c.project}/assistant/ask`, as("contributor"), { question: "Quantos?", history: [] });
    expect(errorOf(res)).toBe("assistant_consent_required");
  });
});

describe("com o aceite, as rotas seguem como antes", () => {
  const h = useHarness(AI_CONFIG);
  it("perguntar sobre o projeto chama o provedor", async () => {
    await seedTree(h.pool, h.world());
    const res = await h.call("POST", `/api/projects/${h.world().projects.priv}/assistant/ask`, as("contributor"), { question: "Quantos?", history: [] });
    expect(res.status).toBe(200);
    expect(h.answerer().calls).toHaveLength(1);
  });
});

describe("a ordem dos motivos: não configurado vem antes do aceite", () => {
  const h = useHarness(TEST_CONFIG, { consent: false });
  it.each(AI_ROUTES)("$name: 503 assistant_not_configured mesmo sem aceite", async (route) => {
    const tree = await seedTree(h.pool, h.world());
    const res = await h.call(route.method, route.path({ project: h.world().projects.priv, ticket: tree.auth, conversation: await openTicket(h, "contributor", tree.auth) }), as("contributor"), route.body);
    expect(res.status).toBe(503);
    expect(errorOf(res)).toBe("assistant_not_configured");
  });
});

// ---- Cobertura: uma função de IA nova não pode nascer sem a conferência -------------------------------------------

const SRC = join(__dirname, "..", "src");
const SCRIPTS = join(__dirname, "..", "scripts");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function portSymbols(): string[] {
  const text = readFileSync(join(SRC, "assistant", "ports.ts"), "utf8");
  return [...text.matchAll(/export const ([A-Z_]+) = Symbol\(/g)].map((m) => m[1] as string).filter((name) => name !== "PLACEMENT_TIMEOUTS");
}

describe("cobertura da conferência do aceite", () => {
  const ports = portSymbols();
  const rel = (file: string) => relative(join(__dirname, ".."), file);

  it("enumera as portas de provedor de ports.ts (onze)", () => {
    expect(ports.sort()).toEqual(["AFFINITY_JUDGE", "BRANCH_JUDGE", "BRANCH_SUMMARIZER", "CHAT_PROVIDER", "CONVERSATION_PROVIDER", "DESCRIPTION_WRITER", "EMBEDDING_PROVIDER", "GROUP_NAMER", "PROJECT_ANSWERER", "RELATED_JUDGE", "TICKET_ELABORATOR"]);
  });

  it("só o módulo do assistente e a porta de entrada (AssistantGate) tocam as portas na API", () => {
    const allowed = new Set(["src/assistant/ports.ts", "src/assistant/assistant.module.ts", "src/assistant/assistant-gate.ts"]);
    const offenders = files(SRC)
      .filter((file) => !allowed.has(rel(file)))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return ports.some((symbol) => new RegExp(`\\b${symbol}\\b`).test(text));
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("ninguém fora do módulo cria um adaptador real (Claude*, Jev*, Voyage*) e usa sem passar pela porta de entrada", () => {
    const allowed = new Set(["src/assistant/assistant.module.ts"]);
    const adapter = /new (Claude[A-Za-z]+|Jev[A-Za-z]+|Voyage[A-Za-z]+)\(/;
    const offenders = files(SRC)
      .filter((file) => !allowed.has(rel(file)))
      .filter((file) => adapter.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("todo controlador que usa a porta de entrada a chama (require) antes de qualquer outra coisa", () => {
    const users = files(join(SRC, "assistant")).filter((file) => /AssistantGate/.test(readFileSync(file, "utf8")) && file.endsWith(".controller.ts"));
    expect(users.map(rel).sort()).toEqual([
      "src/assistant/ask.controller.ts",
      "src/assistant/branch-summary.controller.ts",
      "src/assistant/conversation.controller.ts",
      "src/assistant/conversations.controller.ts",
      "src/assistant/description-draft.controller.ts",
    ]);
    for (const file of users) expect(readFileSync(file, "utf8"), rel(file)).toMatch(/this\.gate\.(open|openIn)\(/);
  });

  it("os controladores de IA não injetam provedor nenhum: só a porta de entrada", () => {
    for (const file of files(join(SRC, "assistant")).filter((f) => f.endsWith(".controller.ts"))) {
      expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(/@Inject\((CHAT_PROVIDER|CONVERSATION_PROVIDER|BRANCH_|AFFINITY_|RELATED_|GROUP_NAMER|DESCRIPTION_WRITER|PROJECT_ANSWERER|TICKET_ELABORATOR|EMBEDDING_PROVIDER)/);
    }
  });

  it("nas ferramentas de linha de comando, quem monta provedor de verdade são só as ferramentas de dados fictícios (verificador e medição da conversa) e as duas entradas conferidas", () => {
    const real = /new (Anthropic|TypeSafeClient|VoyageEmbeddingProvider)\(/;
    const builders = files(SCRIPTS)
      .filter((file) => real.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();
    // `verify-providers.ts` e `measure-conversation.ts` usam só texto fixo (o primeiro, fictício; a segunda, os casos em
    // `scripts/conversation-cases/`), sem ler ticket nem dado de organização; `app.ts` (boot da API e `collect`) e `pairs-kit.ts` (`pairs`) leem tickets
    // de uma organização e são conferidos pelos pontos de entrada abaixo.
    expect(builders).toEqual([
      "scripts/measure-conversation.ts",
      "scripts/placement-rebuild/app.ts",
      "scripts/placement-rebuild/embeddings-kit.ts",
      "scripts/placement-rebuild/pairs-kit.ts",
      "scripts/verify-providers.ts",
    ]);
    expect(readFileSync(join(SCRIPTS, "placement-rebuild", "app.ts"), "utf8")).toMatch(/requireAssistantConsentOfOrg\(baseConfig, options\.org\)/);
    expect(readFileSync(join(SCRIPTS, "placement-rebuild.ts"), "utf8")).toMatch(/requireAssistantConsentOfOrg\(loadConfig\(process\.env\), options\.org\)/);
    // `embeddings-status` e `embeddings-reindex` (kit dos vetores): a conferência vem antes de ler o banco ou criar o provedor.
    const embeddings = readFileSync(join(SCRIPTS, "placement-rebuild", "embeddings-commands.ts"), "utf8");
    const run = embeddings.slice(embeddings.indexOf("export async function runEmbeddingsCommand"));
    expect(run.indexOf("requireAssistantConsentOfOrg(config, options.org as string)")).toBeGreaterThan(-1);
    expect(run.indexOf("requireAssistantConsentOfOrg(")).toBeLessThan(run.indexOf("createPrismaClient"));
    expect(run.indexOf("requireAssistantConsentOfOrg(")).toBeLessThan(run.indexOf("providerFor"));
    expect(readFileSync(join(SCRIPTS, "placement-rebuild.ts"), "utf8")).toMatch(/runEmbeddingsCommand\(command, options/);
    expect(readFileSync(join(SCRIPTS, "verify-providers.ts"), "utf8")).not.toMatch(/organizationConsent|requireAssistantConsent/);
    // A medição só manda ao provedor os textos fixos dos casos: sem banco, sem dado de organização, sem `--org`.
    const measure = readFileSync(join(SCRIPTS, "measure-conversation.ts"), "utf8");
    const code = measure.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/prisma|PrismaClient|requireAssistantConsent|organizationConsent|["']org["']\s*:/i);
    expect(code).not.toMatch(/from "\.\.\/src\/(db|prisma|database)/);
    expect(code).toMatch(/conversation-cases/);
  });
});

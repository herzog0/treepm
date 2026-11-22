/**
 * Verificação com os provedores de verdade (ADR 0029). Quem roda é Teodoro:
 *
 *   pnpm --filter @treepm/api verify:providers
 *
 * Lê só `ANTHROPIC_API_KEY` e `TYPESAFE_API_KEY` (do ambiente ou de `apps/api/.env.local`). Não lê banco, não lê
 * dados reais: todo o texto enviado é o fixo e fictício abaixo, impresso antes de cada chamada. Faz 6 verificações (a 5 e a 6 fazem várias chamadas, a 6 no máximo 2):
 * um turno de conversa (Claude Opus 5.5, esforço medium), um resumo de ramo (Claude Opus 5.5, esforço low) e uma
 * requisição ao Jev com três ramos fictícios, um texto para a descrição (Claude Opus 5.5, esforço low), a pergunta sobre
 * o projeto com o laço de ferramentas (executor em memória, tickets fictícios) e a mesma pergunta com o limite de rodadas
 * em 1, para exercitar a última chamada, sem ferramentas (`tool_choice` "none"). Custo estimado: centavos de dólar.
 */
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ClaudeBranchSummarizer } from "../src/assistant/claude-branch-summarizer.js";
import { sdkStreamer } from "../src/assistant/claude-call.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { ClaudeConversationProvider } from "../src/assistant/claude-conversation-provider.js";
import { ClaudeDescriptionWriter } from "../src/assistant/claude-description-writer.js";
import { ClaudeProjectAnswerer } from "../src/assistant/claude-project-answerer.js";
import { JevBranchJudge, sdkSystemOne } from "../src/assistant/jev-branch-judge.js";
import type { SystemOneCall } from "../src/assistant/jev-branch-judge.js";
import type { ToolExecutor, ToolOutcome } from "../src/assistant/ports.js";

const PERSON_MESSAGE = "Quero que o botão de entrar da tela de login volte a responder ao clique no celular.";
const BRANCH = {
  title: "Acesso e autenticação",
  descriptionExcerpt: "Tudo o que permite as pessoas entrarem na plataforma.",
  children: [
    { title: "Tela de login", summary: null },
    { title: "Recuperação de senha", summary: null },
  ],
};
const DRAFT = { title: "Botão de entrar não responde no celular", description: "O botão da tela de login não reage ao toque em celulares." };
const CANDIDATES = [
  { id: "ficticio-1", title: "Acesso e autenticação", summary: "Login, senha e sessões das pessoas na plataforma.", hasChildren: true },
  { id: "ficticio-2", title: "Cobrança e faturas", summary: "Planos, faturas e pagamentos da organização.", hasChildren: true },
  { id: "ficticio-3", title: "Relatórios", summary: "Painéis e exportações de dados de uso.", hasChildren: true },
];
const DESCRIPTION_INPUT = {
  title: "Botão de entrar não responde no celular",
  description: "O botão da tela de login não reage ao toque.",
  ancestors: ["Acesso e autenticação", "Tela de login"],
  request: "Escreva os passos para reproduzir o problema.",
};
const ASK_QUESTION = "O que falta fazer neste projeto?";

type FakeTicket = { label: string; title: string; excerpt: string; status: string; parent: string | null };
const FAKE_TICKETS: FakeTicket[] = [
  { label: "T1", title: "Acesso e autenticação", excerpt: "Tudo o que permite as pessoas entrarem.", status: "in_progress", parent: null },
  { label: "T2", title: "Tela de login", excerpt: "Formulário de entrada.", status: "in_progress", parent: "T1" },
  { label: "T3", title: "Botão de entrar não responde no celular", excerpt: "Não reage ao toque.", status: "todo", parent: "T2" },
  { label: "T4", title: "Recuperação de senha", excerpt: "Envio do link por e-mail.", status: "todo", parent: "T1" },
  { label: "T5", title: "Relatórios de uso", excerpt: "Painéis de dados de uso.", status: "done", parent: null },
  { label: "T6", title: "Exportação em CSV", excerpt: "Baixar os dados dos painéis.", status: "cancelled", parent: "T5" },
];
const toolOutcome = (value: unknown, isError = false): ToolOutcome => ({ content: typeof value === "string" ? value : JSON.stringify(value), isError });

/** Executor em memória: as quatro ferramentas sobre os tickets fictícios acima, no formato que o modelo recebe (rótulos, sem id nem chave). */
function inMemoryTools(): ToolExecutor & { executions: number } {
  const tools = {
    executions: 0,
    async execute(name: string, input: unknown): Promise<ToolOutcome> {
      tools.executions += 1;
      const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      switch (name) {
        case "project_overview": {
          const byStatus = Object.fromEntries(["todo", "in_progress", "in_review", "done", "cancelled"].map((status) => [status, FAKE_TICKETS.filter((t) => t.status === status).length]));
          return toolOutcome({ total: FAKE_TICKETS.length, by_status: byStatus, top: { tickets: FAKE_TICKETS.filter((t) => t.parent === null).map((t) => ({ ...t, progress: null })), truncated: false } });
        }
        case "list_tickets": {
          const status = Array.isArray(args["status"]) ? (args["status"] as string[]) : null;
          return toolOutcome({ tickets: FAKE_TICKETS.filter((t) => !status || status.includes(t.status)), truncated: false, after: null });
        }
        case "search_tickets": {
          const query = String(args["query"] ?? "").toLowerCase();
          return toolOutcome({ tickets: FAKE_TICKETS.filter((t) => `${t.title} ${t.excerpt}`.toLowerCase().includes(query)), truncated: false });
        }
        case "read_ticket": {
          const ticket = FAKE_TICKETS.find((t) => t.label === args["ticket"]);
          if (!ticket) return toolOutcome(`Ticket ${String(args["ticket"])} não existe neste projeto.`, true);
          const children = FAKE_TICKETS.filter((t) => t.parent === ticket.label);
          const empty = { tickets: [], truncated: false };
          return toolOutcome({
            ...ticket,
            description: ticket.excerpt,
            path: [],
            children: { tickets: children, truncated: false },
            relations: { mentions: { outgoing: empty, incoming: empty }, depends_on: { outgoing: empty, incoming: empty } },
          });
        }
        default:
          return toolOutcome("Ferramenta desconhecida.", true);
      }
    },
  };
  return tools;
}

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const typesafeKey = process.env["TYPESAFE_API_KEY"];
if (!anthropicKey || !typesafeKey) {
  console.error("Faltam ANTHROPIC_API_KEY e/ou TYPESAFE_API_KEY (ambiente ou apps/api/.env.local). Nada foi enviado.");
  process.exit(1);
}

let claudeUsage: unknown = null;
const base = sdkStreamer(new Anthropic({ apiKey: anthropicKey, maxRetries: 0 }));
const streamer: ClaudeStreamer = async (params, options) => {
  const final = await base(params, options);
  claudeUsage = (final as unknown as { usage?: unknown }).usage ?? null;
  return final;
};
let jevUsage: unknown = null;
let jevModel: unknown = null;
const baseJev = sdkSystemOne(new TypeSafeClient({ apiKey: typesafeKey, logLevel: "off" }));
const jevCall: SystemOneCall = async (request, options) => {
  const result = await baseJev(request, options);
  jevUsage = result.usage;
  jevModel = result.model;
  return result;
};

async function step<T>(name: string, sent: unknown, run: () => Promise<T>, usage: () => unknown): Promise<void> {
  console.log(`\n=== ${name} ===`);
  console.log("Texto enviado:", JSON.stringify(sent, null, 2));
  const started = Date.now();
  try {
    const result = await run();
    console.log(`Duração: ${Date.now() - started} ms`);
    if (name.startsWith("3.")) console.log("Modelo que respondeu:", jevModel);
    console.log("Tokens usados (informados pelo SDK):", JSON.stringify(usage()));
    console.log("Resultado estruturado:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(`FALHOU após ${Date.now() - started} ms: ${error instanceof Error ? error.constructor.name : typeof error}`);
    if (error && typeof error === "object" && "reason" in error) console.log("Motivo:", String((error as { reason: unknown }).reason));
    process.exitCode = 1;
  }
}

await step(
  "1. Turno de conversa (Claude Opus 5.5, esforço medium)",
  { history: [{ author: "person", body: PERSON_MESSAGE }], draft: null, groups: [] },
  () => new ClaudeConversationProvider(streamer).turn({ history: [{ author: "person", body: PERSON_MESSAGE }], draft: null, groups: [] }),
  () => claudeUsage,
);
await step(
  "2. Resumo de ramo (Claude Opus 5.5, esforço low)",
  BRANCH,
  () => new ClaudeBranchSummarizer(streamer).summarize(BRANCH),
  () => claudeUsage,
);
await step(
  "3. Escolha do ramo (Jev jev-1.14.0, um Noul e um Choice, três ramos fictícios)",
  { draft: DRAFT, current: null, candidates: CANDIDATES },
  () => new JevBranchJudge(jevCall).judge({ draft: DRAFT, current: null, candidates: CANDIDATES }),
  () => jevUsage,
);
await step(
  "4. Escrita na descrição (Claude Opus 5.5, esforço low)",
  DESCRIPTION_INPUT,
  async () => {
    const out = await new ClaudeDescriptionWriter(streamer).write(DESCRIPTION_INPUT);
    if (out.text.trim().length < 1) throw new Error("texto vazio");
    return out;
  },
  () => claudeUsage,
);

async function askStep(name: string, options: { maxToolRounds?: number }, expectTools: boolean): Promise<void> {
  const tools = inMemoryTools();
  let calls = 0;
  const counting: ClaudeStreamer = (params, callOptions) => {
    calls += 1;
    return streamer(params, callOptions);
  };
  await step(
    name,
    { question: ASK_QUESTION, tickets: FAKE_TICKETS.length, options },
    async () => {
      const out = await new ClaudeProjectAnswerer(counting, options).answer({ question: ASK_QUESTION, history: [], tools });
      if (out.text.trim().length < 1) throw new Error("texto vazio");
      if (tools.executions < 1) throw new Error("nenhuma ferramenta foi executada");
      if (!expectTools && calls < 2) throw new Error("a chamada final, sem ferramentas, não aconteceu");
      return { chamadas_ao_provedor: calls, execucoes_de_ferramenta: tools.executions, model: out.model, chars: out.text.length };
    },
    () => claudeUsage,
  );
}
await askStep("5. Pergunta sobre o projeto (Claude Opus 5.5, esforço medium, laço de ferramentas)", {}, true);
await askStep("6. Pergunta com o limite em 1 rodada (última chamada sem ferramentas, tool_choice none)", { maxToolRounds: 1 }, false);

/**
 * Verificação com os provedores de verdade (ADR 0029). Quem roda é Teodoro:
 *
 *   pnpm --filter @treepm/api verify:providers
 *
 * Lê só `ANTHROPIC_API_KEY` e `TYPESAFE_API_KEY` (do ambiente ou de `apps/api/.env.local`). Não lê banco, não lê
 * dados reais: todo o texto enviado é o fixo e fictício abaixo, impresso antes de cada chamada. Faz 3 chamadas:
 * um turno de conversa (Claude Opus 5.5, esforço medium), um resumo de ramo (Claude Opus 5.5, esforço low) e uma
 * requisição ao Jev com três ramos fictícios. Custo estimado: centavos de dólar.
 */
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ClaudeBranchSummarizer } from "../src/assistant/claude-branch-summarizer.js";
import { sdkStreamer } from "../src/assistant/claude-call.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { ClaudeConversationProvider } from "../src/assistant/claude-conversation-provider.js";
import { JevBranchJudge, sdkSystemOne } from "../src/assistant/jev-branch-judge.js";
import type { SystemOneCall } from "../src/assistant/jev-branch-judge.js";

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
  { history: [{ author: "person", body: PERSON_MESSAGE }], draft: null },
  () => new ClaudeConversationProvider(streamer).turn({ history: [{ author: "person", body: PERSON_MESSAGE }], draft: null }),
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

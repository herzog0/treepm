/**
 * Medição da conversa de novo ticket com o Claude de verdade (ADR 0044, TREEPM-211). Quem roda é a coordenação:
 *
 *   pnpm --filter @treepm/api measure:conversation [--case <id>] [--runs N] [--turns 1|2] [--json <arquivo>]
 *
 * Lê só `ANTHROPIC_API_KEY` (do ambiente ou de `apps/api/.env.local`). Não usa banco nem a API no ar: monta o mesmo
 * adaptador da API (`ClaudeConversationProvider`, com o mesmo texto do sistema) e manda cada caso sem rascunho e sem
 * agrupadores. Custo: uma chamada ao Claude Opus 5.5 por caso, por repetição e por turno.
 *
 * Casos: `scripts/conversation-cases/*.json`, um por arquivo:
 *   {
 *     "id": "chat-por-ticket",
 *     "messages": ["mensagem da pessoa", "..."],       // na ordem; normalmente uma
 *     "expectChildren": true | false | "either",       // a IA deve propor filhos, não deve, ou tanto faz
 *     "expectIdea": true | false,                      // opcional: a IA deve ligar `idea`, ou não deve; ausente, não se confere
 *     "minChildren": 6, "maxChildren": 12,             // opcionais
 *     "mustMention": [{ "label": "branch", "anyOf": ["branch", "ramo"] }],  // detalhes que não podem se perder: pelo menos um
 *                                                      // trecho de `anyOf` (sem diferenciar caixa nem acento) no título + descrição do pai e dos filhos
 *     "mustNotMention": ["critérios de aceite", "fase"] // trechos que a pessoa não disse; começam numa palavra ("fase" não acusa "ênfase")
 *   }
 *
 * Um turno por caso, por padrão. Se a resposta vier sem rascunho ou com `ready: false`, a pergunta é registrada e não
 * respondida; com `--turns 2` ela é respondida uma vez com "Pode seguir com o que eu já disse, sem inventar nada." e o
 * segundo turno é o que se mede. `--runs N` repete cada caso N vezes e mostra a variação. `--json` grava tudo
 * (inclusive o rascunho inteiro) para comparar rodadas. Sai com 0 mesmo quando um caso falha na medição; sai com 1 só
 * se o provedor não estiver configurado ou falhar.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { sdkStreamer } from "../src/assistant/claude-call.js";
import { ClaudeConversationProvider } from "../src/assistant/claude-conversation-provider.js";
import { ClaudeTicketElaborator } from "../src/assistant/claude-ticket-elaborator.js";
import type { ConversationMessage, ConversationTurn } from "../src/assistant/ports.js";
import { checkDraft, checkElaborationWithLookup } from "./conversation-checks.js";
import type { ConversationCase, DraftCheck, ElaborationCheck } from "./conversation-checks.js";

const FOLLOW_UP = "Pode seguir com o que eu já disse, sem inventar nada.";

const caseSchema = z.object({
  id: z.string().min(1),
  messages: z.array(z.string().min(1)).min(1),
  expectChildren: z.union([z.boolean(), z.literal("either")]),
  expectIdea: z.boolean().optional(),
  minChildren: z.number().int().min(0).optional(),
  maxChildren: z.number().int().min(0).optional(),
  mustMention: z.array(z.object({ label: z.string().min(1), anyOf: z.array(z.string().min(1)).min(1) })),
  mustNotMention: z.array(z.string().min(1)),
  // ADR 0052, fatia 3: com `related` (mesmo vazio) o caso também mede a elaboração.
  related: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), excerpt: z.string().default(""), status: z.string().min(1) })).optional(),
  expectLinkKeys: z.array(z.string().min(1)).optional(),
  minSuggested: z.number().int().min(0).optional(),
  maxSuggested: z.number().int().min(0).optional(),
  // R4: a árvore inteira do caso (inclui tickets que o modelo não recebeu), o falso do Claude por título (só nos testes; aqui responde o real) e o que não pode sobrar como sugerida.
  tree: z.array(z.object({ key: z.string().min(1), title: z.string().min(1), excerpt: z.string().default(""), status: z.string().min(1) })).optional(),
  sameRequestByTitle: z.array(z.object({ ticketTitle: z.string().min(1), whenSuggestedMentions: z.array(z.string().min(1)).min(1) })).optional(),
  noSuggestedMention: z.array(z.string().min(1)).optional(),
});

type RunResult = {
  caseId: string;
  run: number;
  /** Quantos turnos foram feitos (1, ou 2 com `--turns 2` quando o primeiro só perguntou). */
  turns: number;
  /** Perguntas da IA que ficaram sem rascunho (registradas, não respondidas). */
  questions: string[];
  /** Mensagem da IA no turno medido. */
  message: string;
  draft: ConversationTurn["draft"];
  check: DraftCheck;
  /** A elaboração (ligações e sugeridas), medida à parte do rascunho; ausente quando o caso não tem `related`. */
  elaboration?: ElaborationCheck;
  model: string;
  ms: number;
};

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    runs: { type: "string", default: "1" },
    turns: { type: "string", default: "1" },
    json: { type: "string" },
  },
});
const runs = Number(values.runs);
const maxTurns = Number(values.turns);
if (!Number.isInteger(runs) || runs < 1 || ![1, 2].includes(maxTurns)) {
  console.error("Uso: measure:conversation [--case <id>] [--runs N (inteiro ≥ 1)] [--turns 1|2] [--json <arquivo>]");
  process.exit(2);
}

const casesDir = join(dirname(fileURLToPath(import.meta.url)), "conversation-cases");
const allCases: ConversationCase[] = readdirSync(casesDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => caseSchema.parse(JSON.parse(readFileSync(join(casesDir, name), "utf8"))));
const cases = values.case ? allCases.filter((c) => c.id === values.case) : allCases;
if (cases.length === 0) {
  console.error(`Nenhum caso${values.case ? ` com id "${values.case}"` : ""} em ${casesDir}. Disponíveis: ${allCases.map((c) => c.id).join(", ")}`);
  process.exit(2);
}

const anthropicKey = process.env["ANTHROPIC_API_KEY"];
if (!anthropicKey) {
  console.error("Falta ANTHROPIC_API_KEY (ambiente ou apps/api/.env.local). Nada foi enviado.");
  process.exit(1);
}
const streamer = sdkStreamer(new Anthropic({ apiKey: anthropicKey, maxRetries: 0 }));
const provider = new ClaudeConversationProvider(streamer);
const elaborator = new ClaudeTicketElaborator(streamer);

async function runCase(testCase: ConversationCase, run: number): Promise<RunResult> {
  const started = Date.now();
  const history: ConversationMessage[] = testCase.messages.map((body) => ({ author: "person", body }));
  const questions: string[] = [];
  let turn = await provider.turn({ history, draft: null, groups: [] });
  let turns = 1;
  if ((turn.draft === null || !turn.ready) && maxTurns >= 2) {
    questions.push(turn.message);
    history.push({ author: "assistant", body: turn.message }, { author: "person", body: FOLLOW_UP });
    turn = await provider.turn({ history, draft: turn.draft, groups: [] });
    turns = 2;
  } else if (turn.draft === null || !turn.ready) {
    questions.push(turn.message);
  }
  // A elaboração roda sobre o rascunho que a conversa propôs, com a árvore do caso, e passa pelo mesmo descarte da rota.
  let elaboration: ElaborationCheck | undefined;
  if (testCase.related !== undefined && turn.draft !== null) {
    const answer = await elaborator.elaborate({ draft: { title: turn.draft.title, description: turn.draft.description, parts: turn.draft.children ?? [] }, related: testCase.related });
    elaboration = await checkElaborationWithLookup(testCase, turn.draft, answer, elaborator);
  }
  return {
    caseId: testCase.id,
    run,
    turns,
    questions,
    message: turn.message,
    draft: turn.draft,
    check: checkDraft(testCase, turn),
    ...(elaboration ? { elaboration } : {}),
    model: turn.model,
    ms: Date.now() - started,
  };
}

const flag = (ok: boolean): string => (ok ? "ok" : "FALHOU");
const clip = (text: string, size = 90): string => (text.length > size ? `${text.slice(0, size - 1)}…` : text);

function printRun(result: RunResult, testCase: ConversationCase): void {
  const c = result.check;
  console.log(`\n--- ${result.caseId} (rodada ${result.run}) ---`);
  console.log(`modelo: ${result.model} | tempo: ${result.ms} ms | turnos: ${result.turns}`);
  for (const question of result.questions) console.log(`pergunta da IA (sem resposta no turno medido): ${clip(question, 300)}`);
  console.log(`rascunho: ${c.hasDraft ? "sim" : "NÃO"} | pronto: ${c.ready ? "sim" : "não"} | filhos: ${c.childCount} (${flag(c.childrenOk)}; esperado ${JSON.stringify(testCase.expectChildren)}${testCase.minChildren !== undefined || testCase.maxChildren !== undefined ? ` de ${testCase.minChildren ?? 0} a ${testCase.maxChildren ?? "∞"}` : ""})`);
  console.log(`ideia: ${c.idea ? "sim" : "não"}${testCase.expectIdea === undefined ? "" : ` (${flag(c.ideaOk)}; esperado ${testCase.expectIdea ? "sim" : "não"})`}`);
  if (c.parentTitle !== null) {
    console.log(`pai: ${c.parentTitle}`);
    c.childTitles.forEach((title, index) => console.log(`  filho ${index + 1}: ${title}`));
  }
  console.log(`descrição do pai: ${c.parentDescriptionLength} caracteres | soma das dos filhos: ${c.childrenDescriptionLength}`);
  const covered = c.mentions.filter((m) => m.covered).length;
  console.log(`detalhes cobertos: ${covered}/${c.mentions.length}`);
  for (const mention of c.mentions) if (!mention.covered) console.log(`  PERDIDO: ${mention.label}`);
  for (const hit of c.invented) console.log(`  INVENTADO "${hit.phrase}": …${hit.context}…`);
  if (c.ticketKeys.length > 0) console.log(`  CHAVE DE TICKET no texto da IA: ${c.ticketKeys.join(", ")}`);
  if (c.claims.length > 0) console.log(`  A IA DIZ QUE FEZ ALGO: ${c.claims.map((claim) => `"${claim}"`).join(", ")}`);
  const e = result.elaboration;
  if (e) {
    console.log(`o modelo propôs: ligações ${e.modelLinkKeys.length === 0 ? "nenhuma" : e.modelLinkKeys.join(", ")}; sugeridas ${e.modelSuggestedTitles.length === 0 ? "nenhuma" : e.modelSuggestedTitles.map((title) => clip(title)).join(" | ")}`);
    console.log(`virou ligação na segunda chamada: ${e.convertedKeys.length === 0 ? "nada" : e.convertedKeys.join(", ")}; ficou sugerido: ${e.suggestedCount}`);
    if (e.suggestedMissing.length > 0) console.log(`  FALTOU NA SUGERIDA: ${e.suggestedMissing.join("; ")}`);
    console.log(`ligações propostas: ${e.linkKeys.length === 0 ? "nenhuma" : e.links.map((l) => `${l.de === "pai" ? "pai" : `parte ${l.de}`} → ${l.dependeDe}`).join(", ")} (${flag(e.linksMissing.length === 0)}${e.linksMissing.length > 0 ? `; faltou ${e.linksMissing.join(", ")}` : ""})`);
    console.log(`sugeridas pelo assistente (à parte de "inventados"): ${e.suggestedCount} (${flag(e.suggestedOk)}; esperado ${testCase.minSuggested ?? 0} a ${testCase.maxSuggested ?? "∞"})`);
    for (const hit of e.equivalentSuggested) console.log(`  SUGERIDA EQUIVALENTE A TICKET DA ÁRVORE "${hit.phrase}": …${hit.context}…`);
    e.suggested.forEach((task, index) => console.log(`  sugerida ${index + 1}: ${clip(task.title)} — ${clip(task.motivo, 120)}`));
  }
  console.log(`resultado: ${c.passes && (e?.passes ?? true) ? "PASSA em tudo" : "NÃO passa"}`);
}

const results: RunResult[] = [];
let failed = false;
console.log(`Medição da conversa: ${cases.length} caso(s) × ${runs} rodada(s), até ${maxTurns} turno(s) por rodada.`);
for (const testCase of cases) {
  for (let run = 1; run <= runs; run += 1) {
    try {
      const result = await runCase(testCase, run);
      results.push(result);
      printRun(result, testCase);
    } catch (error) {
      failed = true;
      const reason = error && typeof error === "object" && "reason" in error ? String((error as { reason: unknown }).reason) : "";
      console.log(`\n--- ${testCase.id} (rodada ${run}) ---\nFALHOU no provedor: ${error instanceof Error ? error.constructor.name : typeof error}${reason ? ` (${reason})` : ""}`);
    }
  }
}

console.log("\n=== Resumo ===");
let missedTotal = 0;
let inventedTotal = 0;
let keysTotal = 0;
let claimsTotal = 0;
let ideaMisses = 0;
let passingCases = 0;
for (const testCase of cases) {
  const own = results.filter((r) => r.caseId === testCase.id);
  if (own.length === 0) continue;
  const passes = own.filter((r) => r.check.passes && (r.elaboration?.passes ?? true)).length;
  if (passes === own.length) passingCases += 1;
  missedTotal += own.reduce((sum, r) => sum + r.check.missed.length, 0);
  inventedTotal += own.reduce((sum, r) => sum + r.check.invented.length, 0);
  keysTotal += own.reduce((sum, r) => sum + r.check.ticketKeys.length, 0);
  claimsTotal += own.reduce((sum, r) => sum + r.check.claims.length, 0);
  ideaMisses += own.filter((r) => !r.check.ideaOk).length;
  const counts = own.map((r) => r.check.childCount);
  const covered = own.map((r) => `${r.check.mentions.filter((m) => m.covered).length}/${r.check.mentions.length}`);
  const variation = own.length > 1 ? ` | filhos ${Math.min(...counts)}–${Math.max(...counts)} | cobertos ${covered.join(", ")} | tempo ${Math.min(...own.map((r) => r.ms))}–${Math.max(...own.map((r) => r.ms))} ms` : "";
  console.log(`${testCase.id}: passa ${passes}/${own.length}${variation}`);
}
console.log(`Casos que passam em tudo (todas as rodadas): ${passingCases}/${cases.length}`);
console.log(`Detalhes perdidos no total: ${missedTotal}`);
console.log(`Trechos inventados no total: ${inventedTotal} (chaves de ticket: ${keysTotal}; "criei/dividi": ${claimsTotal})`);
console.log(`Rodadas em que \`idea\` não é o esperado: ${ideaMisses}`);
const elaborated = results.filter((r) => r.elaboration);
console.log(`Elaboração (${elaborated.length} rodada(s)): ligações esperadas que faltaram ${elaborated.reduce((sum, r) => sum + (r.elaboration?.linksMissing.length ?? 0), 0)}; tarefas sugeridas pelo assistente ${elaborated.reduce((sum, r) => sum + (r.elaboration?.suggestedCount ?? 0), 0)} (contadas à parte de "inventados"); fora do esperado ${elaborated.filter((r) => !r.elaboration?.passes).length}`);

if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ at: new Date().toISOString(), runs, maxTurns, results }, null, 2)}\n`);
  console.log(`Resultado completo gravado em ${values.json}`);
}
if (failed) process.exitCode = 1;

import { Logger } from "@nestjs/common";
import { choice, noul } from "@typesafe-ai/sdk";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { AssistantUnavailableError } from "./ports.js";
import type { BranchJudge, BranchJudgment } from "./ports.js";
import {
  JEV_BELONGS_FALSE,
  JEV_BELONGS_QUESTION,
  JEV_BELONGS_TRUE,
  JEV_CHOICE_QUESTION,
  JEV_MODEL,
  JEV_SCOPE_FALSE,
  JEV_SCOPE_QUESTION,
  JEV_SCOPE_TRUE,
} from "./prompts.js";

export { JEV_MODEL };

type JudgeInput = Parameters<BranchJudge["judge"]>[0];

/** Tempo máximo por tentativa; o total da procura (30 s) é imposto por quem chama, pelo sinal. */
const ATTEMPT_TIMEOUT_MS = 20_000;
/** Limite do Jev 1.14: 32 mil tokens por pergunta e 64 mil por requisição. Fica bem abaixo, porque a contagem é estimada. */
export const JEV_TOKEN_BUDGET = 28_000;

/**
 * As páginas da TypeSafe não documentam a contagem de tokens. Estimativa conservadora própria: um token a cada
 * 3 caracteres (português costuma render 3,5 a 4), mais 20% de margem.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 3) * 1.2);
}

/** A requisição inteira (estado e perguntas) cabe no orçamento? Senão a procura para no nível. */
export function judgeInputFits(input: JudgeInput): boolean {
  return estimateTokens(JSON.stringify(buildJudgeRequest(input).request)) <= JEV_TOKEN_BUDGET;
}

/** Os nomes das opções são os títulos dos agrupadores (descrevem o conteúdo); repetidos ganham " (2)", " (3)"… */
function labelCandidates(candidates: JudgeInput["candidates"]): { label: string; id: string; summary: string; hasChildren: boolean }[] {
  const used = new Set<string>();
  return candidates.map((candidate) => {
    let label = candidate.title;
    for (let n = 2; used.has(label); n++) label = `${candidate.title} (${n})`;
    used.add(label);
    return { label, id: candidate.id, summary: candidate.summary, hasChildren: candidate.hasChildren };
  });
}

/** Agrupador com filhos: resumo; vazio: trecho da descrição, e sem o campo quando não há descrição. */
const groupState = (title: string, summary: string, hasChildren: boolean): Record<string, string> =>
  hasChildren ? { title, summary } : summary === "" ? { title } : { title, description: summary };

export function buildJudgeRequest(input: JudgeInput) {
  const labelled = labelCandidates(input.candidates);
  const { scope } = input;
  const state = {
    draft: { title: input.draft.title, description: input.draft.description },
    // Ausente na raiz e no escopo sem resumo.
    ...(input.current && input.current.summary !== "" ? { current_group: { title: input.current.title, summary: input.current.summary } } : {}),
    ...(scope ? { scope: groupState(scope.title, scope.summary, scope.hasChildren) } : {}),
    // Sem candidatos (escopo sem agrupadores filhos) a requisição leva só a pergunta do escopo.
    ...(labelled.length > 0
      ? { candidate_groups: labelled.map(({ label, summary, hasChildren }) => groupState(label, summary, hasChildren)) }
      : {}),
  };
  const questions = {
    ...(labelled.length > 0
      ? {
          belongs: noul(JEV_BELONGS_QUESTION, { true: JEV_BELONGS_TRUE, false: JEV_BELONGS_FALSE }),
          branch: choice(
            JEV_CHOICE_QUESTION,
            Object.fromEntries(labelled.map(({ label, summary, hasChildren }) => [label, !hasChildren && summary === "" ? null : summary])),
          ),
        }
      : {}),
    ...(scope ? { scope: noul(JEV_SCOPE_QUESTION, { true: JEV_SCOPE_TRUE, false: JEV_SCOPE_FALSE }) } : {}),
  };
  const request = { model: JEV_MODEL, state, questions };
  return { request, labelled };
}

/** A chamada ao SDK, em uma função: é o que os testes substituem. */
export type SystemOneCall = (
  request: ReturnType<typeof buildJudgeRequest>["request"],
  options: { signal?: AbortSignal; timeout: number },
) => Promise<{ model: string; answers: unknown; usage: { input_tokens?: number | null; output_tokens?: number | null } }>;

export function sdkSystemOne(client: TypeSafeClient): SystemOneCall {
  return (request, options) => client.systemOne(request, { ...options, retry: { maxRetries: 1 } });
}

const noulSchema = z.object({ noul: z.number().min(0).max(1) });
const answersSchema = z.object({
  belongs: noulSchema,
  branch: z.object({ probabilities: z.record(z.string(), z.number().min(0).max(1)) }),
});
const scopeAnswerSchema = z.object({ scope: noulSchema });

/** Adaptador do Jev para a escolha do agrupador pai do ticket novo (ADR 0029, ADR 0031). Nunca registra o texto enviado nem o recebido. */
export class JevBranchJudge implements BranchJudge {
  private readonly logger = new Logger("JevBranchJudge");

  constructor(private readonly call: SystemOneCall) {}

  async judge(input: JudgeInput, options: { signal?: AbortSignal } = {}): Promise<BranchJudgment> {
    const started = Date.now();
    const { request, labelled } = buildJudgeRequest(input);
    let result: Awaited<ReturnType<SystemOneCall>>;
    try {
      result = await this.call(request, { ...(options.signal ? { signal: options.signal } : {}), timeout: ATTEMPT_TIMEOUT_MS });
    } catch (error) {
      // Só a classe do erro vai para o log: a mensagem pode carregar texto do usuário.
      this.logger.warn(`falha do provedor tipo=${error instanceof Error ? error.constructor.name : typeof error}`);
      throw new AssistantUnavailableError("provider_error");
    }
    const scopeFit = input.scope ? scopeAnswerSchema.safeParse(result.answers) : null;
    if (scopeFit && !scopeFit.success) throw new AssistantUnavailableError("invalid_output");
    const scopeResult = scopeFit?.success ? { scopeFit: scopeFit.data.scope.noul } : {};
    if (labelled.length === 0) {
      // Só a pergunta do escopo foi feita; `belongs` e `choice` não existem nesta requisição.
      if (!input.scope) throw new AssistantUnavailableError("invalid_output");
      this.logger.log(`juiz model=${result.model} ms=${Date.now() - started} candidatos=0 tokens_in=${result.usage.input_tokens ?? "?"}`);
      return { belongs: 0, choice: {}, ...scopeResult };
    }
    const parsed = answersSchema.safeParse(result.answers);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    const { probabilities } = parsed.data.branch;
    const choiceById: Record<string, number> = {};
    for (const { label, id } of labelled) {
      const p = probabilities[label];
      if (p === undefined) throw new AssistantUnavailableError("invalid_output");
      choiceById[id] = p;
    }
    if (Object.keys(probabilities).length !== labelled.length) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(
      `juiz model=${result.model} ms=${Date.now() - started} candidatos=${labelled.length} tokens_in=${result.usage.input_tokens ?? "?"}`,
    );
    return { belongs: parsed.data.belongs.noul, choice: choiceById, ...scopeResult };
  }
}

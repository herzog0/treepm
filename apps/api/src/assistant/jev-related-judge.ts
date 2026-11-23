import { Logger } from "@nestjs/common";
import { noul } from "@typesafe-ai/sdk";
import { z } from "zod";
import { estimateTokens } from "./jev-branch-judge.js";
import type { SystemOneCall } from "./jev-branch-judge.js";
import { AssistantUnavailableError } from "./ports.js";
import type { RelatedInput, RelatedJudge, RelatedJudgment } from "./ports.js";
import {
  JEV_MODEL,
  JEV_RELATED_REQUEST_FALSE,
  JEV_RELATED_REQUEST_QUESTION,
  JEV_RELATED_REQUEST_TRUE,
  JEV_RELATED_SUBJECT_FALSE,
  JEV_RELATED_SUBJECT_QUESTION,
  JEV_RELATED_SUBJECT_TRUE,
} from "./prompts.js";

/** Mesmo orçamento da afinidade: o Jev limita a requisição a 64 mil tokens e a contagem é estimada, então sobra margem. */
export const RELATED_TOKEN_BUDGET = 56_000;
const ATTEMPT_TIMEOUT_MS = 20_000;

/** A chamada ao SDK, em uma função: é o que os testes substituem. */
export type RelatedCall = SystemOneCall;

/** Cada candidato vira duas perguntas, `subject_<n>` e `request_<n>`; é por essa chave que o código liga a resposta ao ticket. */
export function buildRelatedRequest(input: RelatedInput) {
  const labelled = input.candidates.map((candidate, index) => ({ n: index + 1, id: candidate.id, candidate }));
  const ticketOf = ({ title, excerpt }: { title: string; excerpt: string }): Record<string, string> => (excerpt === "" ? { title } : { title, description: excerpt });
  const questions = Object.fromEntries(
    labelled.flatMap(({ n, candidate }) => [
      [`subject_${n}`, noul({ question: JEV_RELATED_SUBJECT_QUESTION, ticket: ticketOf(candidate) }, { true: JEV_RELATED_SUBJECT_TRUE, false: JEV_RELATED_SUBJECT_FALSE })],
      [`request_${n}`, noul({ question: JEV_RELATED_REQUEST_QUESTION, ticket: ticketOf(candidate) }, { true: JEV_RELATED_REQUEST_TRUE, false: JEV_RELATED_REQUEST_FALSE })],
    ]),
  );
  const state = { draft: { title: input.draft.title, description: input.draft.description } };
  return { request: { model: JEV_MODEL, state, questions }, labelled };
}

/** A requisição inteira cabe no orçamento? Senão quem chama corta os candidatos de menor pontuação. */
export function relatedInputFits(input: RelatedInput): boolean {
  return estimateTokens(JSON.stringify(buildRelatedRequest(input).request)) <= RELATED_TOKEN_BUDGET;
}

const noulSchema = z.object({ noul: z.number().min(0).max(1) });

/** Adaptador do Jev para os tickets relacionados (ADR 0052). Nunca registra o texto enviado nem o recebido. */
export class JevRelatedJudge implements RelatedJudge {
  private readonly logger = new Logger("JevRelatedJudge");

  constructor(private readonly call: RelatedCall) {}

  async judge(input: RelatedInput, options: { signal?: AbortSignal } = {}): Promise<Record<string, RelatedJudgment>> {
    if (input.candidates.length === 0) return {};
    const started = Date.now();
    const { request, labelled } = buildRelatedRequest(input);
    let result: Awaited<ReturnType<RelatedCall>>;
    try {
      result = await this.call(request as Parameters<RelatedCall>[0], {
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: ATTEMPT_TIMEOUT_MS,
      });
    } catch (error) {
      // Só a classe do erro vai para o log: a mensagem pode carregar texto do usuário.
      this.logger.warn(`falha do provedor tipo=${error instanceof Error ? error.constructor.name : typeof error}`);
      throw new AssistantUnavailableError("provider_error");
    }
    const parsed = z
      .object(Object.fromEntries(labelled.flatMap(({ n }) => [[`subject_${n}`, noulSchema], [`request_${n}`, noulSchema]])))
      .safeParse(result.answers);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`relacionados model=${result.model} ms=${Date.now() - started} candidatos=${labelled.length} tokens_in=${result.usage.input_tokens ?? "?"}`);
    const answers = parsed.data as Record<string, { noul: number }>;
    return Object.fromEntries(
      labelled.map(({ n, id }) => [id, { sameSubject: answers[`subject_${n}`]?.noul ?? 0, sameRequest: answers[`request_${n}`]?.noul ?? 0 }]),
    );
  }
}

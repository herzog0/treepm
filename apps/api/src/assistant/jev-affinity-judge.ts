import { Logger } from "@nestjs/common";
import { noul } from "@typesafe-ai/sdk";
import { z } from "zod";
import { estimateTokens } from "./jev-branch-judge.js";
import type { SystemOneCall } from "./jev-branch-judge.js";
import { AssistantUnavailableError } from "./ports.js";
import type { AffinityInput, AffinityJudge } from "./ports.js";
import { JEV_AFFINITY_FALSE, JEV_AFFINITY_QUESTION, JEV_AFFINITY_TRUE, JEV_MODEL } from "./prompts.js";

/** O Jev limita a requisição a 64 mil tokens (e a 32 mil por pergunta com o estado); a contagem é estimada, então sobra margem. */
export const AFFINITY_TOKEN_BUDGET = 56_000;
const ATTEMPT_TIMEOUT_MS = 20_000;

/** A chamada ao SDK, em uma função: é o que os testes substituem. */
export type AffinityCall = SystemOneCall;

/** Cada ticket solto vira uma pergunta de chave `ticket_<n>`; é por essa chave que o código liga a resposta ao ticket. */
export function buildAffinityRequest(input: AffinityInput) {
  const labelled = input.tickets.map((ticket, index) => ({ key: `ticket_${index + 1}`, id: ticket.id, ticket }));
  const state = {
    draft: { title: input.draft.title, description: input.draft.description },
    destination: input.destination.summary === undefined ? { title: input.destination.title } : { title: input.destination.title, summary: input.destination.summary },
  };
  const questions = Object.fromEntries(
    labelled.map(({ key, ticket }) => [
      key,
      noul(
        {
          question: JEV_AFFINITY_QUESTION,
          ticket: ticket.descriptionExcerpt === "" ? { title: ticket.title } : { title: ticket.title, description: ticket.descriptionExcerpt },
        },
        { true: JEV_AFFINITY_TRUE, false: JEV_AFFINITY_FALSE },
      ),
    ]),
  );
  return { request: { model: JEV_MODEL, state, questions }, labelled };
}

/** A requisição inteira cabe no orçamento? Senão a verificação não é feita. */
export function affinityInputFits(input: AffinityInput): boolean {
  return estimateTokens(JSON.stringify(buildAffinityRequest(input).request)) <= AFFINITY_TOKEN_BUDGET;
}

const noulSchema = z.object({ noul: z.number().min(0).max(1) });

/** Adaptador do Jev para a afinidade entre o rascunho e os tickets soltos (ADR 0031). Nunca registra o texto enviado nem o recebido. */
export class JevAffinityJudge implements AffinityJudge {
  private readonly logger = new Logger("JevAffinityJudge");

  constructor(private readonly call: AffinityCall) {}

  async judge(input: AffinityInput, options: { signal?: AbortSignal } = {}): Promise<Record<string, number>> {
    const started = Date.now();
    const { request, labelled } = buildAffinityRequest(input);
    let result: Awaited<ReturnType<AffinityCall>>;
    try {
      result = await this.call(request as Parameters<AffinityCall>[0], {
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: ATTEMPT_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn(`falha do provedor tipo=${error instanceof Error ? error.constructor.name : typeof error}`);
      throw new AssistantUnavailableError("provider_error");
    }
    const parsed = z.object(Object.fromEntries(labelled.map(({ key }) => [key, noulSchema]))).safeParse(result.answers);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`afinidade model=${result.model} ms=${Date.now() - started} tickets=${labelled.length} tokens_in=${result.usage.input_tokens ?? "?"}`);
    return Object.fromEntries(labelled.map(({ key, id }) => [id, parsed.data[key]?.noul ?? 0]));
  }
}

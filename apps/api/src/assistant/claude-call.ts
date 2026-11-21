import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "@nestjs/common";
import { AssistantUnavailableError } from "./ports.js";

/** Peças comuns dos adaptadores do Claude (conversa e resumo de ramo): modelo, alternativa e a chamada com prazo. */
export const CLAUDE_MODEL = "claude-opus-5-5";
export const MAX_TOKENS = 16000;
/** Recurso de alternativa em recusa: o servidor escolhe o modelo de reserva (o `"default"` da skill). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
export type FinalMessage = {
  stop_reason: string | null;
  parsed_output: unknown;
  model: string;
  /** Consumo que a API devolve; só a ferramenta de medição o lê. */
  usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
};

/** A chamada ao SDK, em uma função: é o que os testes substituem. `finalMessage` espera o fim do streaming. */
export type ClaudeStreamer = (params: StreamParams, options: { signal: AbortSignal }) => Promise<FinalMessage>;

/** Liga o `ClaudeStreamer` ao SDK real: streaming com `finalMessage` (evita o limite de tempo de respostas longas). */
export function sdkStreamer(client: Anthropic): ClaudeStreamer {
  return (params, options) =>
    client.beta.messages.stream(params, { ...options, maxRetries: 0 }).finalMessage() as Promise<FinalMessage>;
}

/** Chama o Claude com prazo. Qualquer falha vira `AssistantUnavailableError`; só a classe do erro vai para o log. */
export async function callClaude(
  stream: ClaudeStreamer,
  params: StreamParams,
  timeoutMs: number,
  logger: Logger,
): Promise<FinalMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new AssistantUnavailableError("timeout")));
    });
    return await Promise.race([stream(params, { signal: controller.signal }), aborted]);
  } catch (error) {
    if (error instanceof AssistantUnavailableError) throw error;
    logger.warn(`falha do provedor tipo=${error instanceof Error ? error.constructor.name : typeof error}`);
    throw new AssistantUnavailableError("provider_error");
  } finally {
    clearTimeout(timer);
  }
}

/** Recusa e fim por limite não são respostas: o chamador cai no caminho manual (ADR 0029). */
export function requireEndTurn(final: FinalMessage): void {
  if (final.stop_reason !== "end_turn") throw new AssistantUnavailableError(`stop_reason=${final.stop_reason}`);
}

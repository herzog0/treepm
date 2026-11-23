import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "@nestjs/common";
import { AssistantUnavailableError } from "./ports.js";

/** Peças comuns dos adaptadores do Claude (conversa e resumo de ramo): modelo, alternativa e a chamada com prazo. */
export const CLAUDE_MODEL = "claude-opus-5-5";
export const MAX_TOKENS = 16000;
/** Recurso de alternativa em recusa: o servidor escolhe o modelo de reserva (o `"default"` da skill). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
/** Bloco de conteúdo de uma resposta: só o que o laço de ferramentas lê; os demais (raciocínio etc.) voltam como vieram. */
export type ClaudeContentBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };
export type FinalMessage = {
  stop_reason: string | null;
  /** Conteúdo da resposta; só o laço de ferramentas o lê (as saídas estruturadas usam `parsed_output`). */
  content?: readonly ClaudeContentBlock[];
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
  /** Sinal de quem chamou: abortá-lo cancela a requisição ao provedor e rejeita logo (como o prazo). */
  outer?: AbortSignal,
): Promise<FinalMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuter = () => controller.abort();
  outer?.addEventListener("abort", onOuter);
  try {
    if (outer?.aborted) throw new AssistantUnavailableError("timeout");
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
    outer?.removeEventListener("abort", onOuter);
  }
}

/** Recusa e fim por limite não são respostas: o chamador cai no caminho manual (ADR 0029). */
export function requireEndTurn(final: FinalMessage): void {
  if (final.stop_reason !== "end_turn") throw new AssistantUnavailableError(`stop_reason=${final.stop_reason}`);
}

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ConversationProvider, ConversationTurn, ConversationTurnInput } from "./ports.js";
import { SYSTEM_PROMPT, draftBlock } from "./prompts.js";

export const CONVERSATION_MODEL = "claude-opus-5-5";
/** Opus 5.5 não aceita desligar o raciocínio; o esforço padrão é `medium` e deve ser informado. */
const EFFORT = "medium";
const MAX_TOKENS = 16000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Recurso de alternativa em recusa: o servidor escolhe o modelo de reserva (o `"default"` da skill). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MAX_ASSISTANT_MESSAGE = 8000;

/** Formato que o modelo é obrigado a seguir. Sem limites aqui: estes são conferidos depois, com `turnLimits`. */
const turnFormat = z.object({
  message: z.string().describe("O que você diz à pessoa."),
  draft: z
    .object({ title: z.string(), description: z.string() })
    .nullable()
    .describe("Rascunho completo do ticket, ou null se ainda não houver o que propor."),
  ready: z.boolean().describe("O rascunho está bom para procurar o lugar do ticket na árvore."),
});

/** Limites do ticket (ADR 0024) e da mensagem: saída fora deles é tratada como falha, nunca cortada. */
const turnLimits = z.object({
  message: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE),
  draft: z.object({ title: ticketTitleSchema, description: ticketDescriptionSchema }).nullable(),
  ready: z.boolean(),
});

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type FinalMessage = { stop_reason: string | null; parsed_output: unknown; model: string };

/** A chamada ao SDK, em uma função: é o que os testes substituem. `finalMessage` espera o fim do streaming. */
export type ClaudeStreamer = (params: StreamParams, options: { signal: AbortSignal }) => Promise<FinalMessage>;

/** Liga o `ClaudeStreamer` ao SDK real: streaming com `finalMessage` (evita o limite de tempo de respostas longas). */
export function sdkStreamer(client: Anthropic): ClaudeStreamer {
  return (params, options) =>
    client.beta.messages.stream(params, { ...options, maxRetries: 0 }).finalMessage() as Promise<FinalMessage>;
}

/** Adaptador do turno de conversa no Claude Opus 5.5 (ADR 0029). Nunca registra texto enviado ou recebido. */
export class ClaudeConversationProvider implements ConversationProvider {
  private readonly logger = new Logger("ClaudeConversation");
  readonly timeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async turn(input: ConversationTurnInput): Promise<ConversationTurn> {
    const started = Date.now();
    const final = await this.call(this.params(input));
    const turn = this.read(final);
    this.logger.log(`turno model=${turn.model} ms=${Date.now() - started} draft=${turn.draft ? "sim" : "não"} ready=${turn.ready}`);
    return turn;
  }

  private params(input: ConversationTurnInput): StreamParams {
    const lastPerson = input.history.map((message) => message.author).lastIndexOf("person");
    const messages: Anthropic.Beta.BetaMessageParam[] = input.history.map((message, index) =>
      message.author === "assistant"
        ? { role: "assistant", content: message.body }
        : index === lastPerson
          ? {
              role: "user",
              content: [
                { type: "text", text: draftBlock(input.draft) },
                { type: "text", text: message.body },
              ],
            }
          : { role: "user", content: message.body },
    );
    return {
      model: CONVERSATION_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(turnFormat) },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages,
    };
  }

  private async call(params: StreamParams): Promise<FinalMessage> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new AssistantUnavailableError("timeout")));
      });
      return await Promise.race([this.stream(params, { signal: controller.signal }), aborted]);
    } catch (error) {
      if (error instanceof AssistantUnavailableError) throw error;
      // Só a classe do erro vai para o log: a mensagem pode carregar texto do usuário ou do modelo.
      this.logger.warn(`falha do provedor tipo=${error instanceof Error ? error.constructor.name : typeof error}`);
      throw new AssistantUnavailableError("provider_error");
    } finally {
      clearTimeout(timer);
    }
  }

  private read(final: FinalMessage): ConversationTurn {
    // Recusa e fim por limite não são respostas: o chamador cai na criação manual (ADR 0029).
    if (final.stop_reason !== "end_turn") throw new AssistantUnavailableError(`stop_reason=${final.stop_reason}`);
    const parsed = turnLimits.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    const { message, draft, ready } = parsed.data;
    return { message, draft, ready: draft !== null && ready, model: final.model };
  }
}

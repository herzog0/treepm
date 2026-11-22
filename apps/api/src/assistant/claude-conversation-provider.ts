import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { AssistantUnavailableError, MAX_DRAFT_CHILDREN } from "./ports.js";
import { ticketDescriptionSchema, ticketTitleSchema } from "../tickets/tickets.schema.js";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, FinalMessage, StreamParams } from "./claude-call.js";
import type { ConversationProvider, ConversationTurn, ConversationTurnInput } from "./ports.js";
import { SYSTEM_PROMPT, draftBlock, groupsBlock } from "./prompts.js";

export { sdkStreamer } from "./claude-call.js";
export type { ClaudeStreamer } from "./claude-call.js";

export const CONVERSATION_MODEL = CLAUDE_MODEL;
/** Opus 5.5 não aceita desligar o raciocínio; o esforço padrão é `medium` e deve ser informado. */
const EFFORT = "medium";
const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_ASSISTANT_MESSAGE = 8000;

/** Formato que o modelo é obrigado a seguir. Sem limites aqui: estes são conferidos depois, com `turnLimits`. */
const turnFormat = z.object({
  message: z.string().describe("O que você diz à pessoa."),
  draft: z
    .object({
      title: z.string(),
      description: z.string(),
      children: z
        .array(z.object({ title: z.string(), description: z.string() }))
        .describe("Os filhos do ticket, na ordem; lista vazia quando o rascunho é um ticket só. Filhos não têm filhos."),
    })
    .nullable()
    .describe("Rascunho completo do ticket (com os filhos, se houver), ou null se ainda não houver o que propor."),
  ready: z.boolean().describe("O rascunho está bom para procurar o lugar do ticket na árvore."),
});

/** Limites do ticket (ADR 0024), de até 20 filhos (ADR 0044) e da mensagem: saída fora deles é tratada como falha, nunca cortada. */
const turnLimits = z.object({
  message: z.string().trim().min(1).max(MAX_ASSISTANT_MESSAGE),
  draft: z
    .object({
      title: ticketTitleSchema,
      description: ticketDescriptionSchema,
      children: z.array(z.object({ title: ticketTitleSchema, description: ticketDescriptionSchema })).max(MAX_DRAFT_CHILDREN).default([]),
    })
    .nullable(),
  ready: z.boolean(),
});

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
    const final = await callClaude(this.stream, this.params(input), this.timeoutMs, this.logger);
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
                { type: "text", text: groupsBlock(input.groups) },
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

  private read(final: FinalMessage): ConversationTurn {
    requireEndTurn(final);
    const parsed = turnLimits.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    const { message, draft, ready } = parsed.data;
    return { message, draft, ready: draft !== null && ready, model: final.model };
  }
}

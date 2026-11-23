import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { hasForbiddenChatChars } from "@treepm/domain";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ChatProvider, ChatTurnInput } from "./ports.js";
import { CHAT_SYSTEM_PROMPT, chatContextBlock } from "./prompts.js";

const EFFORT = "medium";
const DEFAULT_TIMEOUT_MS = 60_000;
/** O teto da resposta do assistente; o banco confere o mesmo (8.000). Maior que isso é falha, nunca é cortado. */
export const MAX_CHAT_REPLY = 8000;

const replyFormat = z.object({ message: z.string().describe("O que você diz à pessoa.") });
const replyLimits = z.object({ message: z.string().trim().min(1).max(MAX_CHAT_REPLY).refine((m) => !hasForbiddenChatChars(m)) });

/** Adaptador do chat de trabalho no Claude Opus 5.5 (ADR 0049). Sem ferramentas. Nunca registra texto enviado ou recebido. */
export class ClaudeChatProvider implements ChatProvider {
  private readonly logger = new Logger("ClaudeChat");
  private readonly timeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async reply(input: ChatTurnInput): Promise<{ message: string; model: string }> {
    const started = Date.now();
    const final = await callClaude(this.stream, this.params(input), this.timeoutMs, this.logger);
    requireEndTurn(final);
    const parsed = replyLimits.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`chat model=${final.model} ms=${Date.now() - started} chars=${parsed.data.message.length}`);
    return { message: parsed.data.message, model: final.model };
  }

  private params(input: ChatTurnInput): StreamParams {
    const last = input.history.length - 1;
    const messages: Anthropic.Beta.BetaMessageParam[] = input.history.map((turn, index) =>
      turn.author === "assistant"
        ? { role: "assistant", content: turn.body }
        : index === last
          ? { role: "user", content: [{ type: "text", text: chatContextBlock(input.ticket) }, { type: "text", text: turn.body }] }
          : { role: "user", content: turn.body },
    );
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(replyFormat) },
      system: [{ type: "text", text: CHAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages,
    };
  }
}

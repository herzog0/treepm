import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { CHAT_TITLE_MAX, chatTitleOf, hasForbiddenChatChars } from "@treepm/domain";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { chatToolDefinitions } from "./chat-tools.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ChatProvider, ChatTurnInput } from "./ports.js";
import { CHAT_SYSTEM_PROMPT, chatContextBlock } from "./prompts.js";
import { DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOOL_ROUNDS, runToolLoop, toolsSummary } from "./tool-loop.js";
import type { LoopOptions } from "./tool-loop.js";

const EFFORT = "medium";
/** Prazo de cada chamada ao provedor; o prazo da vez inteira (todas as rodadas) é o total. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** O teto da resposta do assistente; o banco confere o mesmo (8.000). Maior que isso é falha, nunca é cortado. */
export const MAX_CHAT_REPLY = 8000;

const replyFormat = z.object({ message: z.string().describe("O que você diz à pessoa.") });
/** Na primeira resposta de uma thread de assunto, o mesmo objeto leva também o título. */
const replyWithTitleFormat = replyFormat.extend({
  title: z.string().describe(`Título curto do assunto desta conversa, na língua da pessoa: até ${CHAT_TITLE_MAX} caracteres, uma linha, sem ponto final.`),
});
const replyLimits = z.object({ message: z.string().trim().min(1).max(MAX_CHAT_REPLY).refine((m) => !hasForbiddenChatChars(m)) });

/**
 * Adaptador do chat no Claude Opus 5.5 (ADR 0049 e 0056). Com as ferramentas de leitura das conversas, pelo laço de `tool-loop.ts`;
 * a resposta final é `{message}`, e `{message, title}` na primeira resposta de uma thread de assunto. Nunca registra texto enviado ou recebido.
 */
export class ClaudeChatProvider implements ChatProvider {
  private readonly logger = new Logger("ClaudeChat");
  private readonly options: Required<LoopOptions>;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: LoopOptions = {},
  ) {
    this.options = { timeoutMs: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS, maxToolRounds: options.maxToolRounds ?? MAX_TOOL_ROUNDS };
  }

  async reply(input: ChatTurnInput): Promise<{ message: string; model: string; title?: string | null }> {
    const outcome = await runToolLoop({
      stream: this.stream,
      logger: this.logger,
      tools: input.tools,
      messages: this.messages(input),
      params: (messages, closing) => this.params(messages, closing, input.wantTitle),
      options: this.options,
    });
    const parsed = replyLimits.safeParse(outcome.final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`chat model=${outcome.final.model} ms=${outcome.ms} rounds=${outcome.rounds} executions=${outcome.executions} tools=${toolsSummary(outcome.perTool)} chars=${parsed.data.message.length}`);
    // O título é um extra: inválido ou ausente, a resposta vale e a thread fica sem título (quem grava confere de novo).
    const title = input.wantTitle ? chatTitleOf((outcome.final.parsed_output as { title?: unknown } | null | undefined)?.title) : null;
    return { message: parsed.data.message, model: outcome.final.model, ...(title !== null ? { title } : {}) };
  }

  private messages(input: ChatTurnInput): Anthropic.Beta.BetaMessageParam[] {
    const last = input.history.length - 1;
    return input.history.map((turn, index) =>
      turn.author === "assistant"
        ? { role: "assistant", content: turn.body }
        : index === last
          ? { role: "user", content: [{ type: "text", text: chatContextBlock(input.ticket, input.projects) }, { type: "text", text: turn.body }] }
          : { role: "user", content: turn.body },
    );
  }

  private params(messages: Anthropic.Beta.BetaMessageParam[], closing: boolean, wantTitle: boolean): StreamParams {
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(wantTitle ? replyWithTitleFormat : replyFormat) },
      system: [{ type: "text", text: CHAT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: chatToolDefinitions(),
      // Sem ferramentas na última chamada: a lista fica (a API a exige com tool_result no histórico), mas é proibida.
      ...(closing ? { tool_choice: { type: "none" as const } } : {}),
      messages,
    } as StreamParams;
  }
}

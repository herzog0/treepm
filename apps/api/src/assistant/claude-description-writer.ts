import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { DescriptionDraftInput, DescriptionWriter } from "./ports.js";
import { DESCRIPTION_MAX_CHARS, DESCRIPTION_SYSTEM_PROMPT, descriptionUserContent } from "./prompts.js";

const EFFORT = "low";
const DEFAULT_TIMEOUT_MS = 30_000;

const textFormat = z.object({ text: z.string().describe("O trecho da descrição, em markdown.") });
/** O limite da rota: texto maior é falha, nunca é cortado em silêncio. */
const textLimits = z.object({ text: z.string().trim().min(1).max(DESCRIPTION_MAX_CHARS) });

/** Adaptador do texto para a descrição, no Claude Opus 5.5 (ADR 0036). Nunca registra texto enviado ou recebido. */
export class ClaudeDescriptionWriter implements DescriptionWriter {
  private readonly logger = new Logger("ClaudeDescriptionWriter");
  private readonly timeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async write(input: DescriptionDraftInput): Promise<{ text: string; model: string }> {
    const started = Date.now();
    const final = await callClaude(this.stream, this.params(input), this.timeoutMs, this.logger);
    requireEndTurn(final);
    const parsed = textLimits.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`descricao model=${final.model} ms=${Date.now() - started} chars=${parsed.data.text.length}`);
    return { text: parsed.data.text, model: final.model };
  }

  private params(input: DescriptionDraftInput): StreamParams {
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(textFormat) },
      system: [{ type: "text", text: DESCRIPTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: descriptionUserContent(input) }],
    };
  }
}

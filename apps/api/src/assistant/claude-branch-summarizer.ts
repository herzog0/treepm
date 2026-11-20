import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { BranchSummarizer, BranchSummaryInput } from "./ports.js";
import { SUMMARY_SYSTEM_PROMPT, summaryUserContent } from "./prompts.js";

/** Esforço `low`: resumo curto de um ramo não pede raciocínio profundo (ADR 0029). */
const EFFORT = "low";
const DEFAULT_TIMEOUT_MS = 25_000;
export const MAX_SUMMARY_CHARS = 600;

const summaryFormat = z.object({ summary: z.string().describe("O que o ramo cobre, em texto simples.") });
/** O limite do banco: resumo maior é falha, nunca é cortado em silêncio. */
const summaryLimits = z.object({ summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS) });

/** Adaptador do resumo de ramo no Claude Opus 5.5 (ADR 0029). Nunca registra texto enviado ou recebido. */
export class ClaudeBranchSummarizer implements BranchSummarizer {
  private readonly logger = new Logger("ClaudeBranchSummarizer");
  private readonly timeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async summarize(input: BranchSummaryInput): Promise<{ summary: string; model: string }> {
    const started = Date.now();
    const final = await callClaude(this.stream, this.params(input), this.timeoutMs, this.logger);
    requireEndTurn(final);
    const parsed = summaryLimits.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`resumo model=${final.model} ms=${Date.now() - started}`);
    return { summary: parsed.data.summary, model: final.model };
  }

  private params(input: BranchSummaryInput): StreamParams {
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(summaryFormat) },
      system: [{ type: "text", text: SUMMARY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: summaryUserContent(input) }],
    };
  }
}

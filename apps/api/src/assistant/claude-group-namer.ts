import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { GroupNameInput, GroupNamer } from "./ports.js";
import { GROUP_NAME_SYSTEM_PROMPT, groupNameUserContent } from "./prompts.js";

const EFFORT = "low";
const DEFAULT_TIMEOUT_MS = 20_000;

const nameFormat = z.object({
  title: z.string().describe("Título do agrupador."),
  description: z.string().describe("Descrição do agrupador."),
});

/** Adaptador do nome do agrupador proposto, no Claude Opus 5.5 (ADR 0031). Nunca registra texto enviado ou recebido. */
export class ClaudeGroupNamer implements GroupNamer {
  private readonly logger = new Logger("ClaudeGroupNamer");
  private readonly timeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async name(input: GroupNameInput): Promise<{ title: string; description: string; model: string }> {
    const started = Date.now();
    const final = await callClaude(this.stream, this.params(input), this.timeoutMs, this.logger);
    requireEndTurn(final);
    const parsed = nameFormat.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`nome model=${final.model} ms=${Date.now() - started}`);
    return { ...parsed.data, model: final.model };
  }

  private params(input: GroupNameInput): StreamParams {
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(nameFormat) },
      system: [{ type: "text", text: GROUP_NAME_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: groupNameUserContent(input) }],
    };
  }
}

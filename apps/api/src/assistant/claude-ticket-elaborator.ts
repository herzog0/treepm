import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ElaborationInput, ElaborationResult, TicketElaborator } from "./ports.js";
import { ELABORATION_SYSTEM_PROMPT, elaborationUserContent } from "./prompts.js";

const EFFORT = "low";
/** Prazo da chamada auxiliar (ADR 0052): a criação do ticket nunca espera por ela. */
export const ELABORATION_TIMEOUT_MS = 20_000;

const elaborationFormat = z.object({
  links: z.array(
    z.object({
      de: z.union([z.literal("pai"), z.number().int()]).describe('"pai" ou o índice, a partir de 0, da parte que depende.'),
      dependeDe: z.string().describe("A chave de um ticket da lista recebida."),
      motivo: z.string().describe("Uma frase dizendo por que há a dependência."),
    }),
  ),
  suggested: z.array(
    z.object({
      title: z.string().describe("Título da tarefa sugerida."),
      description: z.string().describe("Descrição da tarefa sugerida."),
      motivo: z.string().describe("Uma frase dizendo por que o pedido precisa dela."),
    }),
  ),
});

/** Adaptador da elaboração, no Claude Opus 5.5 (ADR 0052). Nunca registra texto enviado ou recebido. */
export class ClaudeTicketElaborator implements TicketElaborator {
  private readonly logger = new Logger("ClaudeTicketElaborator");
  private readonly timeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? ELABORATION_TIMEOUT_MS;
  }

  async elaborate(input: ElaborationInput, options: { signal?: AbortSignal } = {}): Promise<ElaborationResult> {
    const started = Date.now();
    const final = await callClaude(this.stream, this.params(input), this.timeoutMs, this.logger, options.signal);
    requireEndTurn(final);
    const parsed = elaborationFormat.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`elaboracao model=${final.model} ms=${Date.now() - started} ligacoes=${parsed.data.links.length} sugeridas=${parsed.data.suggested.length}`);
    return { ...parsed.data, model: final.model };
  }

  private params(input: ElaborationInput): StreamParams {
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT, format: zodOutputFormat(elaborationFormat) },
      system: [{ type: "text", text: ELABORATION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: elaborationUserContent(input) }],
    };
  }
}

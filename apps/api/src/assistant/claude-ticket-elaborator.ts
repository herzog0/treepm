import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude, requireEndTurn } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ElaborationInput, ElaborationResult, ExistingMatchInput, ExistingMatchResult, TicketElaborator } from "./ports.js";
import { ELABORATION_SYSTEM_PROMPT, EXISTING_MATCH_SYSTEM_PROMPT, elaborationUserContent, existingMatchUserContent } from "./prompts.js";

const EFFORT = "low";
/** Prazo da chamada auxiliar (ADR 0052): a criação do ticket nunca espera por ela. */
export const ELABORATION_TIMEOUT_MS = 20_000;

/** Prazo da segunda chamada (a tarefa sugerida já existe?); a rota ainda o limita ao que sobrou do prazo da elaboração. */
export const EXISTING_MATCH_TIMEOUT_MS = 8_000;

const matchFormat = z.object({
  matches: z.array(
    z.object({
      index: z.number().int().describe("O índice da tarefa sugerida, como recebido."),
      existing: z.string().nullable().describe("A chave de um ticket da lista DAQUELA tarefa que já entrega o que ela precisa, ou null."),
    }),
  ),
});

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
  private readonly matchTimeoutMs: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    options: { timeoutMs?: number; matchTimeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? ELABORATION_TIMEOUT_MS;
    this.matchTimeoutMs = options.matchTimeoutMs ?? EXISTING_MATCH_TIMEOUT_MS;
  }

  async matchExisting(input: ExistingMatchInput, options: { signal?: AbortSignal } = {}): Promise<ExistingMatchResult> {
    const started = Date.now();
    const final = await callClaude(
      this.stream,
      {
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: EFFORT, format: zodOutputFormat(matchFormat) },
        system: [{ type: "text", text: EXISTING_MATCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: existingMatchUserContent(input) }],
      },
      this.matchTimeoutMs,
      this.logger,
      options.signal,
    );
    requireEndTurn(final);
    const parsed = matchFormat.safeParse(final.parsed_output);
    if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`elaboracao-existente model=${final.model} ms=${Date.now() - started} sugeridas=${input.tasks.length} apontadas=${parsed.data.matches.filter((m) => m.existing !== null).length}`);
    return { answers: parsed.data.matches, model: final.model };
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

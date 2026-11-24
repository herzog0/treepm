import { Logger } from "@nestjs/common";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS } from "./claude-call.js";
import type { ClaudeStreamer, StreamParams } from "./claude-call.js";
import { askToolDefinitions } from "./ask-tools.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ProjectAnswerInput, ProjectAnswerer } from "./ports.js";
import { ASK_MAX_CHARS, ASK_SYSTEM_PROMPT } from "./prompts.js";
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOOL_ROUNDS, runToolLoop, toolsSummary } from "./tool-loop.js";
import type { LoopMessage, LoopOptions } from "./tool-loop.js";

export { MAX_TOOL_EXECUTIONS, MAX_TOOL_ROUNDS } from "./tool-loop.js";

const EFFORT = "medium";

/**
 * Adaptador da pergunta sobre o projeto, no Claude Opus 5.5 (ADR 0037): o laço de ferramentas é o de `tool-loop.ts`. Não conhece o
 * banco: as ferramentas são executadas por quem o chamou. Só registra modelo, tempo, rodadas, execuções e tamanho.
 */
export class ClaudeProjectAnswerer implements ProjectAnswerer {
  private readonly logger = new Logger("ClaudeProjectAnswerer");
  private readonly options: Required<LoopOptions>;

  constructor(
    private readonly stream: ClaudeStreamer,
    /** `maxToolRounds` só existe para a verificação com o provedor exercitar a última chamada, sem ferramentas; o padrão é `MAX_TOOL_ROUNDS`. */
    options: LoopOptions = {},
  ) {
    this.options = { timeoutMs: options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS, maxToolRounds: options.maxToolRounds ?? MAX_TOOL_ROUNDS };
  }

  async answer(input: ProjectAnswerInput): Promise<{ text: string; model: string }> {
    const outcome = await runToolLoop({
      stream: this.stream,
      logger: this.logger,
      tools: input.tools,
      messages: conversation(input),
      params: (messages, closing) => this.params(messages, closing),
      options: this.options,
    });
    const text = (outcome.final.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim();
    // Resposta vazia ou acima do limite é falha, nunca é cortada em silêncio.
    if (text.length < 1 || text.length > ASK_MAX_CHARS) throw new AssistantUnavailableError("invalid_output");
    this.logger.log(`pergunta model=${outcome.final.model} ms=${outcome.ms} rounds=${outcome.rounds} executions=${outcome.executions} tools=${toolsSummary(outcome.perTool)} chars=${text.length}`);
    return { text, model: outcome.final.model };
  }

  private params(messages: LoopMessage[], closing: boolean): StreamParams {
    return {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: EFFORT },
      system: [{ type: "text", text: ASK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: askToolDefinitions(),
      // Sem ferramentas na última chamada: a lista fica (a API a exige com tool_result no histórico), mas é proibida.
      ...(closing ? { tool_choice: { type: "none" as const } } : {}),
      messages,
    } as StreamParams;
  }
}

/** A conversa da tela e a pergunta, em mensagens. Mensagens do assistente antes da primeira da pessoa são descartadas (a API pede que comece pela pessoa). */
function conversation(input: ProjectAnswerInput): LoopMessage[] {
  const turns = input.history.map((message): LoopMessage => ({ role: message.author === "person" ? "user" : "assistant", content: message.body }));
  const first = turns.findIndex((turn) => turn.role === "user");
  return [...(first < 0 ? [] : turns.slice(first)), { role: "user", content: input.question }];
}

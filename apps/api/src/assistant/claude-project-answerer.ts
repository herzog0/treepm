import { Logger } from "@nestjs/common";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude } from "./claude-call.js";
import type { ClaudeContentBlock, ClaudeStreamer, StreamParams } from "./claude-call.js";
import { askToolDefinitions } from "./ask-tools.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ProjectAnswerInput, ProjectAnswerer } from "./ports.js";
import { ASK_LIMIT_NOTICE, ASK_MAX_CHARS, ASK_SYSTEM_PROMPT } from "./prompts.js";

const EFFORT = "medium";
/** Prazo de cada chamada ao provedor (o mesmo dos outros adaptadores). */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_ROUNDS = 8;
export const MAX_TOOL_EXECUTIONS = 16;

type Message = StreamParams["messages"][number];
type ToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: true };

/**
 * Adaptador da pergunta sobre o projeto, no Claude Opus 5.5 (ADR 0037): o laço manual de ferramentas
 * (`stop_reason: "tool_use"` → executa → devolve os `tool_result` numa única mensagem da pessoa → repete). Não conhece o
 * banco: as ferramentas são executadas por quem o chamou. Só registra modelo, tempo, rodadas, execuções e tamanho.
 */
export class ClaudeProjectAnswerer implements ProjectAnswerer {
  private readonly logger = new Logger("ClaudeProjectAnswerer");
  private readonly callTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxToolRounds: number;

  constructor(
    private readonly stream: ClaudeStreamer,
    /** `maxToolRounds` só existe para a verificação com o provedor exercitar a última chamada, sem ferramentas; o padrão é `MAX_TOOL_ROUNDS`. */
    options: { timeoutMs?: number; totalTimeoutMs?: number; maxToolRounds?: number } = {},
  ) {
    this.maxToolRounds = options.maxToolRounds ?? MAX_TOOL_ROUNDS;
    this.callTimeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  }

  async answer(input: ProjectAnswerInput): Promise<{ text: string; model: string }> {
    const started = Date.now();
    const deadline = started + this.totalTimeoutMs;
    const messages = conversation(input);
    const perTool = new Map<string, number>();
    let rounds = 0;
    let executions = 0;

    for (;;) {
      const closing = rounds >= this.maxToolRounds || executions >= MAX_TOOL_EXECUTIONS;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AssistantUnavailableError("timeout");
      const final = await callClaude(this.stream, this.params(messages, closing), Math.min(this.callTimeoutMs, remaining), this.logger);
      const content = final.content ?? [];

      if (final.stop_reason === "end_turn") {
        const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim();
        // Resposta vazia ou acima do limite é falha, nunca é cortada em silêncio.
        if (text.length < 1 || text.length > ASK_MAX_CHARS) throw new AssistantUnavailableError("invalid_output");
        this.logger.log(
          `pergunta model=${final.model} ms=${Date.now() - started} rounds=${rounds} executions=${executions}` +
            ` tools=${[...perTool].map(([name, count]) => `${name}=${count}`).join(",") || "-"} chars=${text.length}`,
        );
        return { text, model: final.model };
      }
      if (final.stop_reason !== "tool_use") throw new AssistantUnavailableError(`stop_reason=${final.stop_reason}`);
      // Pediu ferramenta quando não podia: não há resposta.
      if (closing) throw new AssistantUnavailableError("tool_limit");

      const uses = content.filter((block): block is ClaudeContentBlock & { id: string; name: string } => block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string");
      if (uses.length === 0) throw new AssistantUnavailableError("stop_reason=tool_use");
      rounds += 1;
      const results: ToolResult[] = [];
      for (const use of uses) {
        if (executions >= MAX_TOOL_EXECUTIONS) {
          // Todo tool_use precisa de resposta; o excedente não é executado.
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Limite de consultas atingido: esta não foi executada.", is_error: true });
          continue;
        }
        executions += 1;
        perTool.set(use.name, (perTool.get(use.name) ?? 0) + 1);
        const outcome = await input.tools.execute(use.name, use.input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true as const } : {}) });
      }
      // O conteúdo da resposta volta como veio (inclui o raciocínio, que a API exige inalterado).
      messages.push({ role: "assistant", content: content as never });
      const willClose = rounds >= this.maxToolRounds || executions >= MAX_TOOL_EXECUTIONS;
      messages.push({ role: "user", content: willClose ? [...results, { type: "text", text: ASK_LIMIT_NOTICE }] : results });
    }
  }

  private params(messages: Message[], closing: boolean): StreamParams {
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
function conversation(input: ProjectAnswerInput): Message[] {
  const turns = input.history.map((message): Message => ({ role: message.author === "person" ? "user" : "assistant", content: message.body }));
  const first = turns.findIndex((turn) => turn.role === "user");
  return [...(first < 0 ? [] : turns.slice(first)), { role: "user", content: input.question }];
}

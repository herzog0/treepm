import type { Logger } from "@nestjs/common";
import { callClaude } from "./claude-call.js";
import type { ClaudeContentBlock, ClaudeStreamer, FinalMessage, StreamParams } from "./claude-call.js";
import { AssistantUnavailableError } from "./ports.js";
import type { ToolExecutor } from "./ports.js";
import { TOOL_LIMIT_NOTICE } from "./prompts.js";

/** Prazo de cada chamada ao provedor (o mesmo dos outros adaptadores), prazo total da vez e limites de rodadas e de consultas. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_ROUNDS = 8;
export const MAX_TOOL_EXECUTIONS = 16;

export type LoopMessage = StreamParams["messages"][number];
type ToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: true };

export type LoopOptions = { timeoutMs?: number; totalTimeoutMs?: number; maxToolRounds?: number };

export type LoopOutcome = { final: FinalMessage; rounds: number; executions: number; perTool: ReadonlyMap<string, number>; ms: number };

/**
 * O laço manual de ferramentas, do chat (ADR 0037 e 0056): `stop_reason: "tool_use"` → executa
 * → devolve os `tool_result` numa única mensagem da pessoa → repete. Ao atingir o limite de rodadas ou de consultas a última chamada
 * vai sem ferramenta e tem de responder. Devolve a mensagem final (`end_turn`); quem chamou valida o conteúdo dela. Não conhece o
 * banco (as ferramentas são de quem chamou) e não registra texto algum: nada do conteúdo vai para log.
 */
export async function runToolLoop(input: {
  stream: ClaudeStreamer;
  logger: Logger;
  tools: ToolExecutor;
  messages: LoopMessage[];
  params: (messages: LoopMessage[], closing: boolean) => StreamParams;
  options: Required<LoopOptions>;
}): Promise<LoopOutcome> {
  const { stream, logger, tools, messages, options } = input;
  const started = Date.now();
  const deadline = started + options.totalTimeoutMs;
  const perTool = new Map<string, number>();
  let rounds = 0;
  let executions = 0;

  for (;;) {
    const closing = rounds >= options.maxToolRounds || executions >= MAX_TOOL_EXECUTIONS;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AssistantUnavailableError("timeout");
    const final = await callClaude(stream, input.params(messages, closing), Math.min(options.timeoutMs, remaining), logger);
    const content = final.content ?? [];

    if (final.stop_reason === "end_turn") return { final, rounds, executions, perTool, ms: Date.now() - started };
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
      // O prazo total vale também entre as execuções, não só antes de cada chamada ao provedor.
      if (Date.now() >= deadline) throw new AssistantUnavailableError("timeout");
      executions += 1;
      perTool.set(use.name, (perTool.get(use.name) ?? 0) + 1);
      const outcome = await tools.execute(use.name, use.input);
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true as const } : {}) });
    }
    // O conteúdo da resposta volta como veio (inclui o raciocínio, que a API exige inalterado).
    messages.push({ role: "assistant", content: content as never });
    const willClose = rounds >= options.maxToolRounds || executions >= MAX_TOOL_EXECUTIONS;
    messages.push({ role: "user", content: willClose ? [...results, { type: "text", text: TOOL_LIMIT_NOTICE }] : results });
  }
}

export const toolsSummary = (perTool: ReadonlyMap<string, number>): string => [...perTool].map(([name, count]) => `${name}=${count}`).join(",") || "-";

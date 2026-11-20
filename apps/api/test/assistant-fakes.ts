import { AssistantUnavailableError } from "../src/assistant/ports.js";
import type {
  BranchJudge,
  BranchJudgment,
  BranchSummarizer,
  BranchSummaryInput,
  ConversationProvider,
  ConversationTurn,
  ConversationTurnInput,
} from "../src/assistant/ports.js";

/** Conversa falsa e determinística: registra as chamadas e responde sem rede. */
export class FakeConversationProvider implements ConversationProvider {
  readonly calls: ConversationTurnInput[] = [];
  /** Gancho executado durante a "chamada ao provedor" (por exemplo, para mudar o banco). */
  onCall: (() => Promise<void>) | null = null;
  /** Resposta do próximo turno; o padrão ecoa a última mensagem e propõe um rascunho. */
  reply: ((input: ConversationTurnInput) => ConversationTurn) | null = null;
  fail = false;

  async turn(input: ConversationTurnInput): Promise<ConversationTurn> {
    this.calls.push(structuredClone(input) as ConversationTurnInput);
    await this.onCall?.();
    if (this.fail) throw new AssistantUnavailableError("fake");
    if (this.reply) return this.reply(input);
    const persons = input.history.filter((m) => m.author === "person");
    const last = persons[persons.length - 1]?.body ?? "";
    return {
      message: `Entendi: ${last.slice(0, 40)}`,
      draft: { title: `Rascunho ${persons.length}`, description: persons.map((m) => m.body).join("\n") },
      ready: persons.length >= 2,
      model: "claude-opus-5-5",
    };
  }
}

type JudgeInput = Parameters<BranchJudge["judge"]>[0];

/** Juiz falso: por padrão pertence (0,95) e prefere o primeiro candidato (0,9); o escopo, quando perguntado, cabe (0,95). */
export class FakeBranchJudge implements BranchJudge {
  readonly calls: JudgeInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  verdict: ((input: JudgeInput) => BranchJudgment) | null = null;
  fail = false;
  async judge(input: JudgeInput): Promise<BranchJudgment> {
    this.calls.push(structuredClone(input) as JudgeInput);
    await this.onCall?.();
    if (this.fail) throw new AssistantUnavailableError("fake");
    if (this.verdict) return this.verdict(input);
    const scopeFit = input.scope ? { scopeFit: 0.95 } : {};
    const rest = input.candidates.length > 1 ? 0.1 / (input.candidates.length - 1) : 0;
    return {
      belongs: 0.95,
      choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, input.candidates.length === 1 ? 1 : i === 0 ? 0.9 : rest])),
      ...scopeFit,
    };
  }
}

/** Resumidor falso: `Resumo de <título>`; registra as chamadas e a concorrência máxima. */
export class FakeBranchSummarizer implements BranchSummarizer {
  readonly calls: BranchSummaryInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  delayMs = 0;
  fail = false;
  maxConcurrent = 0;
  private running = 0;
  async summarize(input: BranchSummaryInput): Promise<{ summary: string; model: string }> {
    this.calls.push(structuredClone(input) as BranchSummaryInput);
    this.running += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
    try {
      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      await this.onCall?.();
      if (this.fail) throw new AssistantUnavailableError("fake");
      return { summary: `Resumo de ${input.title}`, model: "fake-model" };
    } finally {
      this.running -= 1;
    }
  }
}

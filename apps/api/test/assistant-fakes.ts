import { AssistantUnavailableError } from "../src/assistant/ports.js";
import type {
  BranchJudge,
  BranchJudgment,
  BranchSummarizer,
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

/** Para a Parte 2: juiz e resumidor falsos, já declarados. */
export class FakeBranchJudge implements BranchJudge {
  answers: BranchJudgment[] = [];
  async judge(): Promise<BranchJudgment> {
    return this.answers.shift() ?? { belongs: 0, choice: {} };
  }
}

export class FakeBranchSummarizer implements BranchSummarizer {
  async summarize(input: { title: string }): Promise<{ summary: string; model: string }> {
    return { summary: `Resumo de ${input.title}`, model: "fake-model" };
  }
}

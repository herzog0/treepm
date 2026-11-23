import { AssistantUnavailableError } from "../src/assistant/ports.js";
import type {
  AffinityInput,
  AffinityJudge,
  BranchJudge,
  BranchJudgment,
  BranchSummarizer,
  BranchSummaryInput,
  ChatProvider,
  ChatTurnInput,
  ConversationProvider,
  ConversationTurn,
  ConversationTurnInput,
  DescriptionDraftInput,
  DescriptionWriter,
  ElaborationInput,
  ElaborationResult,
  GroupNameInput,
  GroupNamer,
  ProjectAnswerInput,
  ProjectAnswerer,
  RelatedInput,
  RelatedJudge,
  RelatedJudgment,
  TicketElaborator,
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

/** Afinidade falsa: por padrão ninguém passa (0,1 para todos), então nenhum teste antigo vê proposta. */
export class FakeAffinityJudge implements AffinityJudge {
  readonly calls: AffinityInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  /** Probabilidade por ticket; o padrão devolve 0,1 para todos. */
  verdict: ((input: AffinityInput) => Record<string, number>) | null = null;
  fail = false;
  /** Nunca responde (a chamada só termina pelo prazo de quem chama). */
  hang = false;
  async judge(input: AffinityInput): Promise<Record<string, number>> {
    this.calls.push(structuredClone(input) as AffinityInput);
    await this.onCall?.();
    if (this.hang) await new Promise<never>(() => undefined);
    if (this.fail) throw new AssistantUnavailableError("fake");
    if (this.verdict) return this.verdict(input);
    return Object.fromEntries(input.tickets.map((t) => [t.id, 0.1]));
  }
}

/** Relacionados falso: por padrão ninguém é relacionado (0 e 0), então nenhum teste antigo vê relacionado. */
export class FakeRelatedJudge implements RelatedJudge {
  readonly calls: RelatedInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  /** As duas probabilidades por id de ticket; o padrão devolve 0 e 0 para todos. */
  verdict: ((input: RelatedInput) => Record<string, RelatedJudgment>) | null = null;
  fail = false;
  hang = false;
  judgeHook: ((signal: AbortSignal | undefined) => void) | null = null;
  async judge(input: RelatedInput, options?: { signal?: AbortSignal }): Promise<Record<string, RelatedJudgment>> {
    this.calls.push(structuredClone(input) as RelatedInput);
    this.judgeHook?.(options?.signal);
    await this.onCall?.();
    if (this.hang) await new Promise<never>(() => undefined);
    if (this.fail) throw new AssistantUnavailableError("fake");
    if (this.verdict) return this.verdict(input);
    return Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: 0, sameRequest: 0 }]));
  }
}

/** Escritor de nome falso: título e descrição previsíveis, a menos que `reply` mande outra coisa. */
export class FakeGroupNamer implements GroupNamer {
  readonly calls: GroupNameInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  reply: ((input: GroupNameInput) => { title: string; description: string }) | null = null;
  fail = false;
  hang = false;
  async name(input: GroupNameInput): Promise<{ title: string; description: string; model: string }> {
    this.calls.push(structuredClone(input) as GroupNameInput);
    await this.onCall?.();
    if (this.hang) await new Promise<never>(() => undefined);
    if (this.fail) throw new AssistantUnavailableError("fake");
    const out = this.reply ? this.reply(input) : { title: `Grupo de ${input.newTicket.title}`, description: "Tickets do mesmo assunto." };
    return { ...out, model: "fake-model" };
  }
}

/** Escritor de descrição falso: `Texto para: <pedido>`, a menos que `reply` mande outra coisa. */
export class FakeDescriptionWriter implements DescriptionWriter {
  readonly calls: DescriptionDraftInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  reply: ((input: DescriptionDraftInput) => string) | null = null;
  fail = false;
  async write(input: DescriptionDraftInput): Promise<{ text: string; model: string }> {
    this.calls.push(structuredClone(input) as DescriptionDraftInput);
    await this.onCall?.();
    if (this.fail) throw new AssistantUnavailableError("fake");
    return { text: this.reply ? this.reply(input) : `Texto para: ${input.request}`, model: "fake-model" };
  }
}

/**
 * Respondedor falso: devolve `Resposta: <pergunta>` a menos que `script` mande outra coisa. O `script` recebe a entrada
 * (em rótulos neutros) e pode chamar `input.tools.execute`, como o adaptador do Claude faria. `delegate` entrega a
 * chamada a outro respondedor (o real, com um provedor roteirizado).
 */
export class FakeProjectAnswerer implements ProjectAnswerer {
  readonly calls: { question: string; history: { author: "person" | "assistant"; body: string }[] }[] = [];
  onCall: (() => Promise<void>) | null = null;
  script: ((input: ProjectAnswerInput) => Promise<string>) | null = null;
  delegate: ProjectAnswerer | null = null;
  fail = false;
  async answer(input: ProjectAnswerInput): Promise<{ text: string; model: string }> {
    this.calls.push({ question: input.question, history: structuredClone([...input.history]) });
    await this.onCall?.();
    if (this.fail) throw new AssistantUnavailableError("fake");
    if (this.delegate) return this.delegate.answer(input);
    return { text: this.script ? await this.script(input) : `Resposta: ${input.question}`, model: "fake-model" };
  }
}

/** Chat de trabalho falso (ADR 0049): grava EXATAMENTE o que recebeu e responde um texto previsível. */
export class FakeChatProvider implements ChatProvider {
  readonly calls: ChatTurnInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  reply_: ((input: ChatTurnInput) => string) | null = null;
  fail = false;
  async reply(input: ChatTurnInput): Promise<{ message: string; model: string }> {
    this.calls.push(structuredClone(input) as ChatTurnInput);
    await this.onCall?.();
    if (this.fail) throw new AssistantUnavailableError("fake");
    const last = input.history[input.history.length - 1]?.body ?? "";
    return { message: this.reply_ ? this.reply_(input) : `Resposta sobre ${input.ticket.key}: ${last.slice(0, 40)}`, model: "claude-opus-5-5" };
  }
}

/** Elaboração falsa (ADR 0052, fatia 3): por padrão não liga nem sugere nada; `reply` manda o que o "modelo" devolve. */
export class FakeTicketElaborator implements TicketElaborator {
  readonly calls: ElaborationInput[] = [];
  onCall: (() => Promise<void>) | null = null;
  reply: ((input: ElaborationInput) => Pick<ElaborationResult, "links" | "suggested">) | null = null;
  fail = false;
  hang = false;
  async elaborate(input: ElaborationInput): Promise<ElaborationResult> {
    this.calls.push(structuredClone(input) as ElaborationInput);
    await this.onCall?.();
    if (this.hang) await new Promise<never>(() => undefined);
    if (this.fail) throw new AssistantUnavailableError("fake");
    return { ...(this.reply ? this.reply(input) : { links: [], suggested: [] }), model: "fake-model" };
  }
}

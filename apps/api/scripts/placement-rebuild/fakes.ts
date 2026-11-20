/**
 * Provedores falsos e determinísticos do `--fake-providers` (só para ensaio, nunca com IA de verdade).
 * Espelham os de `test/assistant-fakes.ts`, mas o juiz escolhe pelo vocabulário em comum, para o ensaio gerar um
 * resultado variado em vez de sempre o primeiro candidato.
 */
import { AssistantUnavailableError } from "../../src/assistant/ports.js";
import type {
  BranchCandidate,
  BranchJudge,
  BranchJudgment,
  BranchSummarizer,
  BranchSummaryInput,
  ConversationProvider,
  ConversationTurn,
  ConversationTurnInput,
} from "../../src/assistant/ports.js";
import type { DirectoryProvider } from "../../src/auth/directory-provider.js";

/** Responde 503 nas primeiras `failFirst` chamadas (para ensaiar as tentativas e a retomada). */
export class FakeConversation implements ConversationProvider {
  private calls = 0;
  constructor(private readonly failFirst = 0) {}

  turn(input: ConversationTurnInput): Promise<ConversationTurn> {
    this.calls += 1;
    if (this.calls <= this.failFirst) return Promise.reject(new AssistantUnavailableError("fake_503"));
    const last = [...input.history].reverse().find((m) => m.author === "person")?.body ?? "";
    const [title = "", ...rest] = last.split("\n\n");
    return Promise.resolve({
      message: "Entendi.",
      draft: { title: title.slice(0, 200), description: rest.join("\n\n") },
      ready: true,
      model: "fake-model",
    });
  }
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && word !== "resumo"),
  );

export class FakeJudge implements BranchJudge {
  private calls = 0;
  /** `failAt` > 0: a chamada de número `failAt` (contada desde o início) responde 503 uma vez. */
  constructor(private readonly failAt = 0) {}

  judge(input: {
    draft: { title: string; description: string };
    candidates: readonly BranchCandidate[];
    scope?: BranchCandidate;
  }): Promise<BranchJudgment> {
    this.calls += 1;
    if (this.failAt > 0 && this.calls === this.failAt) return Promise.reject(new AssistantUnavailableError("fake_503_judge"));
    const draftWords = words(`${input.draft.title} ${input.draft.description}`);
    const scores = input.candidates.map((c) => [...words(`${c.title} ${c.summary}`)].filter((w) => draftWords.has(w)).length);
    const weights = scores.map((s) => s + 0.05);
    const total = weights.reduce((a, b) => a + b, 0);
    // O escopo cabe quando divide alguma palavra com o rascunho (ou com um dos seus filhos); senão, não cabe.
    const scopeFit = input.scope
      ? { scopeFit: [...words(`${input.scope.title} ${input.scope.summary}`)].some((w) => draftWords.has(w)) || Math.max(0, ...scores) > 0 ? 0.9 : 0.2 }
      : {};
    return Promise.resolve({
      belongs: Math.max(0, ...scores) > 0 ? 0.9 : 0.2,
      choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, (weights[i] as number) / total])),
      ...scopeFit,
    });
  }
}

export class FakeSummarizer implements BranchSummarizer {
  summarize(input: BranchSummaryInput): Promise<{ summary: string; model: string }> {
    return Promise.resolve({ summary: `Resumo de ${input.title}`, model: "fake-model" });
  }
}

export class FakeDirectoryProvider implements DirectoryProvider {
  getUser(userId: string) {
    return Promise.resolve({ displayName: `Nome de ${userId}`, email: `${userId}@exemplo.test`, avatarUrl: null });
  }
  getOrganization(orgId: string) {
    return Promise.resolve({ name: `Organização ${orgId}`, slug: orgId.toLowerCase() });
  }
}

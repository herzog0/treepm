/**
 * Provedores falsos e determinísticos do `--fake-providers` (só para ensaio, nunca com IA de verdade).
 * Espelham os de `test/assistant-fakes.ts`, mas o juiz escolhe pelo vocabulário em comum, para o ensaio gerar um
 * resultado variado em vez de sempre o primeiro candidato.
 */
import { AssistantUnavailableError } from "../../src/assistant/ports.js";
import type {
  AffinityInput,
  AffinityJudge,
  BranchCandidate,
  BranchJudge,
  BranchJudgment,
  BranchSummarizer,
  BranchSummaryInput,
  ConversationProvider,
  ConversationTurn,
  ConversationTurnInput,
  ElaborationInput,
  ElaborationResult,
  ExistingMatchInput,
  ExistingMatchResult,
  GroupNameInput,
  GroupNamer,
  RelatedInput,
  RelatedJudge,
  RelatedJudgment,
  TicketElaborator,
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
  getMembership() {
    return Promise.resolve("org:member");
  }
}

/** Afinidade falsa do ensaio: 0,9 quando o ticket divide alguma palavra com o rascunho, senão 0,1. */
export class FakeAffinity implements AffinityJudge {
  judge(input: AffinityInput): Promise<Record<string, number>> {
    const draftWords = words(`${input.draft.title} ${input.draft.description}`);
    return Promise.resolve(
      Object.fromEntries(input.tickets.map((t) => [t.id, [...words(`${t.title} ${t.descriptionExcerpt}`)].some((w) => draftWords.has(w)) ? 0.9 : 0.1])),
    );
  }
}

/** Relacionados falsos do ensaio: "mesmo assunto" 0,9 quando o ticket divide alguma palavra com o rascunho, senão 0,1; "mesma coisa" 0,9 só com título igual. */
export class FakeRelated implements RelatedJudge {
  /** Modo opcional: `sameRequest` por título do candidato (o que vale para as sugeridas procuradas na árvore); o que não está no mapa cai na regra de palavras. */
  constructor(private readonly sameRequestByTitle: Readonly<Record<string, number>> = {}) {}

  judge(input: RelatedInput): Promise<Record<string, RelatedJudgment>> {
    const draftWords = words(`${input.draft.title} ${input.draft.description}`);
    const norm = (text: string) => text.trim().toLowerCase();
    return Promise.resolve(
      Object.fromEntries(
        input.candidates.map((c) => [
          c.id,
          {
            sameSubject: [...words(`${c.title} ${c.excerpt}`)].some((w) => draftWords.has(w)) ? 0.9 : 0.1,
            sameRequest: this.sameRequestByTitle[c.title] ?? (norm(c.title) === norm(input.draft.title) ? 0.9 : 0.1),
          },
        ]),
      ),
    );
  }
}

export class FakeNamer implements GroupNamer {
  name(input: GroupNameInput): Promise<{ title: string; description: string; model: string }> {
    return Promise.resolve({ title: `Grupo de ${input.newTicket.title}`.slice(0, 80), description: "Agrupador do ensaio.", model: "fake-model" });
  }
}

/**
 * Elaboração falsa do ensaio (ADR 0052, fatia 3): liga o pedido a cada relacionado (até cinco) e, sem relacionados, sugere uma
 * tarefa, para o ensaio exercitar os dois lados. Nunca chama modelo.
 */
export class FakeElaborator implements TicketElaborator {
  /** No ensaio, a sugerida "já existe" quando a árvore tem um ticket de mesmo título (o falso nunca chama modelo). */
  matchExisting(input: ExistingMatchInput): Promise<ExistingMatchResult> {
    return Promise.resolve({ answers: input.tasks.map((task) => ({ index: task.index, existing: task.candidates.find((candidate) => candidate.title === task.title)?.key ?? null })), model: "fake-model" });
  }
  elaborate(input: ElaborationInput): Promise<ElaborationResult> {
    const links = input.related.slice(0, 5).map((ticket) => ({ de: "pai" as const, dependeDe: ticket.key, motivo: "Ensaio: o pedido toca neste ticket." }));
    const suggested = input.related.length === 0 ? [{ title: "Tarefa implicada (ensaio)", description: "", motivo: "Ensaio: nada existe sobre o assunto." }] : [];
    return Promise.resolve({ links, suggested, model: "fake-model" });
  }
}

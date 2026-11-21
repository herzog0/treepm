/**
 * Peças do comando `collect` (ferramenta de medição, nunca o produto): a conversa que não chama o Claude, o juiz que só
 * captura os candidatos da raiz, a afinidade que não pergunta nada e os falsos do `--fake-providers`.
 */
import type {
  AffinityInput,
  AffinityJudge,
  BranchCandidate,
  BranchJudge,
  BranchJudgment,
  ConversationProvider,
  ConversationTurn,
  ConversationTurnInput,
} from "../../src/assistant/ports.js";
import type { ClaudeStreamer } from "../../src/assistant/claude-call.js";
import type { SystemOneCall } from "../../src/assistant/jev-branch-judge.js";

/** Não chama provedor: devolve um rascunho qualquer; quem usa grava o rascunho de verdade em seguida. */
export class NoTurnConversation implements ConversationProvider {
  turn(input: ConversationTurnInput): Promise<ConversationTurn> {
    const first = [...input.history].reverse().find((m) => m.author === "person")?.body ?? "";
    return Promise.resolve({ message: "-", draft: { title: first.slice(0, 200) || "-", description: "" }, ready: true, model: "none" });
  }
}

/** Guarda os candidatos da raiz que a procura real ofereceu (já com os resumos escritos pelo caminho do produto). */
export class RootCapture {
  candidates: BranchCandidate[] | null = null;
  reset(): void {
    this.candidates = null;
  }
}

/** Faz a procura parar na raiz (`belongs` 0) depois de guardar os candidatos do primeiro nível. Não chama provedor. */
export class RootCaptureJudge implements BranchJudge {
  constructor(private readonly capture: RootCapture) {}
  judge(input: Parameters<BranchJudge["judge"]>[0]): Promise<BranchJudgment> {
    if (this.capture.candidates === null && input.current === null && !input.scope) this.capture.candidates = input.candidates.map((c) => ({ ...c }));
    return Promise.resolve({ belongs: 0, choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0])) });
  }
}

/** Nenhum ticket solto passa: a proposta de agrupador não chama provedor nem nomeia nada. */
export class ZeroAffinity implements AffinityJudge {
  judge(input: AffinityInput): Promise<Record<string, number>> {
    return Promise.resolve(Object.fromEntries(input.tickets.map((t) => [t.id, 0])));
  }
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4),
  );
const overlaps = (a: string, b: string): boolean => {
  const left = words(a);
  return [...words(b)].some((word) => left.has(word));
};

/** Jev falso do ensaio: cada pergunta `Noul` responde 0,9 quando o agrupador divide uma palavra com o rascunho, senão 0,1. */
export const fakeSystemOne: SystemOneCall = (request) => {
  const state = request.state as { draft: { title: string; description?: string } };
  const draftText = `${state.draft.title} ${state.draft.description ?? ""}`;
  const questions = request.questions as unknown as Record<string, { instructions: { scope: { title: string; summary?: string } } }>;
  const answers = Object.fromEntries(
    Object.entries(questions).map(([key, q]) => [key, { noul: overlaps(draftText, `${q.instructions.scope.title} ${q.instructions.scope.summary ?? ""}`) ? 0.9 : 0.1 }]),
  );
  return Promise.resolve({ model: "fake-jev", answers, usage: { input_tokens: 1, output_tokens: 1 } });
};

/** Claude falso do ensaio: o primeiro da lista é o agrupador que divide palavra com o ticket; se nenhum divide, `root`. */
export const fakeClaude: ClaudeStreamer = (params) => {
  const content = (params.messages[0] as { content: string }).content;
  const parsed = JSON.parse(content) as {
    project: { groups: { option: string; title: string; description?: string; tickets: string[] }[] };
    new_ticket: { title: string; description?: string };
  };
  const ticketText = `${parsed.new_ticket.title} ${parsed.new_ticket.description ?? ""}`;
  const matches = parsed.project.groups
    .filter((g) => overlaps(ticketText, `${g.title} ${g.description ?? ""} ${g.tickets.join(" ")}`))
    .map((g) => g.option);
  return Promise.resolve({
    stop_reason: "end_turn",
    parsed_output: { ranking: matches.length > 0 ? matches.slice(0, 3) : ["root"] },
    model: "fake-claude",
    usage: { input_tokens: content.length, output_tokens: 5 },
  });
};

/**
 * O respondedor pelo gabarito e a curva da dúvida (ADR 0054, itens 5 e 6). Parte pura: nada aqui fala com rede, banco ou provedor.
 * A curva recalcula, dos julgamentos já gravados de uma rodada, o que a regra de dúvida faria com outra largura de faixa: usa a
 * MESMA função da rota (`findDoubt`), só com outra configuração.
 */
import { BELONGS_HIGH, BELONGS_LOW } from "../../src/assistant/placement-search.js";
import { findDoubt } from "../../src/assistant/placement-doubt.js";
import type { DoubtConfig, DoubtKind, DoubtStepInput } from "../../src/assistant/placement-doubt.js";
import type { JudgmentRecord, PlacementGroup } from "./core.js";

/** O teto de perguntas por ticket nas ferramentas (a tela conta o dela; o servidor não conta). */
export const MAX_QUESTIONS = 3;

export type QuestionView = { level: number; kind: DoubtKind; at: { id: string | null; path?: readonly { id: string }[] }; options: { id: string }[] };
export type QuestionRecord = {
  level: number;
  kind: DoubtKind;
  options: number;
  /** O lugar certo está entre os ramos oferecidos (uma opção está no caminho até ele). */
  expectedInBranch: boolean;
  /** A resposta certa estava disponível: um ramo que leva ao lugar certo, ou "deixar aqui" quando o lugar certo é o nó da pergunta. */
  expectedInOptions: boolean;
  /** `branch`: recomeçou do ramo da opção; `stay`: o lugar é o nó da pergunta; `none`: nenhuma opção servia, foi ao mapa. */
  answer: "branch" | "stay" | "none";
  guessParentId: string | null;
};
/**
 * O resultado final de um ticket, sem misturar (ADR 0054). `no_judgment_after_answer` só existe na simulação sobre rodada antiga.
 */
export type FinalKind =
  | "right_no_question"
  | "deeper_no_question"
  | "wrong_no_question"
  | "right_after_question"
  | "deeper_after_question"
  | "wrong_after_question"
  | "no_judgment_after_answer"
  | "stopped_at_limit"
  | "went_to_map";
export const FINAL_KINDS: readonly FinalKind[] = [
  "right_no_question", "deeper_no_question", "wrong_no_question", "right_after_question", "deeper_after_question", "wrong_after_question",
  "no_judgment_after_answer", "stopped_at_limit", "went_to_map",
];
export const FINAL_LABELS: Record<FinalKind, string> = {
  right_no_question: "certo sem pergunta",
  deeper_no_question: "mais fundo sem pergunta",
  wrong_no_question: "errado sem pergunta",
  right_after_question: "certo depois de pergunta",
  deeper_after_question: "mais fundo depois de pergunta",
  wrong_after_question: "errado depois de pergunta",
  no_judgment_after_answer: "sem julgamento gravado depois da resposta",
  stopped_at_limit: "parou no teto",
  went_to_map: "foi ao mapa",
};
/** A primeira procura (o palpite sem ajuda) e o resultado final, guardados à parte. */
export type DoubtRun = {
  questions: QuestionRecord[];
  result: FinalKind;
  first: { parentId: string | null; group: PlacementGroup; uncertain: boolean };
  final: { parentId: string | null; group: PlacementGroup };
};

/** Como o destino se compara ao lugar esperado, na mesma conta de `classifyPlacement` (ids novos, da raiz ao pai). */
export function groupOf(destinationIds: readonly string[], expectedPath: readonly string[]): PlacementGroup {
  if ((destinationIds[destinationIds.length - 1] ?? null) === (expectedPath[expectedPath.length - 1] ?? null)) return "same_parent";
  const passes = expectedPath.length > 0 && destinationIds.length > expectedPath.length && expectedPath.every((id, i) => destinationIds[i] === id);
  return passes ? "deeper" : "elsewhere";
}

/** `expectedPath`: ids da raiz até o lugar esperado, inclusive (`[]` = a raiz). */
export function gabaritoAnswer(question: QuestionView, expectedPath: readonly string[]): { choice: { kind: "branch"; id: string } | { kind: "stay" } | { kind: "none" }; expectedInBranch: boolean; expectedInOptions: boolean } {
  // Vale a opção que está no caminho até o lugar esperado, em qualquer profundidade, desde que seja descendente do nó da pergunta.
  const at = question.at.id === null ? -1 : expectedPath.indexOf(question.at.id);
  const option = question.options.find((o) => expectedPath.includes(o.id) && expectedPath.indexOf(o.id) > at);
  if (option) return { choice: { kind: "branch", id: option.id }, expectedInBranch: true, expectedInOptions: true };
  if ((expectedPath[expectedPath.length - 1] ?? null) === question.at.id) return { choice: { kind: "stay" }, expectedInBranch: false, expectedInOptions: true };
  return { choice: { kind: "none" }, expectedInBranch: false, expectedInOptions: false };
}

type Outcomeish = { destination: { parentId: string | null; path?: readonly { id: string }[] }; uncertain?: boolean; question?: QuestionView | null };
const idsOf = (o: Outcomeish): string[] => (o.destination.path ?? (o.destination.parentId === null ? [] : [{ id: o.destination.parentId }])).map((n) => n.id);

/** O rótulo do resultado final: a primeira procura julga quando não houve pergunta; depois de pergunta, o resultado final. */
export function finalKindOf(input: { questions: number; wentToMap: boolean; hitLimit: boolean; noJudgment?: boolean; firstGroup: PlacementGroup; finalGroup: PlacementGroup }): FinalKind {
  if (input.hitLimit) return "stopped_at_limit";
  if (input.wentToMap) return "went_to_map";
  if (input.noJudgment) return "no_judgment_after_answer";
  if (input.questions > 0) return input.finalGroup === "same_parent" ? "right_after_question" : input.finalGroup === "deeper" ? "deeper_after_question" : "wrong_after_question";
  return input.firstGroup === "same_parent" ? "right_no_question" : input.firstGroup === "deeper" ? "deeper_no_question" : "wrong_no_question";
}

/**
 * Faz a procura e responde cada pergunta pelo gabarito: uma opção que contém o lugar esperado vira nova procura com `startId` =
 * a opção; se o lugar esperado é o nó da pergunta, encerra ali ("fica aqui"); senão, "foi ao mapa" (o lugar final é o esperado,
 * escolhido à mão). Para em três perguntas: no teto fica no ramo confirmado mais fundo.
 */
export async function answerByGabarito<T extends Outcomeish>(request: (body: { startId?: string }) => Promise<T>, expectedPath: readonly string[]): Promise<{ outcome: T; first: T; run: DoubtRun }> {
  const questions: QuestionRecord[] = [];
  const first = await request({});
  let outcome = first;
  let startId: string | null = null;
  let finalIds: string[] | null = null;
  let wentToMap = false;
  let hitLimit = false;
  while (outcome.question) {
    const q = outcome.question;
    if (questions.length >= MAX_QUESTIONS) {
      hitLimit = true;
      finalIds = startId === null ? [] : expectedPath.slice(0, expectedPath.indexOf(startId) + 1);
      break;
    }
    const { choice, expectedInBranch, expectedInOptions } = gabaritoAnswer(q, expectedPath);
    questions.push({ level: q.level, kind: q.kind, options: q.options.length, expectedInBranch, expectedInOptions, answer: choice.kind, guessParentId: outcome.destination.parentId });
    if (choice.kind === "branch") {
      startId = choice.id;
      outcome = await request({ startId });
    } else {
      wentToMap = choice.kind !== "stay";
      finalIds = choice.kind === "stay" ? (q.at.path ?? []).map((n) => n.id) : [...expectedPath];
      break;
    }
  }
  const firstGroup = groupOf(idsOf(first), expectedPath);
  const finalGroup = groupOf(finalIds ?? idsOf(outcome), expectedPath);
  const result = finalKindOf({ questions: questions.length, wentToMap, hitLimit, firstGroup, finalGroup });
  const parentId = finalIds === null ? outcome.destination.parentId : (finalIds[finalIds.length - 1] ?? null);
  return {
    outcome,
    first,
    run: { questions, result, first: { parentId: first.destination.parentId, group: firstGroup, uncertain: first.uncertain === true }, final: { parentId, group: finalGroup } },
  };
}

// ---- a curva: a mesma regra sobre julgamentos gravados -------------------------------------------------------------

type Stored = { judgments: readonly JudgmentRecord[]; destinationPath: readonly { id: string }[]; group: PlacementGroup; doubt?: { first?: { group: PlacementGroup } } };

function stepOf(judgments: readonly JudgmentRecord[], parent: string | null, child: string | null, level: number): DoubtStepInput | null {
  const found = judgments.find((j) => j.currentId === parent && j.candidateIds !== undefined && (child === null || j.candidateIds.includes(child))) ?? judgments.find((j) => j.currentId === parent && j.candidateIds !== undefined);
  if (!found) return null;
  return {
    level,
    parentId: parent,
    belongs: found.belongs,
    result: found.belongs < BELONGS_LOW ? "below_low" : found.belongs <= BELONGS_HIGH ? "band" : "descended",
    candidates: (found.candidateIds ?? []).map((ticketId) => ({ ticketId, probability: found.choiceById?.[ticketId] ?? 0 })),
  };
}

/** Os passos do caminho destino gravado, na ordem: o formato que `findDoubt` espera. */
export function stepsOfRecord(record: Pick<Stored, "judgments" | "destinationPath">): { steps: DoubtStepInput[]; walk: (string | null)[] } {
  const walk: (string | null)[] = [null, ...record.destinationPath.map((n) => n.id)];
  const steps = walk.flatMap((parent, i) => stepOf(record.judgments, parent, walk[i + 1] ?? null, i + 1) ?? []);
  return { steps, walk };
}

/** Quantas e quais perguntas a regra faria para este ticket e como terminaria com o respondedor pelo gabarito. */
export function simulate(record: Stored, expectedPath: readonly string[], config: DoubtConfig): DoubtRun {
  let { steps, walk } = stepsOfRecord(record);
  const firstGroup = record.doubt?.first?.group ?? record.group;
  const guess = walk[walk.length - 1] ?? null;
  const questions: QuestionRecord[] = [];
  let startIdx = 0;
  let wentToMap = false;
  let limit = false;
  let noJudgment = false;
  for (let guard = 0; guard < 12; guard += 1) {
    const doubt = findDoubt({ steps, walk: walk.slice(startIdx), stoppedEarly: null }, config);
    if (!doubt) break;
    if (questions.length >= MAX_QUESTIONS) {
      limit = true;
      break;
    }
    const step = steps.find((s) => s.parentId === doubt.parentId);
    const options = [...(step?.candidates ?? [])].sort((a, b) => b.probability - a.probability).slice(0, 3);
    const hit = options.find((o) => expectedPath.includes(o.ticketId));
    const atExpected = (expectedPath[expectedPath.length - 1] ?? null) === doubt.parentId;
    const answer = hit ? "branch" : atExpected ? "stay" : "none";
    questions.push({ level: doubt.level, kind: doubt.kind, options: options.length, expectedInBranch: hit !== undefined, expectedInOptions: hit !== undefined || atExpected, answer, guessParentId: guess });
    if (answer === "stay") {
      walk = walk.slice(0, walk.indexOf(doubt.parentId) + 1);
      break;
    }
    if (answer === "none") {
      wentToMap = true;
      break;
    }
    // O ramo da pessoa: a procura continua dele, pelos próprios julgamentos gravados (um caminho só, sem hipóteses de parar).
    const at = walk.indexOf(doubt.parentId);
    const next = [...walk.slice(0, at + 1), (hit as { ticketId: string }).ticketId];
    steps = steps.filter((s) => walk.slice(0, at + 1).includes(s.parentId));
    let judged = false;
    for (let node = next[next.length - 1] as string; ; ) {
      const s = stepOf(record.judgments, node, null, next.length);
      if (!s) break;
      judged = true;
      steps.push(s);
      if ((s.belongs ?? 0) < BELONGS_LOW) break;
      const top = [...s.candidates].sort((a, b) => b.probability - a.probability)[0];
      if (!top) break;
      next.push(top.ticketId);
      node = top.ticketId;
    }
    walk = next;
    startIdx = next.indexOf((hit as { ticketId: string }).ticketId);
    // O rascunho não tem julgamento gravado para o ramo respondido: a simulação não tem como dizer onde a procura terminaria.
    if (!judged) {
      noJudgment = true;
      break;
    }
  }
  const destination = walk[walk.length - 1] ?? null;
  const finalGroup = groupOf(walk.filter((n): n is string => n !== null), expectedPath);
  const result = finalKindOf({ questions: questions.length, wentToMap, hitLimit: limit, noJudgment, firstGroup, finalGroup });
  return { questions, result, first: { parentId: guess, group: firstGroup, uncertain: false }, final: { parentId: destination, group: finalGroup } };
}

export const CURVE_WIDTHS: readonly [number, number][] = [[0.3, 0.7], [0.2, 0.8], [0.15, 0.85], [0.1, 0.9], [0.05, 0.95]];
export const CURVE_CHOICES: readonly number[] = [0, 0.5];

export type CurveRow = {
  low: number;
  high: number;
  choice: number;
  withQuestion: number;
  total: number;
  perTicketMean: number;
  perTicketMax: number;
  questions: number;
  /** Perguntas em que o lugar certo estava entre os ramos oferecidos. */
  expectedInBranch: number;
  /** Perguntas em que a resposta certa estava disponível (um ramo certo, ou "deixar aqui" quando o lugar certo é o nó da pergunta). */
  expectedInOptions: number;
  wrongSilent: number;
  byKind: Record<DoubtKind, number>;
  final: Record<FinalKind, number>;
  /** A conta só de faixa e escolha, sem a regra da raiz (a conferência com a conta manual da coordenação). */
  withoutRoot: { withQuestion: number; wrongSilent: number };
};

export function doubtCurve(records: readonly { record: Stored; expectedPath: readonly string[] }[]): CurveRow[] {
  const rows: CurveRow[] = [];
  for (const [low, high] of CURVE_WIDTHS) {
    for (const choice of CURVE_CHOICES) {
      const config: DoubtConfig = { low, high, choice };
      const runs = records.map(({ record, expectedPath }) => ({ record, run: simulate(record, expectedPath, config), plain: simulate(record, expectedPath, { ...config, rootIsDoubt: false }) }));
      const asked = runs.filter((r) => r.run.questions.length > 0);
      const byKind: Record<DoubtKind, number> = { fit: 0, which: 0, root: 0, related: 0, interrupted: 0 };
      for (const r of runs) { const k = r.run.questions[0]?.kind; if (k) byKind[k] += 1; }
      const final = Object.fromEntries(FINAL_KINDS.map((k) => [k, 0])) as Record<FinalKind, number>;
      for (const r of runs) final[r.run.result] += 1;
      const all = runs.flatMap((r) => r.run.questions);
      rows.push({
        low, high, choice,
        withQuestion: asked.length,
        total: runs.length,
        perTicketMean: asked.length === 0 ? 0 : all.length / asked.length,
        perTicketMax: Math.max(0, ...runs.map((r) => r.run.questions.length)),
        questions: all.length,
        expectedInBranch: all.filter((q) => q.expectedInBranch).length,
        expectedInOptions: all.filter((q) => q.expectedInOptions).length,
        wrongSilent: final.wrong_no_question,
        byKind,
        final,
        withoutRoot: { withQuestion: runs.filter((r) => r.plain.questions.length > 0).length, wrongSilent: runs.filter((r) => r.plain.result === "wrong_no_question").length },
      });
    }
  }
  return rows;
}

const pct = (n: number, d: number): string => `${n} de ${d}`;
const comma = (n: number): string => n.toString().replace(".", ",");
/** As colunas de resultado final, na ordem: somam o total da linha (a simulação nunca recusa uma resposta). */
const CURVE_FINALS: readonly FinalKind[] = ["right_no_question", "deeper_no_question", "wrong_no_question", "right_after_question", "deeper_after_question", "wrong_after_question", "no_judgment_after_answer", "stopped_at_limit", "went_to_map"];

export function curveMarkdown(rows: readonly CurveRow[]): string {
  const lines = [
    "## Curva da dúvida (ADR 0054): a mesma regra sobre os julgamentos desta rodada, sem chamar provedor",
    "",
    "Calculada da PRIMEIRA procura de cada ticket (o palpite sem ajuda). Só dúvidas da descida (`fit`, `which`, `root`): a regra dos relacionados não está nos julgamentos gravados. \"Errado sem pergunta\" é o errado calado. O respondedor pelo gabarito escolhe o ramo que contém o lugar esperado, \"fica aqui\" se o lugar é o nó da pergunta, senão \"nenhum destes\". \"Lugar certo entre os ramos\" conta só os ramos oferecidos; \"resposta certa disponível\" conta também o \"fica aqui\" certo.",
    "",
    `| faixa | escolha | com pergunta | por ticket (média / máx) | lugar certo entre os ramos | resposta certa disponível | tipo da 1ª (fit/which/root) | ${CURVE_FINALS.map((k) => FINAL_LABELS[k]).join(" | ")} | só faixa e escolha (sem raiz): com pergunta / errados sem pergunta |`,
    `|${"---|".repeat(7 + CURVE_FINALS.length + 1)}`,
  ];
  for (const r of rows) {
    lines.push(`| ${comma(r.low)}–${comma(r.high)} | ${comma(r.choice)} | ${pct(r.withQuestion, r.total)} | ${comma(Number(r.perTicketMean.toFixed(2)))} / ${r.perTicketMax} | ${pct(r.expectedInBranch, r.questions)} perguntas | ${pct(r.expectedInOptions, r.questions)} perguntas | ${r.byKind.fit}/${r.byKind.which}/${r.byKind.root} | ${CURVE_FINALS.map((k) => r.final[k]).join(" | ")} | ${r.withoutRoot.withQuestion} / ${r.withoutRoot.wrongSilent} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** O resultado final da rodada com o respondedor (as perguntas de verdade que a procura fez, não a simulação). Os rótulos somam o total. */
export function responderSummaryMarkdown(records: readonly { doubt?: DoubtRun }[]): string {
  const withRun = records.filter((r) => r.doubt !== undefined) as { doubt: DoubtRun }[];
  if (withRun.length === 0) return "";
  const count = (k: FinalKind): number => withRun.filter((r) => r.doubt.result === k).length;
  const asked = withRun.flatMap((r) => r.doubt.questions);
  const parts = FINAL_KINDS.filter((k) => count(k) > 0).map((k) => `${FINAL_LABELS[k]} ${count(k)}`);
  return `## Resultado da rodada com o respondedor pelo gabarito\n\n${withRun.length} colocações: ${parts.join(", ")}. ${asked.length} perguntas: o lugar certo estava entre os ramos em ${asked.filter((q) => q.expectedInBranch).length}, a resposta certa estava disponível em ${asked.filter((q) => q.expectedInOptions).length}.\n`;
}

/**
 * Procura do caminho (ADR 0029): desce a árvore um nível por vez perguntando ao juiz (Jev) e decide em código.
 * Lógica pura: nada aqui fala com banco ou rede; a árvore e o juiz entram por `PlacementDeps`.
 */
import { AssistantUnavailableError } from "./ports.js";
import type { BranchCandidate, BranchJudge, TicketDraft } from "./ports.js";

export const MAX_LEVELS = 20;
export const MAX_PATHS = 3;
export const MAX_ALTERNATIVES = 2;
/** Abaixo disto o rascunho não pertence a nenhum candidato; acima de `BELONGS_HIGH`, pertence. Entre os dois, ficam as duas hipóteses. */
export const BELONGS_LOW = 0.3;
export const BELONGS_HIGH = 0.7;
/** Piso da probabilidade de cada aresta, como no guia de classificação hierárquica da TypeSafe. */
export const PROBABILITY_FLOOR = 1e-9;
/** O primeiro caminho "não se destaca" do segundo quando a razão entre as notas é menor que isto. */
export const UNCERTAIN_RATIO = 1.25;
export const PLACEMENT_TIMEOUT_MS = 30_000;

export type JudgeInput = Parameters<BranchJudge["judge"]>[0];

/** As proporções tentadas, em ordem, quando o nível não cabe no orçamento do juiz (1 é o texto cheio, já tentado). */
const DESCENDANTS_SCALES = [0.5, 0.25, 0] as const;

export type PlacementDeps = {
  judge: BranchJudge;
  /** Candidatos de um nó: os seus filhos diretos que têm filhos (ADR 0034); `null` é a raiz do projeto. Sem filho que tenha filhos não há candidatos, e a procura termina no nó. */
  candidates(parentId: string | null, descendantsScale?: number): Promise<readonly BranchCandidate[]>;
  /** A requisição cabe no limite de tokens do juiz? Se não, a procura para naquele nível. */
  fits(input: JudgeInput): boolean;
  /**
   * Ponto de partida da procura (ADR 0031): o agrupador selecionado e os seus ancestrais, da raiz ao pai. A descida
   * começa nele e não sobe; os caminhos do resultado continuam desde a raiz do projeto.
   */
  scope?: { node: BranchCandidate; ancestors: readonly { id: string; title: string }[] };
  /**
   * Ponto de partida de um ramo que a pessoa respondeu (ADR 0054): como o escopo, a descida parte dele e os caminhos
   * continuam desde a raiz, mas a escolha NÃO é julgada de novo (sem a conferência de escopo: o nó entra como nó atual da
   * primeira pergunta). Vale mais que `scope`.
   */
  start?: { node: BranchCandidate; ancestors: readonly { id: string; title: string }[] };
  timeoutMs?: number;
  /** Só para teste: reduz `MAX_LEVELS`. */
  maxLevels?: number;
};

export type PlacementTarget = { parentId: string | null; path: { id: string; title: string }[] };

/** Por que um caminho parou (ADR 0052, item 5): `band` é a faixa do meio, em que "parar aqui" ficou como hipótese. */
export type StopWhy = "no_candidates" | "below_low" | "band" | "candidates_too_large" | "max_levels";

/**
 * O rastro da decisão (ADR 0052, item 5): só identificadores e números, nenhum título nem texto. Um passo por pergunta feita
 * (ou recusada) ao juiz; `parentId` é o nó em que a pergunta foi feita (`null` = raiz do projeto).
 */
export type PlacementStep = {
  level: number;
  parentId: string | null;
  result: "descended" | "band" | "below_low" | "no_candidates" | "too_large";
  /** Probabilidade de "cabe em algum"; `null` quando o juiz não foi perguntado (sem candidatos, ou não coube). */
  belongs: number | null;
  candidates: { ticketId: string; probability: number }[];
};
export type PlacementTrace = {
  steps: PlacementStep[];
  /** Ids do caminho escolhido (da raiz até o destino) e de cada alternativa. */
  chosen: string[];
  alternatives: string[][];
  stop: StopWhy | null;
  scope: { id: string; fit: number | null } | null;
};

export type PlacementOutcome = {
  destination: PlacementTarget;
  alternatives: PlacementTarget[];
  /** Agrupadores oferecidos em algum nível e não seguidos pelos caminhos mantidos. */
  discarded: { level: number; parentId: string | null; ticketId: string; title: string }[];
  uncertain: boolean;
  stoppedEarly: { reason: "candidates_too_large" | "max_levels"; level: number; parentId: string | null } | null;
  /**
   * O que a conferência do escopo disse: `null` sem escopo. `fit` é o Noul da pergunta (nulo quando a pergunta não foi
   * feita porque a requisição não coube); `outOfScope` é verdadeiro abaixo de `BELONGS_LOW`.
   */
  scope: { id: string; title: string; outOfScope: boolean; fit: number | null } | null;
  /** O que o juiz respondeu em cada nível e por que a descida parou (ADR 0052). Não sai pela rota: quem grava tira daqui. */
  trace: PlacementTrace;
};

type Path = {
  nodes: BranchCandidate[];
  logSum: number;
  decisions: number;
  done: boolean;
  stop: PlacementOutcome["stoppedEarly"];
  why: StopWhy | null;
  /** Profundidades em que a faixa do meio (0,3 a 0,7) deixou "parar aqui" e "descer" como hipóteses do mesmo nó. */
  bands: number[];
};

const score = (path: Path): number => (path.decisions > 0 ? Math.exp(path.logSum / path.decisions) : 1);
const tip = (path: Path): BranchCandidate | undefined => path.nodes[path.nodes.length - 1];
/** "Parar aqui" e "descer" da faixa do meio: a nota do Choice não mede um contra o outro, então o par é sempre incerto. */
const isBandPair = (a: Path, b: Path): boolean => {
  const [shorter, longer] = a.nodes.length <= b.nodes.length ? [a, b] : [b, a];
  const depth = shorter.nodes.length;
  return (
    shorter.done &&
    shorter.bands.includes(depth) &&
    longer.bands.includes(depth) &&
    shorter.nodes.every((node, index) => longer.nodes[index]?.id === node.id)
  );
};
const target = (path: Path, ancestors: readonly { id: string; title: string }[]): PlacementTarget => ({
  parentId: tip(path)?.id ?? null,
  path: [...ancestors, ...path.nodes.map(({ id, title }) => ({ id, title }))],
});

export async function searchPlacement(draft: TicketDraft, deps: PlacementDeps): Promise<PlacementOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PLACEMENT_TIMEOUT_MS);
  try {
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new AssistantUnavailableError("placement_timeout")));
    });
    return await Promise.race([descend(draft, deps, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function descend(draft: TicketDraft, deps: PlacementDeps, signal: AbortSignal): Promise<PlacementOutcome> {
  const { scope, start } = deps;
  // Com escopo (ou ramo respondido), o primeiro nó do caminho é ele mesmo: a descida parte dele e nunca fica acima dele.
  const origin = start ?? scope;
  const base = origin ? 1 : 0;
  const maxLevels = deps.maxLevels ?? MAX_LEVELS;
  const ancestors = origin?.ancestors ?? [];
  let scopeFit: number | null = null;
  let paths: Path[] = [{ nodes: origin ? [origin.node] : [], logSum: 0, decisions: 0, done: false, stop: null, why: null, bands: [] }];
  const steps: PlacementStep[] = [];
  const discarded: PlacementOutcome["discarded"] = [];

  for (let level = 1; level <= maxLevels && paths.some((p) => !p.done); level++) {
    const kept: Path[] = paths.filter((p) => p.done);
    const offered: { parentId: string | null; candidate: BranchCandidate }[] = [];

    const expansions = await Promise.all(
      paths
        .filter((p) => !p.done)
        .map(async (path): Promise<Path[]> => {
          const current = tip(path);
          const parentId = current?.id ?? null;
          let candidates = await deps.candidates(parentId);
          // A conferência do escopo vai na primeira requisição dentro dele; o nó atual desse nível é o próprio escopo.
          const checksScope = scope !== undefined && start === undefined && level === 1;
          if (candidates.length === 0 && !checksScope) {
            steps.push({ level, parentId, result: "no_candidates", belongs: null, candidates: [] });
            return [{ ...path, done: true, why: "no_candidates" }];
          }
          const inputOf = (offered: readonly BranchCandidate[]): JudgeInput => ({
            draft,
            current: current && !checksScope ? { title: current.title, summary: current.summary } : null,
            candidates: offered,
            ...(checksScope && scope ? { scope: scope.node } : {}),
          });
          let input = inputOf(candidates);
          // Nível grande demais: encolhe a parte dos descendentes de TODOS os candidatos na mesma proporção antes de desistir.
          for (const scale of DESCENDANTS_SCALES) {
            if (deps.fits(input)) break;
            candidates = await deps.candidates(parentId, scale);
            input = inputOf(candidates);
          }
          if (!deps.fits(input)) {
            steps.push({ level, parentId, result: "too_large", belongs: null, candidates: [] });
            return [{ ...path, done: true, stop: { reason: "candidates_too_large", level, parentId }, why: "candidates_too_large" }];
          }
          const verdict = await deps.judge.judge(input, { signal });
          if (checksScope) scopeFit = verdict.scopeFit ?? null;
          if (candidates.length === 0) {
            steps.push({ level, parentId, result: "no_candidates", belongs: null, candidates: [] });
            return [{ ...path, done: true, why: "no_candidates" }];
          }
          for (const candidate of candidates) offered.push({ parentId, candidate });
          const inBand = verdict.belongs >= BELONGS_LOW && verdict.belongs <= BELONGS_HIGH;
          steps.push({
            level,
            parentId,
            result: verdict.belongs < BELONGS_LOW ? "below_low" : inBand ? "band" : "descended",
            belongs: verdict.belongs,
            candidates: candidates.map((candidate) => ({ ticketId: candidate.id, probability: verdict.choice[candidate.id] ?? 0 })),
          });
          if (verdict.belongs < BELONGS_LOW) return [{ ...path, done: true, why: "below_low" }];

          const ranked = [...candidates].sort((a, b) => (verdict.choice[b.id] ?? 0) - (verdict.choice[a.id] ?? 0));
          const next: Path[] = ranked.slice(0, inBand ? 1 : MAX_PATHS).map((candidate) => ({
            nodes: [...path.nodes, candidate],
            logSum: path.logSum + (candidates.length > 1 ? Math.log(Math.max(verdict.choice[candidate.id] ?? 0, PROBABILITY_FLOOR)) : 0),
            decisions: path.decisions + (candidates.length > 1 ? 1 : 0),
            done: false,
            stop: null,
            why: null,
            bands: inBand ? [...path.bands, path.nodes.length] : path.bands,
          }));
          // Na faixa do meio, "parar aqui" continua como hipótese ao lado de descer no mais provável.
          return inBand ? [{ ...path, done: true, why: "band", bands: [...path.bands, path.nodes.length] }, ...next] : next;
        }),
    );

    paths = [...kept, ...expansions.flat()].sort((a, b) => score(b) - score(a)).slice(0, MAX_PATHS);

    const followed = new Set(paths.map((p) => `${p.nodes[level - 2 + base]?.id ?? "root"}>${p.nodes[level - 1 + base]?.id}`));
    const seen = new Set<string>();
    for (const { parentId, candidate } of offered) {
      if (followed.has(`${parentId ?? "root"}>${candidate.id}`) || seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      discarded.push({ level, parentId, ticketId: candidate.id, title: candidate.title });
    }
  }

  const ordered = paths.sort((a, b) => score(b) - score(a));
  const [top, second] = ordered as [Path, ...Path[]];
  const open = ordered.find((p) => !p.done);
  const stoppedEarly =
    top.stop ?? (top === open ? { reason: "max_levels" as const, level: maxLevels, parentId: tip(top)?.id ?? null } : null);
  const idsOf = (path: Path): string[] => [...ancestors.map((a) => a.id), ...path.nodes.map((n) => n.id)];
  const alternativePaths = ordered.slice(1, 1 + MAX_ALTERNATIVES);
  steps.sort((a, b) => a.level - b.level || String(a.parentId).localeCompare(String(b.parentId)));
  return {
    destination: target(top, ancestors),
    alternatives: alternativePaths.map((path) => target(path, ancestors)),
    discarded,
    uncertain: second !== undefined && (score(top) / score(second) < UNCERTAIN_RATIO || isBandPair(top, second)),
    stoppedEarly,
    scope: scope && !start ? { id: scope.node.id, title: scope.node.title, outOfScope: scopeFit !== null && scopeFit < BELONGS_LOW, fit: scopeFit } : null,
    trace: {
      steps,
      chosen: idsOf(top),
      alternatives: alternativePaths.map(idsOf),
      stop: stoppedEarly?.reason ?? top.why,
      scope: scope && !start ? { id: scope.node.id, fit: scopeFit } : null,
    },
  };
}

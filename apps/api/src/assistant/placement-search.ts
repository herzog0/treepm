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

export type PlacementDeps = {
  judge: BranchJudge;
  /** Ramos candidatos (filhos que têm filhos, já com resumo) de um nó; `null` é a raiz do projeto. */
  candidates(parentId: string | null): Promise<readonly BranchCandidate[]>;
  /** A requisição cabe no limite de tokens do juiz? Se não, a procura para naquele nível. */
  fits(input: JudgeInput): boolean;
  timeoutMs?: number;
};

export type PlacementTarget = { parentId: string | null; path: { id: string; title: string }[] };

export type PlacementOutcome = {
  destination: PlacementTarget;
  alternatives: PlacementTarget[];
  /** Ramos oferecidos em algum nível e não seguidos pelos caminhos mantidos. */
  discarded: { level: number; parentId: string | null; ticketId: string; title: string }[];
  uncertain: boolean;
  stoppedEarly: { reason: "candidates_too_large" | "max_levels"; level: number; parentId: string | null } | null;
};

type Path = {
  nodes: BranchCandidate[];
  logSum: number;
  decisions: number;
  done: boolean;
  stop: PlacementOutcome["stoppedEarly"];
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
const target = (path: Path): PlacementTarget => ({
  parentId: tip(path)?.id ?? null,
  path: path.nodes.map(({ id, title }) => ({ id, title })),
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
  let paths: Path[] = [{ nodes: [], logSum: 0, decisions: 0, done: false, stop: null, bands: [] }];
  const discarded: PlacementOutcome["discarded"] = [];

  for (let level = 1; level <= MAX_LEVELS && paths.some((p) => !p.done); level++) {
    const kept: Path[] = paths.filter((p) => p.done);
    const offered: { parentId: string | null; candidate: BranchCandidate }[] = [];

    const expansions = await Promise.all(
      paths
        .filter((p) => !p.done)
        .map(async (path): Promise<Path[]> => {
          const current = tip(path);
          const parentId = current?.id ?? null;
          const candidates = await deps.candidates(parentId);
          if (candidates.length === 0) return [{ ...path, done: true }];
          const input: JudgeInput = {
            draft,
            current: current ? { title: current.title, summary: current.summary } : null,
            candidates,
          };
          if (!deps.fits(input)) {
            return [{ ...path, done: true, stop: { reason: "candidates_too_large", level, parentId } }];
          }
          const verdict = await deps.judge.judge(input, { signal });
          for (const candidate of candidates) offered.push({ parentId, candidate });
          if (verdict.belongs < BELONGS_LOW) return [{ ...path, done: true }];

          const ranked = [...candidates].sort((a, b) => (verdict.choice[b.id] ?? 0) - (verdict.choice[a.id] ?? 0));
          const inBand = verdict.belongs <= BELONGS_HIGH;
          const next: Path[] = ranked.slice(0, inBand ? 1 : MAX_PATHS).map((candidate) => ({
            nodes: [...path.nodes, candidate],
            logSum: path.logSum + (candidates.length > 1 ? Math.log(Math.max(verdict.choice[candidate.id] ?? 0, PROBABILITY_FLOOR)) : 0),
            decisions: path.decisions + (candidates.length > 1 ? 1 : 0),
            done: false,
            stop: null,
            bands: inBand ? [...path.bands, path.nodes.length] : path.bands,
          }));
          // Na faixa do meio, "parar aqui" continua como hipótese ao lado de descer no mais provável.
          return inBand ? [{ ...path, done: true, bands: [...path.bands, path.nodes.length] }, ...next] : next;
        }),
    );

    paths = [...kept, ...expansions.flat()].sort((a, b) => score(b) - score(a)).slice(0, MAX_PATHS);

    const followed = new Set(paths.map((p) => `${p.nodes[level - 2]?.id ?? "root"}>${p.nodes[level - 1]?.id}`));
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
    top.stop ?? (top === open ? { reason: "max_levels" as const, level: MAX_LEVELS, parentId: tip(top)?.id ?? null } : null);
  return {
    destination: target(top),
    alternatives: ordered.slice(1, 1 + MAX_ALTERNATIVES).map(target),
    discarded,
    uncertain: second !== undefined && (score(top) / score(second) < UNCERTAIN_RATIO || isBandPair(top, second)),
    stoppedEarly,
  };
}
